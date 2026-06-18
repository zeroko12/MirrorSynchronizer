/**
 * 目录列表解析器 — 策略模式
 *
 * 不同 HTTP 服务暴露目录列表的方式不同:
 * - Apache autoindex: HTML <a href> + <td> size </td>
 * - nginx autoindex:  HTML <a href>      date  size
 * - WebDAV PROPFIND:  XML multistatus with <response>  (Phase B 未来)
 * - S3 ListBucket:    XML with <Contents>             (Phase B 未来)
 *
 * 解析器接受 HTML/XML/JSON 文本,返回标准化 ResourceEntry[]
 * HttpAdapter 按顺序尝试,首个返回非空数组的胜出
 *
 * 行业参考:
 * - rclone 的 list 抽象(每种后端实现自己的 List)
 * - Apache mod_dir / nginx auto_index 都是事实标准
 */

import type { ResourceEntry } from '../adapter.js';

/** 单个目录列表解析器 */
export interface DirectoryListingParser {
  /** 唯一标识(用于日志/debug) */
  readonly name: string;
  /**
   * 解析响应文本 → 文件条目
   * @returns 非空数组表示成功识别;空数组表示不识别或解析出 0 条
   */
  parse(body: string, contentType: string | null): ResourceEntry[];
}

/* ============================ Apache autoindex ============================ */

const APACHE_RE =
  /<a\s+href="([^"]+)"[^>]*>([^<]+)<\/a>\s*<\/td>\s*<td>([^<]+)<\/td>\s*<td>([^<]+)<\/td>/gi;

export const apacheAutoindexParser: DirectoryListingParser = {
  name: 'apache-autoindex',
  parse(body, contentType) {
    if (contentType && !/text\/html/i.test(contentType)) return [];
    const out: ResourceEntry[] = [];
    let m: RegExpExecArray | null;
    APACHE_RE.lastIndex = 0;
    while ((m = APACHE_RE.exec(body)) !== null) {
      const [, href, , dateStr, sizeStr] = m;
      if (!href || href === '../' || href.endsWith('/')) continue;
      const mtimeMs = parseApacheDate(dateStr.trim());
      if (mtimeMs === null) continue;
      out.push({ relPath: href, size: parseSizeString(sizeStr.trim()), mtimeMs });
    }
    return out;
  },
};

/* ============================ nginx autoindex ============================ */

const NGINX_RE =
  /<a\s+href="([^"]+)"[^>]*>([^<]+)<\/a>\s+(\d{2}-[A-Za-z]{3}-\d{4}\s+\d{2}:\d{2})\s+(-|\d+[KMG]?)/gi;

export const nginxAutoindexParser: DirectoryListingParser = {
  name: 'nginx-autoindex',
  parse(body, contentType) {
    if (contentType && !/text\/html/i.test(contentType)) return [];
    const out: ResourceEntry[] = [];
    let m: RegExpExecArray | null;
    NGINX_RE.lastIndex = 0;
    while ((m = NGINX_RE.exec(body)) !== null) {
      const [, href, , dateStr, sizeStr] = m;
      if (!href || href === '../' || href.endsWith('/')) continue;
      const mtimeMs = parseNginxDate(dateStr.trim());
      if (mtimeMs === null) continue;
      out.push({ relPath: href, size: sizeStr === '-' ? 0 : parseSizeString(sizeStr.trim()), mtimeMs });
    }
    return out;
  },
};

/* ============================ Parser Registry ============================ */

/* ============================ WebDAV PROPFIND ============================ */

/**
 * WebDAV multistatus XML 解析(RFC 4918 § 9.1 / § 14.18)
 * 用纯函数实现(不带状态),baseHref 显式传入
 *
 * 期望格式:
 *   <D:multistatus xmlns:D="DAV:">
 *     <D:response>
 *       <D:href>http://server/webdav/file.txt</D:href>
 *       <D:propstat>
 *         <D:prop>
 *           <D:getcontentlength>100</D:getcontentlength>
 *           <D:getlastmodified>Mon, 17 Jun 2026 12:00:00 GMT</D:getlastmodified>
 *           <D:getetag>"abc123"</D:getetag>
 *         </D:prop>
 *         <D:status>HTTP/1.1 200 OK</D:status>
 *       </D:propstat>
 *     </D:response>
 *   </D:multistatus>
 */
const WEBDAV_RESPONSE_RE = /<[^>]*response\b[^>]*>([\s\S]*?)<\/[^>]*response\s*>/gi;
const WEBDAV_HREF_RE = /<[^>]*href\s*>\s*([^<]+?)\s*<\/[^>]*href\s*>/i;
const WEBDAV_COLLECTION_RE = /<[^>]*collection\s*\/?>/i;
const WEBDAV_PROPSTAT_RE = /<[^>]*propstat\b[^>]*>([\s\S]*?)<\/[^>]*propstat\s*>/gi;
const WEBDAV_STATUS_RE = /<[^>]*status\s*>\s*HTTP\/[\d.]+\s+(\d+)/i;
const WEBDAV_GETLENGTH_RE = /<[^>]*getcontentlength\s*>\s*(\d+)\s*<\/[^>]*getcontentlength\s*>/i;
const WEBDAV_GETMODIFIED_RE = /<[^>]*getlastmodified\s*>\s*([^<]+?)\s*<\/[^>]*getlastmodified\s*>/i;
const WEBDAV_GETETAG_RE = /<[^>]*getetag\s*>\s*([^<]+?)\s*<\/[^>]*getetag\s*>/i;

/** href → relPath(URL decode + 去除 basePath 前缀) */
function hrefToRelPath(href: string, baseHref: string): string | null {
  try {
    const url = new URL(href);
    let rel = decodeURIComponent(url.pathname);
    const baseUrl = new URL(baseHref);
    const basePath = decodeURIComponent(baseUrl.pathname).replace(/\/$/, '');
    if (rel.replace(/\/$/, '') === basePath) return null; // 自身(base 目录)
    if (basePath && rel.startsWith(basePath + '/')) {
      rel = rel.slice(basePath.length + 1);
    }
    return rel || null;
  } catch {
    return null;
  }
}

/**
 * 解析 WebDAV multistatus 响应
 * @param body XML 文本
 * @param baseHref 基础 URL(用于计算 relPath)
 */
export function parseWebdavPropfind(body: string, baseHref: string): ResourceEntry[] {
  const entries: ResourceEntry[] = [];
  let respMatch: RegExpExecArray | null;
  WEBDAV_RESPONSE_RE.lastIndex = 0;
  while ((respMatch = WEBDAV_RESPONSE_RE.exec(body)) !== null) {
    const respBody = respMatch[1];
    if (WEBDAV_COLLECTION_RE.test(respBody)) continue;

    const hrefMatch = WEBDAV_HREF_RE.exec(respBody);
    if (!hrefMatch) continue;
    const relPath = hrefToRelPath(hrefMatch[1], baseHref);
    if (!relPath) continue;

    // 找 status=200 的 propstat
    let size = 0;
    let mtimeMs = 0;
    let etag: string | undefined;
    let foundOk = false;
    const psRe = new RegExp(WEBDAV_PROPSTAT_RE.source, 'gi');
    let psMatch: RegExpExecArray | null;
    while ((psMatch = psRe.exec(respBody)) !== null) {
      const statusMatch = WEBDAV_STATUS_RE.exec(psMatch[1]);
      if (!statusMatch || statusMatch[1] !== '200') continue;
      const lenMatch = WEBDAV_GETLENGTH_RE.exec(psMatch[1]);
      if (lenMatch) size = Number(lenMatch[1]);
      const modMatch = WEBDAV_GETMODIFIED_RE.exec(psMatch[1]);
      if (modMatch) mtimeMs = Date.parse(modMatch[1]) || 0;
      const etagMatch = WEBDAV_GETETAG_RE.exec(psMatch[1]);
      if (etagMatch) etag = etagMatch[1];
      foundOk = true;
      break;
    }
    if (!foundOk) continue;

    entries.push({ relPath, size, mtimeMs, etag });
  }
  return entries;
}

/**
 * 默认解析器列表
 * WebDAV parser 仅 HttpAdapter 在 fallback 链路里用(WebDAVAdapter 走自己的纯函数)
 * 新增协议只需加到数组
 */
export const DEFAULT_PARSERS: DirectoryListingParser[] = [
  apacheAutoindexParser,
  nginxAutoindexParser,
];

/**
 * 依次尝试所有 parser,首个返回非空数组的胜出
 * 全部为空 → 返回空数组(让上层 fallback 到 manifest)
 */
export function parseDirectoryListing(
  body: string,
  contentType: string | null,
  parsers: DirectoryListingParser[] = DEFAULT_PARSERS,
): { entries: ResourceEntry[]; parserName: string | null } {
  for (const p of parsers) {
    const entries = p.parse(body, contentType);
    if (entries.length > 0) return { entries, parserName: p.name };
  }
  return { entries: [], parserName: null };
}

/* ============================ helpers (exposed for testing) ============================ */

export function parseApacheDate(s: string): number | null {
  const normalized = /:\d{2}$/.test(s) ? s : `${s}:00`;
  const t = Date.parse(normalized.replace(/-/g, '/'));
  return Number.isFinite(t) ? t : null;
}

export function parseNginxDate(s: string): number | null {
  const months: Record<string, number> = {
    Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
    Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
  };
  const m = /^(\d{2})-([A-Za-z]{3})-(\d{4})\s+(\d{2}):(\d{2})$/.exec(s);
  if (!m) return null;
  const [, dd, monStr, yyyy, hh, mm] = m;
  const month = months[monStr];
  if (month === undefined) return null;
  const d = new Date(Number(yyyy), month, Number(dd), Number(hh), Number(mm));
  return d.getTime();
}

export function parseSizeString(s: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*([KMG])?$/i.exec(s);
  if (!m) return 0;
  const [, num, unit] = m;
  const n = Number(num);
  if (!Number.isFinite(n)) return 0;
  switch (unit?.toUpperCase()) {
    case 'K': return Math.floor(n * 1024);
    case 'M': return Math.floor(n * 1024 * 1024);
    case 'G': return Math.floor(n * 1024 * 1024 * 1024);
    default: return Math.floor(n);
  }
}
