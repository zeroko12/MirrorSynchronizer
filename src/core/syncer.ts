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
import { deriveDefaultBackupDir, deriveDefaultStagingDir, isInIgnoredItem, type AppConfig, type FileEntry, type FileMapping, type SyncResult } from './types.js';
import {
  classifyErrno,
  classifyFetchError,
  classifyHttpStatus,
  formatFatalMessage,
  isNetworkReason,
  type PathErrorKind,
} from './errors.js';
import { pickAdapter, streamToFile, isRemotePath, type SourceAdapter } from './adapter.js';
import { MTIME_JITTER_TOLERANCE_MS } from './constants.js';

/** 致命错误时是否应中断后续步骤(网络类) */
function shouldAbortOnError(reason: PathErrorKind | null | undefined): boolean {
  return isNetworkReason(reason);
}

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
 * 把 ignoreItems 规范化为匹配数组。
 * - 统一用正斜杠、去头尾空白/斜杠
 * - 拒绝空、`.`、`..`、含 `:`(避免绝对路径)
 * - 去重(规范化后等价视为同一条)
 * 返回空数组 = 不忽略任何东西。
 */
export function buildIgnoreItems(ignoreItems: string[] | undefined): string[] {
  if (!ignoreItems || ignoreItems.length === 0) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of ignoreItems) {
    if (typeof raw !== 'string') continue;
    const normalized = raw.trim().replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
    if (!normalized || normalized === '.' || normalized.includes('..') || normalized.includes(':')) {
      continue;
    }
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

/**
 * 判断 relPath 是否被 ignoreItems 任何一项命中。
 * @deprecated 实现已搬到 ./types.js,这里保留空函数占位防止旧代码引用
 * 真正实现见 types.js 中的 isInIgnoredItem
 */
// 已移到 types.js,旧引用点(swappera/backup)改 import types.js
// 这里保留注释便于历史 grep

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
      result.fatalReason = 'not-found';
      result.fatalTarget = 'config';
      result.durationMs = Date.now() - startedAt;
      return result;
    }

    // 确保 target 存在
    try {
      await fs.mkdir(targetDir, { recursive: true });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      const reason = classifyErrno(code, targetDir);
      result.fatalReason = reason;
      result.fatalTarget = 'target';
      result.fatalError = formatFatalMessage(reason, 'target', targetDir) +
        ` (${(err as Error).message})`;
      result.durationMs = Date.now() - startedAt;
      return result;
    }

    // 浅扫描 target 算 targetMap(只为了"目标是否存在"判断)
    const targetScan = await this.indexer.scan(targetDir);
    const targetMap = new Map<string, FileEntry>();
    for (const f of targetScan.files) targetMap.set(f.relPath, f);

    // staging 模式下,映射写到 stagingDir(跟 sync() 一致,避开目标文件锁),
    // 等下次 swap 后再落 target。immediate 模式直接写 target。
    const writeDir = this.config.applyMode === 'staging'
      ? (this.config.stagingDir || deriveDefaultStagingDir(targetDir))
      : targetDir;

    for (const mapping of fileMappings) {
      if (!mapping.enabled) continue;
      await this.applyMapping(mapping, targetMap, result, false, writeDir);
    }

    // staging 模式 + 真写了 staging 文件 → 写 .pending-apply 标记
    // 让 swap 阶段(hasPendingApply)知道有内容待 swap,否则内容卡在 staging
    if (writeDir !== targetDir && result.mappingCopied.length > 0) {
      try {
        await fs.writeFile(join(writeDir, '.pending-apply'), '');
      } catch (err) {
        result.warnings.push(`写 .pending-apply 标记失败: ${(err as Error).message}`);
      }
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
      result.fatalReason = 'not-found';
      result.fatalTarget = 'config';
      result.durationMs = Date.now() - startedAt;
      return { result, newSourceIndex: [] };
    }

    // 0. 规范化 ignoreItems(空数组 = 不过滤任何东西)
    const ignoreItems = buildIgnoreItems(this.config.ignoreItems);

    // 0.5 计算写入目录:staging 模式下写到 stagingDir(避开文件锁),
    //     immediate 模式下直接写 targetDir。
    //     扫描仍扫 targetDir(diff 的真相源 = 目标当前状态)。
    const writeDir = this.config.applyMode === 'staging'
      ? (this.config.stagingDir || deriveDefaultStagingDir(targetDir))
      : targetDir;

    // 1. 扫描源(通过 SourceAdapter — 自动选 FsAdapter 或 HttpAdapter)
    const adapter = pickAdapter(sourceDir);
    let sourceFilesAll: FileEntry[] = [];
    try {
      sourceFilesAll = await adapter.scan();
    } catch (err) {
      const fatalOutcome = this.classifyAdapterError(err, sourceDir);
      result.fatalReason = fatalOutcome.reason;
      result.fatalTarget = 'source';
      result.fatalError = formatFatalMessage(fatalOutcome.reason, 'source', sourceDir);
      if (fatalOutcome.warnings) result.warnings.push(...fatalOutcome.warnings);
      result.durationMs = Date.now() - startedAt;
      // 出错时关闭 adapter 资源(keep-alive 等)
      await adapter.close().catch(() => undefined);
      return { result, newSourceIndex: [] };
    }
    // 过滤 ignoreItems(在扫描结果上做 — 不污染 lastIndexMap,因为 lastIndex
    // 里的 ignore 条目在下次同步时被同样的 prefix 过滤掉,语义一致)
    const sourceFiles = ignoreItems.length
      ? sourceFilesAll.filter((f) => !isInIgnoredItem(f.relPath, ignoreItems))
      : sourceFilesAll;

    // 2. 扫描目标(始终是本地)

    // 2. 扫描目标
    const targetScan: ScanResult = await this.indexer.scan(targetDir);
    // 目标不存在不算 fatal,直接当作空
    if (targetScan.fatal) {
      // 目标目录不存在,创建它
      try {
        await fs.mkdir(targetDir, { recursive: true });
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        const reason = classifyErrno(code, targetDir);
        result.fatalReason = reason;
        result.fatalTarget = 'target';
        result.fatalError = formatFatalMessage(reason, 'target', targetDir) +
          ` (${(err as Error).message})`;
        result.durationMs = Date.now() - startedAt;
        await adapter.close().catch(() => undefined);
        return { result, newSourceIndex: [] };
      }
    }
    result.warnings.push(...targetScan.warnings);
    // 过滤 ignoreItems
    const targetFiles = ignoreItems.length
      ? targetScan.files.filter((f) => !isInIgnoredItem(f.relPath, ignoreItems))
      : targetScan.files;

    // 3. 构建 map
    const sourceMap = new Map<string, FileEntry>();
    for (const f of sourceFiles) sourceMap.set(f.relPath, f);

    const targetMap = new Map<string, FileEntry>();
    for (const f of targetFiles) targetMap.set(f.relPath, f);

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

    // 3.5b 镜像删除豁免集 = 映射目标 ∪ ignoreItems(忽略目录里的"孤儿"也不该被镜像删)
    const exemptFromMirrorDelete = new Set<string>([...mappedTargetPaths, ...ignoreItems]);

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
        Math.abs(tFile.mtimeMs - sFile.mtimeMs) > MTIME_JITTER_TOLERANCE_MS
      ) {
        plannedModified.push(rel);
      }
    }
    for (const [rel] of targetMap) {
      if (sourceMap.has(rel)) continue;
      if (exemptFromMirrorDelete.has(normalize(rel))) continue;
      plannedDeleted.push(rel);
    }

    // 3.7 创建快照(任一变化都触发:增/改/删)— dryRun 时跳过
    // staging 模式下不创建 backup:backup 跟 swap 绑定,在 swap 模块里做
    // (swap 时创建 backup 是 swap-前的状态,sync 阶段的 backup 浪费空间)
    if (
      !dryRun &&
      writeDir === targetDir &&
      (plannedModified.length > 0 || plannedDeleted.length > 0 || plannedAdded.length > 0)
    ) {
      try {
        const backupper = new Backupper();
        const snap = await backupper.createSnapshot(targetDir, this.config.backupDir || undefined, {
          ignoreItems: this.config.ignoreItems,
        });
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

    // 3.8 staging 模式:确保 stagingDir 存在(首次 sync 时)
    if (!dryRun && writeDir !== targetDir) {
      try {
        await fs.mkdir(writeDir, { recursive: true });
      } catch (err) {
        result.warnings.push(`创建 staging 目录失败: ${(err as Error).message}`);
      }
    }

    // 4. ADD / MODIFY / UNCHANGED
    let pendingWrittenCount = 0; // staging 模式下写入 staging 的文件数
    for (const [rel, sFile] of sourceMap) {
      const tFile = targetMap.get(rel);
      const isNew = !lastIndexMap.has(rel);
      const needsCopy = !tFile
        || tFile.size !== sFile.size
        || Math.abs(tFile.mtimeMs - sFile.mtimeMs) > MTIME_JITTER_TOLERANCE_MS;

      if (needsCopy) {
        // dryRun 时只记录,不实际拷贝
        if (isNew) result.added.push(rel);
        else result.modified.push(rel);
        if (!dryRun) {
          try {
            await this.copyFromAdapter(adapter, writeDir, sFile);
            if (writeDir !== targetDir) pendingWrittenCount++;
          } catch (err) {
            const outcome = this.classifyAdapterError(err, sourceDir);
            if (shouldAbortOnError(outcome.reason)) {
              // 网络类错误:中止本轮,避免 partial sync 让索引错位
              result.fatalReason = outcome.reason;
              result.fatalTarget = 'source';
              result.fatalError = `同步中断(${rel}): ${formatFatalMessage(outcome.reason, 'source', sourceDir)}`;
              coreLog.error(`[sync] 网络类错误中断: ${rel} (${outcome.reason})`);
              result.warnings.push(...result.modified.slice().map((m) => `未完成: ${m}`));
              result.warnings.push(...result.added.slice().map((m) => `未完成: ${m}`));
              result.modified = result.modified.filter((m) => result.added.includes(m) ? false : true);
              // 简化:已记录的需要回滚,这里不主动回滚 — backup 快照是兜底
              break;
            }
            // 非致命:warning 继续
            result.warnings.push(`拷贝失败: ${rel} (${outcome.reason ?? (err as Error).message})`);
            // ★ 标记目标可执行文件被锁(immediate 模式 Layer 2 兜底)
            if (rel === this.config.executablePath) {
              result.executableUpdate = 'blocked';
            }
          }
        }
      } else {
        result.unchanged++;
      }
    }

    // 4.1 staging 模式:写完标记 .pending-apply(让 swap 知道有内容)
    if (!dryRun && writeDir !== targetDir && pendingWrittenCount > 0) {
      try {
        await fs.writeFile(join(writeDir, '.pending-apply'), '');
      } catch (err) {
        result.warnings.push(`写 .pending-apply 标记失败: ${(err as Error).message}`);
      }
      result.pendingApplyCount = pendingWrittenCount;
    }

    // 5. DELETE (镜像模式,但映射目标路径 + ignoreItems 豁免)
    //
    // staging 模式行为修正:
    //   之前 `unlink(writeDir/rel)` 永远 ENOENT(目标文件本不在 staging 里),
    //   被 `if (ENOENT) continue` 吞掉 → target 文件永远不删。
    //   用户体验:"检测到 -1 但点同步后 target 没删"。
    // 现在:staging 模式把待删 rel 收集成列表,写到 stagingDir/.pending-delete.json,
    //   swap 时再尝试从 target 删(用了现有 transient 重试 + 锁感知)。
    //   immediate 模式不变:target.unlink 直接跑。
    const pendingDeleteRels: string[] = [];
    for (const [rel] of targetMap) {
      if (sourceMap.has(rel)) continue; // 源里有,肯定不删
      if (exemptFromMirrorDelete.has(normalize(rel))) continue; // 映射目标 / 忽略目录,豁免
      // 无论 dryRun 还是 real 都记录 — 用户能看到 "-1 删除"
      result.deleted.push(rel);
      if (dryRun) continue;

      if (writeDir !== targetDir) {
        // staging 模式:留给 swap 处理(target 文件锁着时也不能直接删)
        pendingDeleteRels.push(rel);
      } else {
        // immediate 模式:直接删 target
        try {
          await fs.unlink(join(targetDir, rel));
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code === 'ENOENT') continue; // 已不存在,跳过
          const reason = classifyErrno(code, join(targetDir, rel));
          if (shouldAbortOnError(reason)) {
            result.fatalReason = reason;
            result.fatalTarget = 'target';
            result.fatalError = `删除中断(${rel}): ${formatFatalMessage(reason, 'target', targetDir)}`;
            coreLog.error(`[sync] 删除时网络错误: ${rel} (${reason})`);
            break;
          }
          result.warnings.push(`删除失败: ${rel} (${reason ?? (err as Error).message})`);
        }
      }
    }

    // 5.1 staging 模式:把待删列表写到 stagingDir/.pending-delete.json(swap 时读)
    //
    // 不管是 dryRun 还是 real 都"读"这个 marker(swap 时),只有 real sync 才写。
    // 用户点 立即应用 触发 force sync 之前已有 dryRun period sync — dryRun 不写,
    // 第一次 force sync 才生效,结果对了:staging 待删会被 swap 应用。
    //
    // 没东西要删时清掉旧 marker(否则上次 sync 留下的列表会被 swap 二次处理)。
    if (!dryRun && writeDir !== targetDir) {
      const markerPath = join(writeDir, '.pending-delete.json');
      if (pendingDeleteRels.length > 0) {
        try {
          await fs.writeFile(
            markerPath,
            JSON.stringify(
              {
                rels: [...pendingDeleteRels].sort(),
                writtenAt: Date.now(),
              },
              null,
              2,
            ),
          );
        } catch (err) {
          result.warnings.push(`写 .pending-delete.json 失败: ${(err as Error).message}`);
        }
      } else {
        await fs.unlink(markerPath).catch(() => undefined);
      }
    }

    // 6. 文件映射
    // 注意:映射不参与 dryRun — 因为映射是用户主动配的"始终保持"规则,
    // 不是被检测出来的"源变化"。即便弹窗模式开启,映射也应该立即生效。
    // staging 模式下:映射写入也走 stagingDir(避开文件锁)
    for (const mapping of fileMappings) {
      if (!mapping.enabled) continue;
      await this.applyMapping(mapping, targetMap, result, false, writeDir);
    }

    result.ok = !result.fatalError;
    result.durationMs = Date.now() - startedAt;
    // 关闭 adapter 资源(keep-alive agent 等)
    await adapter.close().catch(() => undefined);
    return { result, newSourceIndex: sourceFiles };
  }

  /**
   * 把文件从 adapter 流式拷贝到目标路径
   * 替换原 copyFile,统一走 SourceAdapter 抽象:
   * - FsAdapter 内部走 createReadStream
   * - HttpAdapter 内部走 fetch().body
   */
  private async copyFromAdapter(
    adapter: SourceAdapter,
    targetDir: string,
    file: FileEntry,
  ): Promise<void> {
    const dst = join(targetDir, file.relPath);
    const stream = await adapter.open(file.relPath);
    await streamToFile(stream, dst, file.mtimeMs);
  }

  /**
   * 把 adapter 抛出的错误归类到 PathErrorKind
   * - FsAdapter fatal:err.scanResult.fatalReason
   * - HttpAdapter:从 "HTTP NNN" 消息提取状态码,或从 errno 分类
   */
  private classifyAdapterError(
    err: unknown,
    sourceDir: string,
  ): { reason: PathErrorKind; warnings?: string[] } {
    // FsAdapter 风格:挂载了 scanResult
    const scanResult = (err as { scanResult?: ScanResult }).scanResult;
    if (scanResult && scanResult.fatal) {
      return { reason: scanResult.fatalReason ?? 'unknown', warnings: scanResult.warnings };
    }
    // HttpAdapter 风格:从消息里解析 HTTP 状态码
    const msg = (err as Error)?.message ?? '';
    const statusMatch = /HTTP\s+(\d{3})/.exec(msg);
    if (statusMatch) {
      return { reason: classifyHttpStatus(Number(statusMatch[1])) };
    }
    // 通用 fetch / fs 错误
    const fetchReason = classifyFetchError(err);
    if (fetchReason !== 'unknown') {
      return { reason: fetchReason };
    }
    // 兜底:按 fs errno 再试一次(可能是 FsAdapter 在非 fatal 路径抛错)
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code) {
      return { reason: classifyErrno(code, sourceDir) };
    }
    return { reason: 'unknown' };
  }

  private async applyMapping(
    mapping: FileMapping,
    targetMap: Map<string, FileEntry>,
    result: SyncResult,
    dryRun = false,
    overrideWriteDir?: string, // staging 模式下 = stagingDir;不传 = targetDir
  ): Promise<void> {
    const relPath = resolveMappingRelPath(mapping);
    if (!relPath) {
      result.warnings.push(`映射规则非法: ${mapping.name} (无法解析 targetRelpath)`);
      return;
    }

    // 0. 目标在 ignoreItems 里 → 整体跳过(不拷贝、不计 mappingCopied / skippedExisting)
    const ignoreItems = buildIgnoreItems(this.config.ignoreItems);
    if (isInIgnoredItem(relPath, ignoreItems)) {
      coreLog.info(`[mapping] ${mapping.name}: 目标在忽略目录 ${relPath} → skip`);
      result.mappingSkipped.push(mapping.name);
      return;
    }

    const writeDir = overrideWriteDir ?? this.config.targetDir;
    const targetPath = join(writeDir, relPath);
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
    let sourceSize = 0;
    if (isRemotePath(mapping.sourcePath)) {
      // 远程源:走 SourceAdapter(支持 http/https/webdav)
      try {
        const adapter = pickAdapter(mapping.sourcePath);
        // 拿 HEAD / 0字节流检查存在性 + size
        const normalized = mapping.sourcePath.replace(/^webdav:/i, 'https:');
        const head = await fetch(normalized, { method: 'HEAD' });
        if (head.ok) {
          sourceExists = true;
          sourceSize = Number(head.headers.get('content-length') ?? 0);
        }
        await adapter.close().catch(() => undefined);
        coreLog.info(`[mapping] ${mapping.name}: HEAD sourcePath ok, size=${sourceSize}`);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        const reason = classifyErrno(code, mapping.sourcePath);
        coreLog.info(`[mapping] ${mapping.name}: HEAD 失败 (code=${code}, reason=${reason}): ${(err as Error).message}`);
        result.warnings.push(
          `映射源文件不可达: ${mapping.name} (${reason ?? (err as Error).message})`,
        );
      }
    } else {
      try {
        const st = await fs.stat(mapping.sourcePath);
        sourceExists = st.isFile();
        sourceSize = st.size;
        coreLog.info(`[mapping] ${mapping.name}: stat sourcePath ok, isFile=${st.isFile()} isDir=${st.isDirectory()}`);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        const reason = classifyErrno(code, mapping.sourcePath);
        coreLog.info(`[mapping] ${mapping.name}: stat sourcePath 失败 (code=${code}, reason=${reason}): ${(err as Error).message}`);
        if (code !== 'ENOENT' || reason === 'network-not-found') {
          result.warnings.push(
            `映射源文件 stat 失败: ${mapping.name} (${reason ?? (err as Error).message})`,
          );
        }
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
        if (isRemotePath(mapping.sourcePath)) {
          // 远程源:走 SourceAdapter 流式下载
          const adapter = pickAdapter(mapping.sourcePath);
          try {
            const stream = await adapter.open(mapping.sourcePath);
            await streamToFile(stream, targetPath, Date.now());
            coreLog.info(`[mapping] ${mapping.name}: 已从远程源拷贝到 ${targetPath}`);
          } finally {
            await adapter.close().catch(() => undefined);
          }
        } else {
          await fs.copyFile(mapping.sourcePath, targetPath);
          await fs.utimes(targetPath, new Date(), new Date());
          coreLog.info(`[mapping] ${mapping.name}: 已拷贝到 ${targetPath}`);
        }
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        const reason = classifyErrno(code, mapping.sourcePath);
        coreLog.error(`[mapping] ${mapping.name}: 拷贝失败 ${reason ?? (err as Error).message}`);
        result.warnings.push(
          `映射拷贝失败: ${mapping.name} (${reason ?? (err as Error).message})`,
        );
      }
    } else {
      coreLog.info(`[mapping] ${mapping.name}: dryRun 跳过实际拷贝`);
    }
  }
}
