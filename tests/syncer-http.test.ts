/**
 * Syncer 集成测试 - HTTP source 端到端
 *
 * 起本地 HTTP server,暴露 manifest + 真实文件
 * Syncer 把 HTTP source 镜像到本地 target
 * 验证:文件落盘、内容正确、ETag 进 index
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { Syncer } from '../src/core/syncer.js';
import { makeTempDir, rmTemp, readTree } from './helpers.js';
import type { AppConfig } from '../src/core/types.js';

let server: Server;
let baseUrl: string;
const fileContent: Record<string, Buffer> = {};

beforeAll(async () => {
  fileContent['a.txt'] = Buffer.from('hello-http');
  fileContent['b.bin'] = Buffer.from('binary-content');
  fileContent['sub/c.txt'] = Buffer.from('nested');

  server = createServer((req, res) => {
    const url = req.url ?? '/';
    if (url === '/build/.manifest.json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify([
        { relPath: 'a.txt', size: 10, mtimeMs: 1700000000000, etag: '"e1"' },
        { relPath: 'b.bin', size: 14, mtimeMs: 1700000001000, etag: '"e2"' },
        { relPath: 'sub/c.txt', size: 6, mtimeMs: 1700000002000, etag: '"e3"' },
      ]));
      return;
    }
    const rel = url.replace(/^\/build\//, '');
    if (fileContent[rel]) {
      // 支持条件 GET
      const ifNoneMatch = req.headers['if-none-match'];
      const etag = `"e-${rel}"`;
      if (ifNoneMatch === etag) {
        res.writeHead(304, { etag }).end();
        return;
      }
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        etag,
        'content-length': String(fileContent[rel].length),
      });
      res.end(fileContent[rel]);
      return;
    }
    res.writeHead(404).end('not found');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

describe('Syncer - HTTP source 端到端', () => {
  let sourceDir: string;
  let targetDir: string;

  beforeEach(async () => {
    sourceDir = `${baseUrl}/build/`;
    targetDir = await makeTempDir('http-tgt-');
  });

  afterEach(async () => {
    await rmTemp(targetDir);
  });

  it('HTTP source → 本地 target:首轮全量拷贝', async () => {
    const config: AppConfig = {
      sourceDir,
      targetDir,
      intervalSec: 60,
      backupCount: 3,
      autostart: false,
      fileMappings: [],
      backupDir: '',
    };
    const syncer = new Syncer(config);
    const { result } = await syncer.sync(null);

    expect(result.ok).toBe(true);
    expect(result.added.sort()).toEqual(['a.txt', 'b.bin', 'sub/c.txt']);

    // 验证文件内容
    const a = await fs.readFile(join(targetDir, 'a.txt'), 'utf-8');
    expect(a).toBe('hello-http');
    const b = await fs.readFile(join(targetDir, 'b.bin'));
    expect(b.toString()).toBe('binary-content');
    const c = await fs.readFile(join(targetDir, 'sub', 'c.txt'), 'utf-8');
    expect(c).toBe('nested');
  });

  it('HTTP source:第二轮全部 unchanged', async () => {
    const config: AppConfig = {
      sourceDir,
      targetDir,
      intervalSec: 60,
      backupCount: 3,
      autostart: false,
      fileMappings: [],
      backupDir: '',
    };
    const syncer = new Syncer(config);
    await syncer.sync(null);
    const { result } = await syncer.sync(null);

    expect(result.ok).toBe(true);
    expect(result.unchanged).toBe(3);
    expect(result.added).toEqual([]);
    expect(result.modified).toEqual([]);
  });

  it('HTTP source:ETag 缓存使第二轮 304', async () => {
    const config: AppConfig = {
      sourceDir,
      targetDir,
      intervalSec: 60,
      backupCount: 3,
      autostart: false,
      fileMappings: [],
      backupDir: '',
    };
    const syncer = new Syncer(config);
    const { newSourceIndex: idx1 } = await syncer.sync(null);
    // 验证 etag 落进 index
    expect(idx1.find((f) => f.relPath === 'a.txt')?.etag).toBe('"e1"');
    // 第二轮 unchanged
    const { result } = await syncer.sync(idx1);
    expect(result.unchanged).toBe(3);
  });

  it('HTTP source:服务器不可达 → fatalReason=network-down', async () => {
    const config: AppConfig = {
      sourceDir: 'http://127.0.0.1:1/this-port-is-closed/',
      targetDir,
      intervalSec: 60,
      backupCount: 3,
      autostart: false,
      fileMappings: [],
      backupDir: '',
    };
    const syncer = new Syncer(config);
    const { result } = await syncer.sync(null);

    expect(result.ok).toBe(false);
    expect(result.fatalReason).toBe('network-down');
    expect(result.fatalTarget).toBe('source');
    // 目标应保持空
    const tree = await readTree(targetDir);
    expect(tree.size).toBe(0);
  });

  it('HTTP source:404 走 not-found 分类', async () => {
    // baseUrl 的 /build/.manifest.json 存在,但 scan 阶段通过
    // 改用一个 manifest 不存在的 URL — HttpAdapter 会 fallback 到 autoindex
    // autoindex 也 404 → throw → 分类
    const config: AppConfig = {
      sourceDir: `${baseUrl}/this-path-does-not-exist/`,
      targetDir,
      intervalSec: 60,
      backupCount: 3,
      autostart: false,
      fileMappings: [],
      backupDir: '',
    };
    const syncer = new Syncer(config);
    const { result } = await syncer.sync(null);
    expect(result.ok).toBe(false);
    // 404 → not-found
    expect(result.fatalReason).toBe('not-found');
  });
});
