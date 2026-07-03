/**
 * Backupper - 整盘快照 + 轮转 + 回退
 *
 * 设计:
 * - 每个快照是 <backupDir>/<timestamp>/ 目录,内容是 targetDir 的完整拷贝
 * - 时间戳格式: 2026-06-12T09-30-45-123Z(ISO 8601 但用 - 替换 : 和 . 避免 Windows 保留字符)
 * - 轮转:按 mtime 升序,删最老的直到剩 keepN 个
 * - 回退:把快照内容覆盖到 targetDir(快照里的目录是源,target 会被清空再复制)
 * - 忽略项支持:
 *   - createSnapshot 接受 ignoreItems,跳过匹配的文件/目录(它们是用户私有内容,不属于同步)
 *   - 快照目录里写 .meta.json 记下 ignoreItems,rollback 用快照里的值,
 *     而不是当前 config(避免 config 改过导致回退行为变化)
 *
 * 与 Syncer 集成:
 * - Syncer.sync() 在扫描完后,如果有 modified 或 deleted,调用 createSnapshot
 * - 快照 ID 写进 SyncResult.backupSnapshotPath
 * - Syncer 不管轮转(轮转由 History 调度或 Backupper 独立调用)
 */

import { promises as fs, existsSync as fsExistsSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { deriveDefaultBackupDir, isInIgnoredItem } from './types.js';

export interface BackupInfo {
  /** 快照绝对路径 */
  path: string;
  /** 时间戳字符串(同时是目录名) */
  timestamp: string;
  /** 创建时间(毫秒) */
  createdAt: number;
  /** 快照内文件数(不包含被忽略的) */
  fileCount: number;
  /** 快照总大小(不包含被忽略的) */
  sizeBytes: number;
}

export interface SnapshotResult {
  path: string;
  timestamp: string;
  createdAt: number;
  fileCount: number;
  sizeBytes: number;
  /** 快照时使用的 ignoreItems(也写进 .meta.json) */
  ignoreItems: string[];
}

export interface SnapshotMeta {
  /** 备份创建时间(毫秒) */
  createdAt: number;
  /** 创建时使用的 ignoreItems(回退时用这个,不用当前 config) */
  ignoreItems: string[];
  /** 源 targetDir 绝对路径(回退时日志用) */
  targetDir: string;
}

const META_FILE = '.meta.json';

export class Backupper {
  /**
   * 创建快照(整盘拷贝 targetDir → backupDir/<timestamp>)
   *
   * @param targetDir 源目录
   * @param explicitBackupDir 备份根目录(默认派生)
   * @param opts.ignoreItems 相对 targetDir 的路径前缀列表,匹配的文件/目录不备份
   *   (默认空,全量备份)
   * @returns 快照信息(含路径、ignoreItems)
   */
  async createSnapshot(
    targetDir: string,
    explicitBackupDir?: string,
    opts: { ignoreItems?: string[] } = {},
  ): Promise<SnapshotResult> {
    const backupDir = explicitBackupDir || deriveDefaultBackupDir(targetDir);
    await fs.mkdir(backupDir, { recursive: true });

    const timestamp = formatTimestamp(new Date());
    const snapshotPath = join(backupDir, timestamp);
    await fs.mkdir(snapshotPath, {recursive: true});

    const ignoreItems = (opts.ignoreItems ?? []).filter((i) => i.length > 0);

    // 写元数据(先写,回退用)
    const meta: SnapshotMeta = {
      createdAt: Date.now(),
      ignoreItems,
      targetDir: resolve(targetDir),
    };
    await atomicWriteJson(join(snapshotPath, META_FILE), meta);

    // 用 fs.cp 递归拷贝 + filter 过滤 ignoreItems
    // filter 对目录返回 false 会跳过整个子树
    await fs.cp(targetDir, snapshotPath, {
      recursive: true,
      force: true,
      filter: (src) => {
        const rel = relative(targetDir, src);
        // 跳过根目录本身(relative 返回空字符串)
        if (rel === '' || rel === '.') return true;
        const norm = rel.split(sep).join('/');
        // filter 内不抛错(fs.cp 会吞,只 skip),要调试可加 log
        return !isInIgnoredItem(norm, ignoreItems);
      },
    });

    // 后处理:删空目录(fs.cp 会建父目录再 skip 里面的文件,留下空壳)
    // 只删"完全空"或"只含 .meta.json"的目录
    await pruneEmptyDirs(snapshotPath);

    // 统计文件数和大小(不包含 .meta.json)
    const stats = await statDir(snapshotPath, [META_FILE]);

    return {
      path: snapshotPath,
      timestamp,
      createdAt: meta.createdAt,
      fileCount: stats.fileCount,
      sizeBytes: stats.sizeBytes,
      ignoreItems,
    };
  }

  /**
   * 读取快照元数据(回退时用)
   */
  async readMeta(snapshotPath: string): Promise<SnapshotMeta | null> {
    try {
      const raw = await fs.readFile(join(snapshotPath, META_FILE), 'utf-8');
      return JSON.parse(raw) as SnapshotMeta;
    } catch {
      return null;
    }
  }

  /**
   * 列出 backupDir 下所有快照(按 mtime 降序,最新在前)
   */
  async list(backupDir: string): Promise<BackupInfo[]> {
    if (!existsSync(backupDir)) return [];
    let entries;
    try {
      entries = await fs.readdir(backupDir, {withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    const infos: BackupInfo[] = [];
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const path = join(backupDir, e.name);
      const st = await fs.stat(path);
      const stats = await statDir(path, [META_FILE]);
      infos.push({
        path,
        timestamp: e.name,
        createdAt: st.mtimeMs,
        fileCount: stats.fileCount,
        sizeBytes: stats.sizeBytes,
      });
    }
    infos.sort((a, b) => b.createdAt - a.createdAt);
    return infos;
  }

  /**
   * 轮转:保留最新 keepN 个,删最老的
   * @returns 被删的快照路径列表
   */
  async rotate(backupDir: string, keepN: number): Promise<string[]> {
    if (keepN < 0) throw new Error('keepN 不能为负');
    if (keepN === 0) {
      // 0 表示全删(异常配置,但要支持)
      const all = await this.list(backupDir);
      const paths = all.map((i) => i.path);
      await Promise.all(paths.map((p) => fs.rm(p, {recursive: true, force: true })));
      return paths;
    }
    const all = await this.list(backupDir); // 已按 mtime 降序
    if (all.length <= keepN) return [];
    const toDelete = all.slice(keepN);
    await Promise.all(toDelete.map((i) => fs.rm(i.path, {recursive: true, force: true })));
    return toDelete.map((i) => i.path);
  }

  /**
   * 回退:把快照内容恢复到 targetDir,使用三向策略保留 ignoreItems
   *
   * 行为(关键!):
   * - 快照里有 + 不在 ignoreItems → 拷到 target
   * - 快照里有 + 在 ignoreItems → 跳过(不写 target)
   * - target 里有 + 在 ignoreItems → **保留**(不删!)
   * - target 里有 + 不在 ignoreItems + 快照里没 → 删(是用户/同步系统在快照后新增又该被回退删除的)
   * - target 里有 + 不在 ignoreItems + 快照里有(但不同) → 覆盖
   *
   * 备份时跳过的 ignoreItems 内容(target 里那些私有的缓存/日志等)永远不会被回退影响
   *
   * @param snapshotPath 快照路径
   * @param targetDir 目标目录
   * @param opts.fallbackIgnoreItems 快照没元数据时用这个(老快照兼容)
   */
  async rollback(
    snapshotPath: string,
    targetDir: string,
    opts: { fallbackIgnoreItems?: string[] } = {},
  ): Promise<void> {
    if (!existsSync(snapshotPath)) {
      throw new Error(`快照不存在: ${snapshotPath}`);
    }
    await fs.mkdir(targetDir, {recursive: true});

    // 优先用快照自带的 ignoreItems,fallback 到调用者传的,再 fallback 到 []
    const meta = await this.readMeta(snapshotPath);
    const ignoreItems = meta?.ignoreItems ?? opts.fallbackIgnoreItems ?? [];

    // 列出 target 和 snapshot 的所有文件(相对路径)
    const targetFiles = await listFilesRecursive(targetDir, [META_FILE]);
    const snapshotFiles = await listFilesRecursive(snapshotPath, [META_FILE]);

    const targetSet = new Set(targetFiles);
    const snapshotSet = new Set(snapshotFiles);

    // 1. snapshot 有 + 不在 ignoreItems → 拷贝到 target
    for (const rel of snapshotFiles) {
      if (isInIgnoredItem(rel, ignoreItems)) continue; // 不写 ignored
      const src = join(snapshotPath, rel);
      const dst = join(targetDir, rel);
      await fs.mkdir(dirname(dst), {recursive: true});
      await fs.copyFile(src, dst);
    }

    // 2. target 有 + 在 ignoreItems → **保留**(不删)
    //    隐式:这个分支什么都不做

    // 3. target 有 + 不在 ignoreItems + snapshot 没 → 删
    for (const rel of targetFiles) {
      if (isInIgnoredItem(rel, ignoreItems)) continue; // 不删 ignored
      if (!snapshotSet.has(rel)) {
        await fs.unlink(join(targetDir, rel));
      }
    }
    // 静默使用 targetSet 避免 unused 警告(可能未来要校验)
    void targetSet;

    // 4. target 里 target 目录结构里空的目录(且全在 ignoreItems 里)清掉
    //    这些空目录是历史 snapshot 残留的,清掉看起来干净一些
    //    限制:只删 target 里有的,且 target 在 ignoreItems 里的目录
    await pruneEmptyDirsInTarget(targetDir, targetFiles, ignoreItems);
  }

  /**
   * 删快照
   */
  async deleteSnapshot(snapshotPath: string): Promise<void> {
    await fs.rm(snapshotPath, {recursive: true, force: true });
  }

  /**
   * 解析 backupDir(用户配置 > 派生自 targetDir)
   */
  resolveBackupDir(targetDir: string, explicit?: string): string {
    return resolve(explicit || deriveDefaultBackupDir(targetDir));
  }
}

/**
 * 文件系统辅助
 */
export async function statDir(
  dir: string,
  excludeNames: string[] = [],
): Promise<{ fileCount: number; sizeBytes: number }> {
  let fileCount = 0;
  let sizeBytes = 0;
  const exclude = new Set(excludeNames);
  async function walk(d: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (exclude.has(e.name)) continue;
      const abs = join(d, e.name);
      if (e.isDirectory()) {
        await walk(abs);
      } else if (e.isFile()) {
        try {
          const st = await fs.stat(abs);
          fileCount++;
          sizeBytes += st.size;
        } catch {
          // 跳过无法访问的文件
        }
      }
    }
  }
  await walk(dir);
  return { fileCount, sizeBytes };
}

/**
 * 递归列出目录下所有文件(相对路径,POSIX 风格,排除指定名字)
 * 用在 rollback 时做三向对比
 */
async function listFilesRecursive(
  root: string,
  excludeNames: string[] = [],
): Promise<string[]> {
  const out: string[] = [];
  const exclude = new Set(excludeNames);
  async function walk(dir: string, prefix: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (exclude.has(e.name)) continue;
      const full = join(dir, e.name);
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(full, rel);
      else if (e.isFile()) out.push(rel);
    }
  }
  await walk(root, '');
  return out;
}

/**
 * 删目录树里所有空目录(自底向上,无副作用)
 * 用在 createSnapshot 后清掉 fs.cp 因 filter skip 留下的空壳目录
 * 注意:此函数不删根目录本身(只删子目录)
 */
async function pruneEmptyDirs(root: string): Promise<void> {
  // 收集所有子目录(深度优先)
  const dirs: string[] = [];
  async function walk(d: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const full = join(d, e.name);
      dirs.push(full);
      await walk(full);
    }
  }
  await walk(root);
  // 自底向上(深度深的先)删除空目录
  for (const d of dirs.reverse()) {
    try {
      const entries = await fs.readdir(d);
      if (entries.length === 0) {
        await fs.rmdir(d);
      }
    } catch {
      // 不是空(被 filter 漏过)或已被删 → 跳过
    }
  }
}

/**
 * 清空 target 里"在 ignoreItems 中"的空目录(没被 snapshot 恢复成有内容的)
 * 只清 target 里、且 target 原本就有的(用 targetFiles 验证)
 */
async function pruneEmptyDirsInTarget(
  targetDir: string,
  targetFiles: string[],
  ignoreItems: string[],
): Promise<void> {
  if (ignoreItems.length === 0) return;
  // 找出 target 里所有目录(从 targetFiles 推导)
  const dirSet = new Set<string>();
  for (const f of targetFiles) {
    const parts = f.split('/');
    for (let i = 1; i < parts.length; i++) {
      dirSet.add(parts.slice(0, i).join('/'));
    }
  }
  // 检查每个目录是否在 ignoreItems 里 + 是否空
  for (const rel of dirSet) {
    if (!isInIgnoredItem(rel, ignoreItems)) continue;
    const abs = join(targetDir, rel);
    try {
      const entries = await fs.readdir(abs);
      if (entries.length === 0) {
        await fs.rmdir(abs);
      }
    } catch {
      // 目录不存在或非空 → 跳过
    }
  }
}

/**
 * 原子写 JSON(借现有 fs-utils)
 */
async function atomicWriteJson(path: string, data: unknown): Promise<void> {
  const { atomicWriteJson: w } = await import('./fs-utils.js');
  return w(path, data);
}

function existsSync(p: string): boolean {
  return fsExistsSync(p);
}

/**
 * 格式化时间戳作为目录名(Windows 友好,文件系统安全)
 * 例: 2026-06-12T09-30-45-123Z
 */
export function formatTimestamp(d: Date): string {
  const pad = (n: number, len = 2) => String(n).padStart(len, '0');
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}-${pad(d.getUTCMinutes())}-${pad(d.getUTCSeconds())}` +
    `-${pad(d.getUTCMilliseconds(), 3)}Z`
  );
}

// 仅类型导出,运行时用 resolve 替代
void dirname;
