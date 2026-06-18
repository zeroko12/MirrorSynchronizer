/**
 * SourceAdapter - 协议无关的 source 抽象
 *
 * 设计:
 * - Syncer 只跟 SourceAdapter 打交道,不再假设 sourceDir 是本地路径
 * - FsAdapter 包装现有 Indexer(本地 + SMB 经由 fs API)
 * - HttpAdapter 处理 HTTP(S) 源(本次新增)
 * - 未来 S3 / WebDAV 只需新增一个 adapter
 *
 * 协议选择(pickAdapter):
 * - http:// / https:// → HttpAdapter
 * - 其他(本地/SMB/挂载盘符) → FsAdapter
 */

import { createReadStream, promises as fs } from 'node:fs';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { Indexer } from './indexer.js';
import type { FileEntry } from './types.js';
import { HttpAdapter } from './http-adapter.js';
import { WebDAVAdapter } from './webdav-adapter.js';

/** 适配器产出的单文件元数据(与 FileEntry 同义,语义独立) */
export type ResourceEntry = FileEntry;

/** source 适配器类型 — 扩展位(预留给 WebDAV) */
export type SourceAdapterKind = 'fs' | 'http' | 'webdav';

/** source 适配器接口 */
export interface SourceAdapter {
  /** 适配器标识(用于日志和 UI 展示) */
  readonly kind: SourceAdapterKind;

  /** 扫描整个 source 树,返回所有文件条目 */
  scan(): Promise<ResourceEntry[]>;

  /**
   * 打开一个文件为可读流
   * - FsAdapter 走 createReadStream
   * - HttpAdapter 走 fetch().body
   * 调用方负责消费完流并关闭
   */
  open(relPath: string): Promise<Readable>;

  /**
   * HTTP 专用:用 ETag 做条件 GET,返回 { notModified, body, size, mtimeMs, etag }
   * FsAdapter 不实现(直接走 open)
   * @returns notModified=true 时调用方不需要下载
   */
  openConditional?(relPath: string, ifNoneMatch: string): Promise<OpenConditionalResult>;

  /** 关闭/释放资源(keep-alive agent 等) */
  close(): Promise<void>;
}

export interface OpenConditionalResult {
  notModified: boolean;
  body?: Readable;
  size: number;
  mtimeMs: number;
  etag?: string;
}

/**
 * 根据 source 字符串选择适配器
 * - `webdav://` → WebDAVAdapter(走 PROPFIND,UI 上报为 'webdav' kind)
 * - `http://` 或 `https://` → HttpAdapter(走 manifest/autoindex 兜底)
 * - 其他(本地/SMB/UNC/挂载盘符) → FsAdapter
 */
export function pickAdapter(source: string): SourceAdapter {
  if (/^webdav:\/\//i.test(source)) {
    return new WebDAVAdapter(source);
  }
  if (/^https?:\/\//i.test(source)) {
    return new HttpAdapter(source);
  }
  return new FsAdapter(source);
}

/** 是否是远程 URL 路径(http/https/webdav) — 用于决定走 fs 还是 adapter */
export function isRemotePath(path: string): boolean {
  return /^https?:\/\//i.test(path) || /^webdav:\/\//i.test(path);
}

/* ============================ FsAdapter ============================ */

/**
 * FsAdapter - 本地 + SMB(走 fs API)
 * 本质是现有 Indexer 的薄包装,零行为变化
 */
export class FsAdapter implements SourceAdapter {
  readonly kind = 'fs' as const;
  private readonly indexer: Indexer;

  constructor(private readonly root: string) {
    this.indexer = new Indexer({ hashOnConflict: false });
  }

  async scan(): Promise<ResourceEntry[]> {
    const result = await this.indexer.scan(this.root);
    if (result.fatal) {
      // 把 Indexer 的 fatal 抛回,Syncer 那边用 Indexer 自己的 fatalReason 分类
      const err = new Error(`fs scan fatal: ${result.fatalReason ?? 'unknown'}`) as Error & {
        code?: string;
        scanResult?: typeof result;
      };
      err.scanResult = result;
      throw err;
    }
    return result.files;
  }

  async open(relPath: string): Promise<Readable> {
    const abs = join(this.root, relPath);
    return createReadStream(abs);
  }

  async close(): Promise<void> {
    // no-op
  }
}

/* ============================ Utility ============================ */

/**
 * 把文件流式写入目标路径(adapter-agnostic)
 * - 拷贝完成后保留 mtime,避免下一轮被误判为 modified
 * - 出错时清理半成品
 */
export async function streamToFile(
  source: Readable,
  destPath: string,
  mtimeMs: number,
): Promise<void> {
  const { createWriteStream } = await import('node:fs');
  const { dirname } = await import('node:path');
  const { pipeline } = await import('node:stream/promises');

  await fs.mkdir(dirname(destPath), { recursive: true });

  try {
    await pipeline(source, createWriteStream(destPath));
  } catch (err) {
    // 清理半成品
    try {
      await fs.unlink(destPath);
    } catch {
      // ignore
    }
    throw err;
  }

  // 保留 mtime
  try {
    await fs.utimes(destPath, new Date(mtimeMs), new Date(mtimeMs));
  } catch {
    // mtime 设置失败不致命
  }
}
