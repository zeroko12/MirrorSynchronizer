/**
 * HttpAdapter - HTTP(S) source 适配器
 *
 * 工作模式(自动选择):
 * 1. **Manifest 优先**:GET {baseUrl}.manifest.json,期望返回
 *    `[{ relPath, size, mtimeMs, etag?, hash? }]`
 * 2. **Autoindex 兜底**:GET {baseUrl},走 parsers.ts 的策略链
 *    当前支持:Apache / nginx  HTML(WebDAV / S3 后续追加)
 *
 * 增量检测:ETag 条件 GET(If-None-Match)— 服务器返 304 直接 skip
 *
 * 依赖:Node 22 内置 fetch,无第三方依赖
 */

import { Readable } from 'node:stream';
import type { ResourceEntry, SourceAdapter, OpenConditionalResult } from './adapter.js';
import { coreLog } from './logger.js';
import { parseDirectoryListing, DEFAULT_PARSERS } from './adapters/parsers.js';

/** Manifest 文件名约定(源服务器可暴露) */
const MANIFEST_NAMES = ['.manifest.json', 'manifest.json', 'index.json'];

export class HttpAdapter implements SourceAdapter {
  readonly kind = 'http' as const;
  private readonly baseUrl: URL;
  /** 扫描结果缓存,避免每次 sync 都重新拉一次(可被调用方清理) */
  private manifestCache: ResourceEntry[] | null = null;

  constructor(source: string) {
    this.baseUrl = new URL(source);
  }

  async scan(): Promise<ResourceEntry[]> {
    if (this.manifestCache) return this.manifestCache;

    // 1. 试 manifest
    for (const name of MANIFEST_NAMES) {
      try {
        const entries = await this.fetchManifest(name);
        if (entries) {
          this.manifestCache = entries;
          coreLog.info(`[http-adapter] using manifest: ${name} (${entries.length} files)`);
          return entries;
        }
      } catch {
        // 继续试下一个
      }
    }

    // 2. 兜底:autoindex(走 parsers 策略链)
    coreLog.info(`[http-adapter] no manifest found, trying autoindex parsers`);
    const entries = await this.fetchAndParseListing();
    this.manifestCache = entries;
    return entries;
  }

  async open(relPath: string): Promise<Readable> {
    const url = this.fileUrl(relPath);
    const res = await this.fetch(url, { method: 'GET' });
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
    const res = await this.fetch(url, {
      method: 'GET',
      headers: { 'If-None-Match': ifNoneMatch },
    });
    if (res.status === 304) {
      return { notModified: true, size: 0, mtimeMs: 0 };
    }
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} for ${relPath}`);
    }
    const size = Number(res.headers.get('content-length') ?? 0);
    const mtimeMs = parseHttpDate(res.headers.get('last-modified')) ?? Date.now();
    const etag = res.headers.get('etag') ?? undefined;
    const body = res.body
      ? Readable.fromWeb(res.body as unknown as import('node:stream/web').ReadableStream)
      : undefined;
    return { notModified: false, body, size, mtimeMs, etag };
  }

  async close(): Promise<void> {
    // Node 22 的 fetch 自带连接池,无需手动管理 agent
  }

  /* ============================ private ============================ */

  private fileUrl(relPath: string): string {
    // 确保 baseUrl 以 / 结尾,relPath 不以 / 开头
    const base = this.baseUrl.href.endsWith('/') ? this.baseUrl.href : `${this.baseUrl.href}/`;
    const cleanRel = relPath.replace(/^\/+/, '');
    return new URL(cleanRel, base).href;
  }

  private async fetch(url: string, init: RequestInit = {}): Promise<Response> {
    return await fetch(url, init);
  }

  private async fetchManifest(name: string): Promise<ResourceEntry[] | null> {
    const base = this.baseUrl.href.endsWith('/') ? this.baseUrl.href : `${this.baseUrl.href}/`;
    const url = new URL(name, base).href;
    const res = await this.fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
    if (res.status === 404) return null;
    if (!res.ok) return null;
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return null;
    }
    if (!Array.isArray(parsed)) return null;
    return parsed.map((raw, i) => this.normalizeManifestEntry(raw, i)).filter(Boolean) as ResourceEntry[];
  }

  private normalizeManifestEntry(raw: unknown, index: number): ResourceEntry | null {
    if (!raw || typeof raw !== 'object') return null;
    const o = raw as Record<string, unknown>;
    // Strict type check BEFORE Number() coercion. Number(null) === 0 is finite
    // and would otherwise pass validation, silently producing mtime=0 entries.
    // JSON null on the server side should be rejected, not coerced.
    if (typeof o.relPath !== 'string' || !o.relPath) {
      coreLog.warn(`[http-adapter] manifest entry #${index} invalid (relPath), skip`);
      return null;
    }
    if (typeof o.size !== 'number' || !Number.isFinite(o.size)) {
      coreLog.warn(`[http-adapter] manifest entry #${index} invalid (size), skip`);
      return null;
    }
    if (typeof o.mtimeMs !== 'number' || !Number.isFinite(o.mtimeMs)) {
      coreLog.warn(`[http-adapter] manifest entry #${index} invalid (mtimeMs), skip`);
      return null;
    }
    const relPath = o.relPath;
    const size = o.size;
    const mtimeMs = o.mtimeMs;
    const entry: ResourceEntry = { relPath, size, mtimeMs };
    if (typeof o.etag === 'string') entry.etag = o.etag;
    if (typeof o.hash === 'string') entry.hash = o.hash;
    return entry;
  }

  /**
   * 拉取目录列表并尝试所有 parser
   * 未来 WebDAV 只需在 DEFAULT_PARSERS 加 WebDAV parser
   */
  private async fetchAndParseListing(): Promise<ResourceEntry[]> {
    const res = await this.fetch(this.baseUrl.href, {
      method: 'GET',
      headers: { Accept: 'text/html, application/xml, text/xml' },
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} listing ${this.baseUrl.href}`);
    }
    const text = await res.text();
    const contentType = res.headers.get('content-type');
    const { entries, parserName } = parseDirectoryListing(text, contentType, DEFAULT_PARSERS);
    if (parserName) {
      coreLog.info(`[http-adapter] parser '${parserName}' matched (${entries.length} files)`);
    } else {
      coreLog.warn(`[http-adapter] no parser matched the response`);
    }
    return entries;
  }
}

/* ============================ helpers ============================ */

function parseHttpDate(s: string | null): number | null {
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}
