/**
 * Syncer - 核心同步引擎
 *
 * 算法:镜像同步 (target 应始终等于 source)
 *   1. 扫描源 → newSource
 *   2. 扫描目标 → newTarget
 *   3. 对比两个 map:
 *      - 在 source 不在 target → ADD
 *      - 在两边但 mtime/size 不同 → MODIFY(覆盖)
 *      - 在 target 不在 source → DELETE
 *   4. 加载上次源索引,标记"真正新增"(newSource - lastIndex)用于日志
 *   5. 应用文件映射规则(从本地文件拷贝到 target 指定位置)
 *
 * 设计要点:
 * - 一次同步是事务性的:中途失败时,目标处于"半同步"状态,可由 backup 回退
 * - 文件拷贝后保留源 mtime,避免下一轮被误判为 modified
 * - 目标里的空目录不主动清理(避免误删用户数据)
 * - 源目录不存在/不可读 = fatal error,不写空 target
 */

import { promises as fs } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { Indexer, type ScanResult } from './indexer.js';
import { Backupper } from './backupper.js';
import { coreLog } from './logger.js';
import { deriveDefaultBackupDir, type AppConfig, type FileEntry, type FileMapping, type SyncResult } from './types.js';

function normalize(rel: string): string {
  return rel.split(sep).join('/');
}

function ensureRel(rel: string): string {
  // 拒绝绝对路径与 .. 逃逸
  if (rel.includes('..')) {
    throw new Error(`非法相对路径(包含 ..): ${rel}`);
  }
  if (sep !== '/' && rel.includes(sep)) {
    return normalize(rel);
  }
  return rel;
}

/**
 * 把映射规则的 targetRelpath 解析成实际写到 target 的相对路径。
 *
 * 重要:这个 helper 是豁免集(mirroredTargetPaths)和实际写盘路径的
 * 唯一真相源。两边必须用同一个结果,否则映射注入的文件会被镜像
 * 删除阶段误判为孤儿(−1)。
 *
 * 规则:
 * - 空串 / 以 / 结尾 → 用 sourcePath 的 basename 补全
 * - 否则原样(经 ensureRel 校验)
 *
 * @returns 解析后的 relPath,失败返回 null(配置非法)
 */
function resolveMappingRelPath(m: FileMapping): string | null {
  try {
    let rel = ensureRel(m.targetRelpath);
    if (rel === '' || rel.endsWith('/') || rel.endsWith(sep)) {
      const baseName = m.sourcePath.split(/[\\/]/).pop() ?? '';
      if (!baseName) return null;
      rel = rel === '' ? baseName : `${rel}${baseName}`;
    }
    return rel;
  } catch {
    return null;
  }
}

export class Syncer {
  private readonly indexer: Indexer;
  private readonly config: AppConfig;

  constructor(config: AppConfig) {
    this.config = config;
    this.indexer = new Indexer({ hashOnConflict: false });
  }

  /**
   * 仅执行文件映射,不做镜像同步。
   * 用于:用户保存映射规则后立即应用一次,无需等下一个 sync 周期。
   *
   * 区别于 sync():
   * - 不扫源/目标(快)
   * - 不创建快照
   * - 不写历史(由调用方决定要不要记)
   * - 强制 dryRun=false
   */
  async applyMappingsOnly(): Promise<SyncResult> {
    const startedAt = Date.now();
    const result: SyncResult = {
      startedAt,
      durationMs: 0,
      ok: false,
      added: [],
      modified: [],
      deleted: [],
      mappingCopied: [],
      mappingSkippedExisting: [],
      mappingSkipped: [],
      unchanged: 0,
      warnings: [],
      backupCreated: false,
    };

    const { targetDir, fileMappings } = this.config;
    if (!targetDir) {
      result.fatalError = '目标目录未配置';
      result.durationMs = Date.now() - startedAt;
      return result;
    }

    // 确保 target 存在
    try {
      await fs.mkdir(targetDir, { recursive: true });
    } catch (err) {
      result.fatalError = `无法创建目标目录: ${(err as Error).message}`;
      result.durationMs = Date.now() - startedAt;
      return result;
    }

    // 浅扫描 target 算 targetMap(只为了"目标是否存在"判断)
    const targetScan = await this.indexer.scan(targetDir);
    const targetMap = new Map<string, FileEntry>();
    for (const f of targetScan.files) targetMap.set(f.relPath, f);

    for (const mapping of fileMappings) {
      if (!mapping.enabled) continue;
      await this.applyMapping(mapping, targetMap, result, false);
    }

    result.ok = !result.fatalError;
    result.durationMs = Date.now() - startedAt;
    return result;
  }

  /**
   * 执行一次同步
   * @param lastSourceIndex 上次扫描的源索引(可为 null,首次运行)
   * @param options.dryRun true = 只扫描 + 计算 diff,不实际拷贝/删除/备份
   *   (用于"弹窗询问"模式:先看变化,用户决定后再实际同步)
   */
  async sync(
    lastSourceIndex: FileEntry[] | null,
    options: { dryRun?: boolean } = {},
  ): Promise<{
    result: SyncResult;
    newSourceIndex: FileEntry[];
  }> {
    const dryRun = options.dryRun ?? false;
    const startedAt = Date.now();
    const result: SyncResult = {
      startedAt,
      durationMs: 0,
      ok: false,
      added: [],
      modified: [],
      deleted: [],
      mappingCopied: [],
      mappingSkippedExisting: [],
      mappingSkipped: [],
      unchanged: 0,
      warnings: [],
      backupCreated: false,
    };

    const { sourceDir, targetDir, fileMappings } = this.config;
    if (!sourceDir || !targetDir) {
      result.fatalError = '源目录或目标目录未配置';
      result.durationMs = Date.now() - startedAt;
      return { result, newSourceIndex: [] };
    }

    // 1. 扫描源
    const sourceScan: ScanResult = await this.indexer.scan(sourceDir);
    if (sourceScan.fatal) {
      result.fatalError = `源目录不可访问: ${sourceDir}(可能未挂载或不存在)`;
      result.warnings.push(...sourceScan.warnings);
      result.durationMs = Date.now() - startedAt;
      return { result, newSourceIndex: [] };
    }
    result.warnings.push(...sourceScan.warnings);

    // 2. 扫描目标
    const targetScan: ScanResult = await this.indexer.scan(targetDir);
    // 目标不存在不算 fatal,直接当作空
    if (targetScan.fatal) {
      // 目标目录不存在,创建它
      try {
        await fs.mkdir(targetDir, { recursive: true });
      } catch (err) {
        result.fatalError = `无法创建目标目录: ${targetDir} (${(err as Error).message})`;
        result.durationMs = Date.now() - startedAt;
        return { result, newSourceIndex: [] };
      }
    }
    result.warnings.push(...targetScan.warnings);

    // 3. 构建 map
    const sourceMap = new Map<string, FileEntry>();
    for (const f of sourceScan.files) sourceMap.set(f.relPath, f);

    const targetMap = new Map<string, FileEntry>();
    for (const f of targetScan.files) targetMap.set(f.relPath, f);

    const lastIndexMap = new Map<string, FileEntry>();
    if (lastSourceIndex) {
      for (const f of lastSourceIndex) lastIndexMap.set(f.relPath, f);
    }

    // 3.5 收集启用映射的目标路径,镜像删除时跳过这些
    // 必须用 resolveMappingRelPath(解析后的实际路径),不能用原始 targetRelpath,
    // 否则 targetRelpath="" 或 "sub/" 这类规则,映射注入的文件会被误算为删除
    const mappedTargetPaths = new Set<string>();
    for (const m of fileMappings) {
      if (!m.enabled) continue;
      const resolved = resolveMappingRelPath(m);
      if (resolved) mappedTargetPaths.add(resolved);
    }

    // 3.6 先预算本次会改/删/加哪些文件(不实际执行)
    //    有任一变化就建备份(只为了"无变化"场景省空间)
    const plannedModified: string[] = [];
    const plannedDeleted: string[] = [];
    const plannedAdded: string[] = [];

    for (const [rel, sFile] of sourceMap) {
      const tFile = targetMap.get(rel);
      if (!tFile) {
        plannedAdded.push(rel);
      } else if (
        tFile.size !== sFile.size ||
        Math.abs(tFile.mtimeMs - sFile.mtimeMs) > 2
      ) {
        plannedModified.push(rel);
      }
    }
    for (const [rel] of targetMap) {
      if (sourceMap.has(rel)) continue;
      if (mappedTargetPaths.has(normalize(rel))) continue;
      plannedDeleted.push(rel);
    }

    // 3.7 创建快照(任一变化都触发:增/改/删)— dryRun 时跳过
    if (
      !dryRun &&
      (plannedModified.length > 0 || plannedDeleted.length > 0 || plannedAdded.length > 0)
    ) {
      try {
        const backupper = new Backupper();
        const snap = await backupper.createSnapshot(targetDir, this.config.backupDir || undefined);
        result.backupSnapshotPath = snap.path;
        result.backupCreated = true;
        // 轮转:保留 N 个(从 config 读)
        const keepN = this.config.backupCount;
        if (keepN > 0) {
          const backupperDir = this.config.backupDir || deriveDefaultBackupDir(targetDir);
          const rotated = await backupper.rotate(backupperDir, keepN);
          if (rotated.length > 0) {
            result.warnings.push(`已轮转,删除 ${rotated.length} 个旧快照`);
          }
        }
      } catch (err) {
        result.warnings.push(`快照创建失败(继续同步): ${(err as Error).message}`);
      }
    } else if (dryRun && (plannedModified.length > 0 || plannedDeleted.length > 0 || plannedAdded.length > 0)) {
      // dryRun 也记录"将要备份"的信息,便于 UI 提示用户
      result.warnings.push('(dryRun 模式,实际未创建快照)');
    }

    // 4. ADD / MODIFY / UNCHANGED
    for (const [rel, sFile] of sourceMap) {
      const tFile = targetMap.get(rel);
      const isNew = !lastIndexMap.has(rel);
      const needsCopy = !tFile
        || tFile.size !== sFile.size
        || Math.abs(tFile.mtimeMs - sFile.mtimeMs) > 2; // 2ms 抖动容忍

      if (needsCopy) {
        // dryRun 时只记录,不实际拷贝
        if (isNew) result.added.push(rel);
        else result.modified.push(rel);
        if (!dryRun) {
          try {
            await this.copyFile(sourceDir, targetDir, sFile);
          } catch (err) {
            result.warnings.push(`拷贝失败: ${rel} (${(err as Error).message})`);
          }
        }
      } else {
        result.unchanged++;
      }
    }

    // 5. DELETE (镜像模式,但映射目标路径豁免)
    for (const [rel] of targetMap) {
      if (sourceMap.has(rel)) continue; // 源里有,肯定不删
      if (mappedTargetPaths.has(normalize(rel))) continue; // 映射目标,豁免
      // dryRun 也记录将要删除
      result.deleted.push(rel);
      if (!dryRun) {
        try {
          const targetPath = join(targetDir, rel);
          await fs.unlink(targetPath);
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code !== 'ENOENT') {
            result.warnings.push(`删除失败: ${rel} (${(err as Error).message})`);
          }
        }
      }
    }

    // 6. 文件映射
    // 注意:映射不参与 dryRun — 因为映射是用户主动配的"始终保持"规则,
    // 不是被检测出来的"源变化"。即便弹窗模式开启,映射也应该立即生效。
    for (const mapping of fileMappings) {
      if (!mapping.enabled) continue;
      await this.applyMapping(mapping, targetMap, result, false);
    }

    result.ok = !result.fatalError;
    result.durationMs = Date.now() - startedAt;
    return { result, newSourceIndex: sourceScan.files };
  }

  private async copyFile(sourceDir: string, targetDir: string, file: FileEntry): Promise<void> {
    const src = join(sourceDir, file.relPath);
    const dst = join(targetDir, file.relPath);
    await fs.mkdir(dirname(dst), { recursive: true });
    await fs.copyFile(src, dst);
    // 保留 mtime,避免下一轮被误判
    await fs.utimes(dst, new Date(file.mtimeMs), new Date(file.mtimeMs));
  }

  private async applyMapping(
    mapping: FileMapping,
    targetMap: Map<string, FileEntry>,
    result: SyncResult,
    dryRun = false,
  ): Promise<void> {
    const relPath = resolveMappingRelPath(mapping);
    if (!relPath) {
      result.warnings.push(`映射规则非法: ${mapping.name} (无法解析 targetRelpath)`);
      return;
    }

    const targetPath = join(this.config.targetDir, relPath);
    const targetExists = targetMap.has(relPath);

    coreLog.info(
      `[mapping] ${mapping.name}: src=${mapping.sourcePath} → ${targetPath} ` +
      `| overwrite=${mapping.overwrite} targetExists=${targetExists} dryRun=${dryRun}`,
    );

    // 1. 目标已存在 + overwrite=false → 跳过(用户已有了,不动)
    if (targetExists && !mapping.overwrite) {
      coreLog.info(`[mapping] ${mapping.name}: 目标已存在 + overwrite=false → skip`);
      result.mappingSkippedExisting.push(mapping.name);
      return;
    }

    // 2. 检查源文件是否存在
    let sourceExists = false;
    try {
      const st = await fs.stat(mapping.sourcePath);
      sourceExists = st.isFile();
      coreLog.info(`[mapping] ${mapping.name}: stat sourcePath ok, isFile=${st.isFile()} isDir=${st.isDirectory()}`);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      coreLog.info(`[mapping] ${mapping.name}: stat sourcePath 失败 (code=${code}): ${(err as Error).message}`);
      if (code !== 'ENOENT') {
        result.warnings.push(
          `映射源文件 stat 失败: ${mapping.name} (${(err as Error).message})`,
        );
      }
    }

    if (!sourceExists) {
      coreLog.info(`[mapping] ${mapping.name}: 源文件不存在,策略=${mapping.ifSourceMissing}`);
      // 源文件不存在
      switch (mapping.ifSourceMissing) {
        case 'skip':
          result.mappingSkipped.push(mapping.name);
          return;
        case 'keep':
          return;
        case 'delete':
          if (targetExists) {
            result.deleted.push(relPath);
            if (!dryRun) {
              try {
                await fs.unlink(targetPath);
              } catch (err) {
                result.warnings.push(
                  `映射删除失败: ${mapping.name} (${(err as Error).message})`,
                );
              }
            }
          }
          return;
      }
    }

    // 3. 源存在 → 拷贝(dryRun 只记录)
    result.mappingCopied.push(mapping.name);
    if (!dryRun) {
      try {
        await fs.mkdir(dirname(targetPath), { recursive: true });
        await fs.copyFile(mapping.sourcePath, targetPath);
        await fs.utimes(targetPath, new Date(), new Date());
        coreLog.info(`[mapping] ${mapping.name}: 已拷贝到 ${targetPath}`);
      } catch (err) {
        coreLog.error(`[mapping] ${mapping.name}: 拷贝失败 ${(err as Error).message}`);
        result.warnings.push(
          `映射拷贝失败: ${mapping.name} (${(err as Error).message})`,
        );
      }
    } else {
      coreLog.info(`[mapping] ${mapping.name}: dryRun 跳过实际拷贝`);
    }
  }
}
