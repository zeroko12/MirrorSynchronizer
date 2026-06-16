/**
 * Backupper - 整盘快照 + 轮转 + 回退
 *
 * 设计:
 * - 每个快照是 <backupDir>/<timestamp>/ 目录,内容是 targetDir 的完整拷贝
 * - 时间戳格式: 2026-06-12T09-30-45-123Z(ISO 8601 但用 - 替换 : 和 . 避免 Windows 保留字符)
 * - 轮转:按 mtime 升序,删最老的直到剩 keepN 个
 * - 回退:把快照内容覆盖到 targetDir(快照里的目录是源,target 会被清空再复制)
 *
 * 与 Syncer 集成:
 * - Syncer.sync() 在扫描完后,如果有 modified 或 deleted,调用 createSnapshot
 * - 快照 ID 写进 SyncResult.backupSnapshotPath
 * - Syncer 不管轮转(轮转由 History 调度或 Backupper 独立调用)
 */

import { promises as fs, existsSync as fsExistsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { deriveDefaultBackupDir } from './types.js';

export interface BackupInfo {
  /** 快照绝对路径 */
  path: string;
  /** 时间戳字符串(同时是目录名) */
  timestamp: string;
  /** 创建时间(毫秒) */
  createdAt: number;
  /** 快照内文件数 */
  fileCount: number;
  /** 快照总大小(字节) */
  sizeBytes: number;
}

export interface SnapshotResult {
  path: string;
  timestamp: string;
  createdAt: number;
  fileCount: number;
  sizeBytes: number;
}

export class Backupper {
  /**
   * 创建快照(整盘拷贝 targetDir → backupDir/<timestamp>)
   * @returns 快照信息(含路径)
   */
  async createSnapshot(targetDir: string, explicitBackupDir?: string): Promise<SnapshotResult> {
    const backupDir = explicitBackupDir || deriveDefaultBackupDir(targetDir);
    await fs.mkdir(backupDir, { recursive: true });

    const timestamp = formatTimestamp(new Date());
    const snapshotPath = join(backupDir, timestamp);
    await fs.mkdir(snapshotPath, { recursive: true });

    const startedAt = Date.now();
    // 用 fs.cp 递归拷贝(Node 16.7+,我们有 22/20 没问题)
    await fs.cp(targetDir, snapshotPath, {
      recursive: true,
      // 不要试图复制源里没的孤儿(镜像语义下 target 可能有用户文件,我们要 1:1 复制)
      force: true,
    });

    // 统计文件数和大小
    const stats = await statDir(snapshotPath);
    void startedAt; // 暂时不打,留扩展位

    return {
      path: snapshotPath,
      timestamp,
      createdAt: Date.now(),
      fileCount: stats.fileCount,
      sizeBytes: stats.sizeBytes,
    };
  }

  /**
   * 列出 backupDir 下所有快照(按 mtime 降序,最新在前)
   */
  async list(backupDir: string): Promise<BackupInfo[]> {
    if (!existsSync(backupDir)) return [];
    let entries;
    try {
      entries = await fs.readdir(backupDir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    const infos: BackupInfo[] = [];
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const path = join(backupDir, e.name);
      const st = await fs.stat(path);
      const stats = await statDir(path);
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
      await Promise.all(paths.map((p) => fs.rm(p, { recursive: true, force: true })));
      return paths;
    }
    const all = await this.list(backupDir); // 已按 mtime 降序
    if (all.length <= keepN) return [];
    const toDelete = all.slice(keepN);
    await Promise.all(toDelete.map((i) => fs.rm(i.path, { recursive: true, force: true })));
    return toDelete.map((i) => i.path);
  }

  /**
   * 回退:把快照内容复制到 targetDir
   *
   * 步骤:
   * 1. 删 targetDir 的内容(目录本身保留,免得删到挂载点)
   * 2. 拷贝 snapshotPath → targetDir
   */
  async rollback(snapshotPath: string, targetDir: string): Promise<void> {
    if (!existsSync(snapshotPath)) {
      throw new Error(`快照不存在: ${snapshotPath}`);
    }
    // 确保 targetDir 存在
    await fs.mkdir(targetDir, { recursive: true });
    // 清空 target(保留 targetDir 本身)
    await clearDir(targetDir);
    // 拷贝快照
    await fs.cp(snapshotPath, targetDir, { recursive: true, force: true });
  }

  /**
   * 删快照
   */
  async deleteSnapshot(snapshotPath: string): Promise<void> {
    await fs.rm(snapshotPath, { recursive: true, force: true });
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
export async function statDir(dir: string): Promise<{ fileCount: number; sizeBytes: number }> {
  let fileCount = 0;
  let sizeBytes = 0;
  async function walk(d: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
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

async function clearDir(dir: string): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  await Promise.all(
    entries.map((e) => fs.rm(join(dir, e.name), { recursive: true, force: true })),
  );
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
