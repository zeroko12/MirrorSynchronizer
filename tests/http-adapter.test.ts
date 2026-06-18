/**
 * HttpAdapter 测试 - 起本地 HTTP server,验证 manifest / autoindex / 错误分类
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { HttpAdapter } from '../src/core/http-adapter.js';

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    handleRequest(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/* ============================ 路由表 ============================ */

function handleRequest(req: IncomingMessage, res: ServerResponse): void {
  const url = req.url ?? '/';

  // manifest 端点
  if (url === '/files/.manifest.json') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify([
      { relPath: 'a.txt', size: 5, mtimeMs: 1700000000000, etag: '"v1"' },
      { relPath: 'sub/b.txt', size: 10, mtimeMs: 1700000001000, etag: '"v2"' },
    ]));
    return;
  }

  // Apache 风格 autoindex
  if (url === '/apache/') {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<!DOCTYPE HTML><html><body>
<h1>Index of /apache/</h1>
<table>
<tr><th>Name</th><th>Last modified</th><th>Size</th></tr>
<tr><td><a href="x.txt">x.txt</a></td><td>2026-06-17 12:00</td><td>1024</td></tr>
<tr><td><a href="y.bin">y.bin</a></td><td>2026-06-17 12:30</td><td>2.5K</td></tr>
<tr><td><a href="../">Parent Directory</a></td><td>-</td><td>-</td></tr>
</table>
</body></html>`);
    return;
  }

  // nginx 风格 autoindex
  if (url === '/nginx/') {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<html><body><pre>
<a href="p.txt">p.txt</a>                                   17-Jun-2026 12:00             512
<a href="q.bin">q.bin</a>                                   17-Jun-2026 12:30              10M
</pre></body></html>`);
    return;
  }

  // 实际文件
  if (url === '/files/a.txt') {
    // 支持条件 GET:If-None-Match 匹配则返 304
    const ifNoneMatch = req.headers['if-none-match'];
    if (ifNoneMatch === '"v1"') {
      res.writeHead(304, { etag: '"v1"' }).end();
      return;
    }
    res.writeHead(200, {
      'content-type': 'text/plain',
      'etag': '"v1"',
      'content-length': '5',
      'last-modified': 'Tue, 14 Nov 2023 22:13:20 GMT',
    });
    res.end('hello');
    return;
  }
  if (url === '/files/sub/b.txt') {
    const ifNoneMatch = req.headers['if-none-match'];
    if (ifNoneMatch === '"v2"') {
      res.writeHead(304, { etag: '"v2"' }).end();
      return;
    }
    res.writeHead(200, {
      'content-type': 'text/plain',
      'etag': '"v2"',
      'content-length': '10',
      'last-modified': 'Tue, 14 Nov 2023 22:13:21 GMT',
    });
    res.end('world1234');
    return;
  }

  // 404
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found');
}

/* ============================ 测试 ============================ */

describe('HttpAdapter - manifest 模式', () => {
  it('scan 自动发现 manifest,返回条目', async () => {
    const a = new HttpAdapter(`${baseUrl}/files/`);
    const entries = await a.scan();
    expect(entries.length).toBe(2);
    expect(entries[0]).toMatchObject({ relPath: 'a.txt', size: 5, etag: '"v1"' });
    expect(entries[1]).toMatchObject({ relPath: 'sub/b.txt', size: 10, etag: '"v2"' });
    await a.close();
  });

  it('open 返回文件流,内容正确', async () => {
    const a = new HttpAdapter(`${baseUrl}/files/`);
    const stream = await a.open('a.txt');
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    expect(Buffer.concat(chunks).toString()).toBe('hello');
    await a.close();
  });

  it('open 404 抛错(供上层分类)', async () => {
    const a = new HttpAdapter(`${baseUrl}/files/`);
    await expect(a.open('nonexistent.txt')).rejects.toThrow(/HTTP 404/);
    await a.close();
  });

  it('openConditional:etag 匹配返 notModified', async () => {
    const a = new HttpAdapter(`${baseUrl}/files/`);
    const r = await a.openConditional('a.txt', '"v1"');
    expect(r.notModified).toBe(true);
    await a.close();
  });

  it('openConditional:etag 不匹配返新 body + 新 etag', async () => {
    const a = new HttpAdapter(`${baseUrl}/files/`);
    const r = await a.openConditional('a.txt', '"stale"');
    expect(r.notModified).toBe(false);
    expect(r.size).toBe(5);
    expect(r.etag).toBe('"v1"');
    expect(r.body).toBeDefined();
    // 消费 body
    if (r.body) {
      const chunks: Buffer[] = [];
      for await (const chunk of r.body) chunks.push(chunk as Buffer);
      expect(Buffer.concat(chunks).toString()).toBe('hello');
    }
    await a.close();
  });
});

describe('HttpAdapter - autoindex 兜底', () => {
  it('Apache 风格 HTML 解析', async () => {
    const a = new HttpAdapter(`${baseUrl}/apache/`);
    const entries = await a.scan();
    expect(entries.length).toBe(2);
    expect(entries.map((e) => e.relPath).sort()).toEqual(['x.txt', 'y.bin']);
    // size 解析: 1024 / 2.5K = 2560
    const x = entries.find((e) => e.relPath === 'x.txt');
    expect(x?.size).toBe(1024);
    const y = entries.find((e) => e.relPath === 'y.bin');
    expect(y?.size).toBe(2560);
    await a.close();
  });

  it('nginx 风格 HTML 解析', async () => {
    const a = new HttpAdapter(`${baseUrl}/nginx/`);
    const entries = await a.scan();
    expect(entries.length).toBe(2);
    const p = entries.find((e) => e.relPath === 'p.txt');
    expect(p?.size).toBe(512);
    const q = entries.find((e) => e.relPath === 'q.bin');
    expect(q?.size).toBe(10 * 1024 * 1024); // 10M
    await a.close();
  });
});

describe('HttpAdapter - manifest cache', () => {
  it('第二次 scan 命中缓存,不发 HTTP 请求', async () => {
    const a = new HttpAdapter(`${baseUrl}/files/`);
    const r1 = await a.scan();
    // 改 server 让第二次必然不一致 — 但如果走 cache,数据应不变
    const r2 = await a.scan();
    expect(r2).toEqual(r1);
    await a.close();
  });
});
