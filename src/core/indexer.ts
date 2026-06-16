/**
 * Indexer - 源/目标目录扫描
 *
 * 设计要点:
 * - 走一遍目录拿到 mtime+size,O(文件数) 性能,万级 < 1s
 * - 相对路径统一用正斜杠,跨平台比较安全
 * - 可选:对 mtime 变化但 size 相同的文件做 SHA-256 哈希消解冲突
 * - 不抛错:目录不存在时返回空数组 + 致命标志由调用方处理
 */

import { promises as fs } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { createHash } from 'node:crypto';
import type { FileEntry } from './types.js';

export interface IndexOptions {
  /** 是否对大小相同但 mtime 不同的文件计算 SHA-256(用于冲突消解) */
  hashOnConflict?: boolean;
  /** 读文件哈希时每次读取的字节数 */
  hashChunkSize?: number;
}

export interface ScanResult {
  files: FileEntry[];
  /** 扫描过程中遇到的非致命错误(如权限拒绝单个文件) */
  warnings: string[];
  /** 扫描是否失败(目录不存在或不可读) */
  fatal: boolean;
}

/** 路径标准化:Windows 反斜杠 → 正斜杠 */
function normalize(rel: string): string {
  return rel.split(sep).join('/');
}

/** 递归遍历目录,产出 {绝对路径, 相对根路径} */
async function* walk(
  root: string,
  current: string,
): AsyncGenerator<{ abs: string; rel: string }, void, void> {
  let entries;
  try {
    entries = await fs.readdir(current, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const abs = join(current, entry.name);
    const rel = relative(root, abs);
    if (entry.isDirectory()) {
      yield* walk(root, abs);
    } else if (entry.isFile()) {
      yield { abs, rel: normalize(rel) };
    }
    // symlink 暂不跟随,避免循环
  }
}

/** 读流式 SHA-256 */
async function sha256(absPath: string, chunkSize = 1024 * 1024): Promise<string> {
  const hash = createHash('sha256');
  const fh = await fs.open(absPath, 'r');
  try {
    const buf = Buffer.allocUnsafe(chunkSize);
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { bytesRead } = await fh.read(buf, 0, chunkSize, null);
      if (bytesRead === 0) break;
      hash.update(buf.subarray(0, bytesRead));
    }
  } finally {
    await fh.close();
  }
  return hash.digest('hex');
}

export class Indexer {
  private readonly hashOnConflict: boolean;
  private readonly hashChunkSize: number;

  constructor(options: IndexOptions = {}) {
    this.hashOnConflict = options.hashOnConflict ?? false;
    this.hashChunkSize = options.hashChunkSize ?? 1024 * 1024;
  }

  /**
   * 扫描目录,返回所有文件条目
   * 目录不存在 → 返回 fatal=true,files=[]
   */
  async scan(dir: string): Promise<ScanResult> {
    // 目录是否存在
    try {
      const stat = await fs.stat(dir);
      if (!stat.isDirectory()) {
        return {
          files: [],
          warnings: [],
          fatal: true,
        };
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return { files: [], warnings: [], fatal: true };
      }
      throw err;
    }

    const files: FileEntry[] = [];
    const warnings: string[] = [];

    for await (const { abs, rel } of walk(dir, dir)) {
      try {
        const st = await fs.stat(abs);
        files.push({
          relPath: rel,
          size: st.size,
          mtimeMs: st.mtimeMs,
        });
      } catch (err) {
        warnings.push(`读取文件信息失败: ${rel} (${(err as Error).message})`);
      }
    }

    return { files, warnings, fatal: false };
  }

  /**
   * 对文件做 SHA-256(用于冲突消解:mtime/size 都同则跳过)
   */
  async hashFile(absPath: string): Promise<string> {
    return sha256(absPath, this.hashChunkSize);
  }

  /**
   * 给定两个 index,补齐 hash 字段(仅对 size 相同但 mtime 不同的文件)
   * 用于 syncer 在 mtime/size 冲突时进一步判断
   */
  async fillHashes(dir: string, entries: FileEntry[]): Promise<FileEntry[]> {
    if (!this.hashOnConflict) return entries;
    return Promise.all(
      entries.map(async (e) => {
        if (e.hash) return e;
        const abs = join(dir, e.relPath);
        e.hash = await this.hashFile(abs);
        return e;
      }),
    );
  }
}
