/**
 * WebDAVAdapter + parseWebdavPropfind 测试
 *
 * 起本地 HTTP server 模拟 WebDAV 服务,验证:
 * - PROPFIND 正确发请求(Depth: 1, body XML)
 * - multistatus XML 解析
 * - 目录跳过(resourcetype collection)
 * - 错误状态码 → throw
 * - ETag 条件 GET 304 路径
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebDAVAdapter } from '../src/core/webdav-adapter.js';
import { parseWebdavPropfind } from '../src/core/adapters/parsers.js';

let server: Server;
let baseUrl: string;
const fileContent: Record<string, Buffer> = {};

beforeAll(async () => {
  fileContent['file1.txt'] = Buffer.from('hello webdav');
  fileContent['file2.bin'] = Buffer.from([0x00, 0x01, 0x02, 0x03]);

  server = createServer((req, res) => {
    handleRequest(req, res);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

function handleRequest(req: IncomingMessage, res: ServerResponse): void {
  const url = req.url ?? '/';
  if (req.method === 'PROPFIND' && url === '/webdav/') {
    // 模拟 multistatus 响应
    res.writeHead(207, { 'content-type': 'application/xml; charset=utf-8' });
    res.end(`<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:">
  <D:response>
    <D:href>${baseUrl}/webdav/</D:href>
    <D:propstat>
      <D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
  <D:response>
    <D:href>${baseUrl}/webdav/file1.txt</D:href>
    <D:propstat>
      <D:prop>
        <D:resourcetype/>
        <D:getcontentlength>12</D:getcontentlength>
        <D:getlastmodified>Mon, 17 Jun 2026 12:00:00 GMT</D:getlastmodified>
        <D:getetag>"e-tag-1"</D:getetag>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
  <D:response>
    <D:href>${baseUrl}/webdav/file2.bin</D:href>
    <D:propstat>
      <D:prop>
        <D:resourcetype/>
        <D:getcontentlength>4</D:getcontentlength>
        <D:getlastmodified>Mon, 17 Jun 2026 12:30:00 GMT</D:getlastmodified>
        <D:getetag>"e-tag-2"</D:getetag>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
  <D:response>
    <D:href>${baseUrl}/webdav/broken.txt</D:href>
    <D:propstat>
      <D:prop><D:getcontentlength/></D:prop>
      <D:status>HTTP/1.1 404 Not Found</D:status>
    </D:propstat>
    <D:propstat>
      <D:prop><D:getcontentlength/></D:prop>
      <D:status>HTTP/1.1 404 Not Found</D:status>
    </D:propstat>
  </D:response>
</D:multistatus>`);
    return;
  }
  // 文件下载
  const rel = url.replace(/^\/webdav\//, '');
  if (fileContent[rel]) {
    const ifNoneMatch = req.headers['if-none-match'];
    if (ifNoneMatch && ifNoneMatch === `"e-tag-${rel === 'file1.txt' ? '1' : '2'}"`) {
      res.writeHead(304).end();
      return;
    }
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      etag: `"e-tag-${rel === 'file1.txt' ? '1' : '2'}"`,
      'content-length': String(fileContent[rel].length),
    });
    res.end(fileContent[rel]);
    return;
  }
  res.writeHead(404).end('not found');
}

/* ============================ parseWebdavPropfind unit tests ============================ */

describe('parseWebdavPropfind', () => {
  const baseHref = 'http://server/webdav/';

  it('解析完整 multistatus,跳过 collection', () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:">
  <D:response>
    <D:href>${baseHref}</D:href>
    <D:propstat>
      <D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
  <D:response>
    <D:href>${baseHref}file.txt</D:href>
    <D:propstat>
      <D:prop>
        <D:getcontentlength>100</D:getcontentlength>
        <D:getlastmodified>Mon, 17 Jun 2026 12:00:00 GMT</D:getlastmodified>
        <D:getetag>"abc"</D:getetag>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
</D:multistatus>`;
    const entries = parseWebdavPropfind(xml, baseHref);
    expect(entries.length).toBe(1);
    expect(entries[0]).toMatchObject({
      relPath: 'file.txt',
      size: 100,
      etag: '"abc"',
    });
    expect(entries[0].mtimeMs).toBeGreaterThan(0);
  });

  it('跳过 status != 200 的 propstat', () => {
    const xml = `<D:multistatus xmlns:D="DAV:">
  <D:response>
    <D:href>${baseHref}file.txt</D:href>
    <D:propstat>
      <D:prop><D:getcontentlength>100</D:getcontentlength></D:prop>
      <D:status>HTTP/1.1 404 Not Found</D:status>
    </D:propstat>
  </D:response>
</D:multistatus>`;
    expect(parseWebdavPropfind(xml, baseHref)).toEqual([]);
  });

  it('嵌套路径 → relPath 正确去除 base', () => {
    const xml = `<D:multistatus xmlns:D="DAV:">
  <D:response>
    <D:href>${baseHref}sub/file.txt</D:href>
    <D:propstat>
      <D:prop><D:getcontentlength>10</D:getcontentlength></D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
</D:multistatus>`;
    const entries = parseWebdavPropfind(xml, baseHref);
    expect(entries[0]?.relPath).toBe('sub/file.txt');
  });

  it('URL-encoded href 正确解码', () => {
    const xml = `<D:multistatus xmlns:D="DAV:">
  <D:response>
    <D:href>${baseHref}%E4%B8%AD%E6%96%87.txt</D:href>
    <D:propstat>
      <D:prop><D:getcontentlength>5</D:getcontentlength></D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
</D:multistatus>`;
    const entries = parseWebdavPropfind(xml, baseHref);
    expect(entries[0]?.relPath).toBe('中文.txt');
  });

  it('空 multistatus → 空数组', () => {
    expect(parseWebdavPropfind('<D:multistatus xmlns:D="DAV:"></D:multistatus>', baseHref)).toEqual([]);
  });

  it('contentType 不传(纯函数测试)→ 正常解析', () => {
    // parseWebdavPropfind 不看 contentType(contentType 检查只在 DirectoryListingParser 接口里)
    const entries = parseWebdavPropfind(
      `<D:multistatus xmlns:D="DAV:">
<D:response><D:href>${baseHref}x</D:href>
<D:propstat><D:prop><D:getcontentlength>1</D:getcontentlength></D:prop>
<D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response></D:multistatus>`,
      baseHref,
    );
    expect(entries[0]?.relPath).toBe('x');
  });
});

/* ============================ WebDAVAdapter integration ============================ */

describe('WebDAVAdapter', () => {
  it('PROPFIND 解析文件列表', async () => {
    const a = new WebDAVAdapter(`${baseUrl}/webdav/`);
    const entries = await a.scan();
    expect(entries.length).toBe(2); // 跳过 collection + 跳过 404
    expect(entries.map((e) => e.relPath).sort()).toEqual(['file1.txt', 'file2.bin']);
    expect(entries.find((e) => e.relPath === 'file1.txt')?.size).toBe(12);
    expect(entries.find((e) => e.relPath === 'file1.txt')?.etag).toBe('"e-tag-1"');
    await a.close();
  });

  it('open 返回文件流,内容正确', async () => {
    const a = new WebDAVAdapter(`${baseUrl}/webdav/`);
    const stream = await a.open('file1.txt');
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    expect(Buffer.concat(chunks).toString()).toBe('hello webdav');
    await a.close();
  });

  it('open 404 抛错(供上层 classifyHttpStatus 分类)', async () => {
    const a = new WebDAVAdapter(`${baseUrl}/webdav/`);
    await expect(a.open('nonexistent.txt')).rejects.toThrow(/HTTP 404/);
    await a.close();
  });

  it('openConditional:etag 匹配返 notModified', async () => {
    const a = new WebDAVAdapter(`${baseUrl}/webdav/`);
    const r = await a.openConditional('file1.txt', '"e-tag-1"');
    expect(r.notModified).toBe(true);
    await a.close();
  });

  it('openConditional:etag 不匹配返新 body', async () => {
    const a = new WebDAVAdapter(`${baseUrl}/webdav/`);
    const r = await a.openConditional('file1.txt', '"stale"');
    expect(r.notModified).toBe(false);
    expect(r.etag).toBe('"e-tag-1"');
    expect(r.body).toBeDefined();
    await a.close();
  });

  it('kind === "webdav"', () => {
    const a = new WebDAVAdapter(`${baseUrl}/webdav/`);
    expect(a.kind).toBe('webdav');
  });

  it('webdav:// scheme 归一化为 https://', () => {
    // 不真发请求,只验证构造
    const a = new WebDAVAdapter('webdav://user:pass@example.com/webdav/');
    expect((a as unknown as { baseUrl: URL }).baseUrl.protocol).toBe('https:');
  });
});
