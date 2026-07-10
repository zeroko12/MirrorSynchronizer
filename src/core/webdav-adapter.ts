/**
 * WebDAVAdapter - WebDAV source 适配器
 *
 * 协议基础:RFC 4918 (HTTP Extensions for Web Distributed Authoring and Versioning)
 *
 * 工作模式:
 * 1. **scan** — 发 PROPFIND {baseUrl} with Depth: 1,服务端返 207 Multi-Status with multistatus XML
 *    解析 <response> 节点 → 跳过 collection → 提取 href/getcontentlength/getlastmodified/getetag
 * 2. **open** — 发 GET {baseUrl}/{relPath} 取文件内容
 * 3. **openConditional** — GET with If-None-Match 走 ETag 条件请求
 *
 * 支持认证:URL 嵌 user:pass(http://user:pass@host/webdav)走 Basic Auth
 * 不支持 OAuth2 / 客户端证书 — 那是 v2
 *
 * 依赖:Node 22 内置 fetch + adapters/parsers 的 WebDAV 纯函数
 */

import { Readable } from 'node:stream';
import type { ResourceEntry, SourceAdapter, OpenConditionalResult } from './adapter.js';
import { coreLog } from './logger.js';
import { parseWebdavPropfind } from './adapters/parsers.js';
import { safeParseContentLength } from './http-adapter.js';

export class WebDAVAdapter implements SourceAdapter {
  readonly kind = 'webdav' as const;
  private readonly baseUrl: URL;
  /** 扫描结果缓存(同 HttpAdapter 的设计) */
  private manifestCache: ResourceEntry[] | null = null;

  constructor(source: string) {
    // 归一化 webdav:// → http(s):// 让 URL constructor 能解析
    // webdav:// 通常是 https 的别名(行业惯例:WebDAV = HTTP + 一组方法)
    const normalized = source.replace(/^webdav:/i, 'https:');
    this.baseUrl = new URL(normalized);
  }

  async scan(): Promise<ResourceEntry[]> {
    if (this.manifestCache) return this.manifestCache;

    // PROPFIND Depth: 1 列出当前目录 + 1 层
    const body = `<?xml version="1.0" encoding="utf-8"?>
<D:propfind xmlns:D="DAV:">
  <D:prop>
    <D:getcontentlength/>
    <D:getlastmodified/>
    <D:getetag/>
    <D:resourcetype/>
  </D:prop>
</D:propfind>`;

    const res = await fetch(this.baseUrl.href, {
      method: 'PROPFIND',
      headers: {
        'Content-Type': 'application/xml; charset=utf-8',
        'Depth': '1',
      },
      body,
    });

    if (res.status === 404) {
      throw new Error(`HTTP 404 for ${this.baseUrl.href}`);
    }
    // WebDAV 列表预期 207;有些服务器返 200 + body
    if (res.status !== 207 && res.status !== 200) {
      throw new Error(`HTTP ${res.status} PROPFIND ${this.baseUrl.href}`);
    }

    const xml = await res.text();
    const entries = parseWebdavPropfind(xml, this.baseUrl.href);
    coreLog.info(`[webdav-adapter] PROPFIND ok: ${entries.length} files`);
    this.manifestCache = entries;
    return entries;
  }

  async open(relPath: string): Promise<Readable> {
    const url = this.fileUrl(relPath);
    const res = await fetch(url, { method: 'GET' });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} for ${relPath}`);
    }
    if (!res.body) {
      throw new Error(`HTTP response has no body for ${relPath}`);
    }
    return Readable.fromWeb(res.body as unknown as import('node:stream/web').ReadableStream);
  }

  async openConditional(relPath: string, ifNoneMatch: string): Promise<OpenConditionalResult> {
    const url = this.fileUrl(relPath);
    const res = await fetch(url, {
      method: 'GET',
      headers: { 'If-None-Match': ifNoneMatch },
    });
    if (res.status === 304) {
      return { notModified: true, size: 0, mtimeMs: 0 };
    }
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} for ${relPath}`);
    }
    const size = safeParseContentLength(res.headers.get('content-length'));
    const mtimeMs = parseHttpDate(res.headers.get('last-modified')) ?? Date.now();
    const etag = res.headers.get('etag') ?? undefined;
    const body = res.body
      ? Readable.fromWeb(res.body as unknown as import('node:stream/web').ReadableStream)
      : undefined;
    return { notModified: false, body, size, mtimeMs, etag };
  }

  async close(): Promise<void> {
    // Node 22 fetch 自带连接池
  }

  private fileUrl(relPath: string): string {
    const base = this.baseUrl.href.endsWith('/') ? this.baseUrl.href : `${this.baseUrl.href}/`;
    return new URL(relPath.replace(/^\/+/, ''), base).href;
  }
}

function parseHttpDate(s: string | null): number | null {
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}
