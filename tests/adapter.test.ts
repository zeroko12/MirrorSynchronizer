/**
 * adapter 模块测试 - pickAdapter 路由 + FsAdapter 行为
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { pickAdapter, FsAdapter, streamToFile } from '../src/core/adapter.js';
import { Readable } from 'node:stream';
import { makeTempDir, rmTemp, writeTree } from './helpers.js';

describe('pickAdapter', () => {
  it('http:// → HttpAdapter', () => {
    const a = pickAdapter('http://example.com/files');
    expect(a.kind).toBe('http');
  });

  it('https:// → HttpAdapter', () => {
    const a = pickAdapter('https://cdn.example.com/build/');
    expect(a.kind).toBe('http');
  });

  it('HTTP 大小写不敏感', () => {
    expect(pickAdapter('HTTPS://example.com').kind).toBe('http');
    expect(pickAdapter('Http://example.com').kind).toBe('http');
  });

  it('本地路径 → FsAdapter', () => {
    expect(pickAdapter('C:/Users/test').kind).toBe('fs');
    expect(pickAdapter('/home/user/data').kind).toBe('fs');
    expect(pickAdapter('\\\\server\\share').kind).toBe('fs');
    expect(pickAdapter('Z:\\updates').kind).toBe('fs');
  });
});

describe('FsAdapter', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await makeTempDir('adapter-fs-');
  });
  afterEach(async () => {
    await rmTemp(dir);
  });

  it('scan 返回文件列表(零行为变化,等效 Indexer)', async () => {
    await writeTree(dir, [
      { relPath: 'a.txt', content: 'hello' },
      { relPath: 'sub/b.txt', content: 'world' },
    ]);
    const a = new FsAdapter(dir);
    const files = await a.scan();
    expect(files.length).toBe(2);
    expect(files.map((f) => f.relPath).sort()).toEqual(['a.txt', 'sub/b.txt']);
  });

  it('scan 在 fatal 时抛错,带 scanResult', async () => {
    const a = new FsAdapter(join(dir, 'no-such'));
    try {
      await a.scan();
      expect.fail('应抛错');
    } catch (err) {
      const scanResult = (err as { scanResult?: { fatal: boolean; fatalReason?: string } }).scanResult;
      expect(scanResult).toBeDefined();
      expect(scanResult?.fatal).toBe(true);
      expect(scanResult?.fatalReason).toBe('not-found');
    }
  });

  it('open 返回可读流,能正确读取内容', async () => {
    await writeTree(dir, [{ relPath: 'x.txt', content: 'stream-test' }]);
    const a = new FsAdapter(dir);
    const stream = await a.open('x.txt');
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(chunk as Buffer);
    }
    expect(Buffer.concat(chunks).toString()).toBe('stream-test');
  });

  it('close 是 no-op', async () => {
    const a = new FsAdapter(dir);
    await expect(a.close()).resolves.toBeUndefined();
  });
});

describe('streamToFile', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await makeTempDir('stream-to-file-');
  });
  afterEach(async () => {
    await rmTemp(dir);
  });

  it('流式写入文件,保留 mtime', async () => {
    const dest = join(dir, 'sub', 'out.txt');
    const mtimeMs = Date.now() - 60_000; // 1 分钟前
    const stream = Readable.from(Buffer.from('hello-stream'));
    await streamToFile(stream, dest, mtimeMs);
    const content = await fs.readFile(dest, 'utf-8');
    expect(content).toBe('hello-stream');
    const stat = await fs.stat(dest);
    // mtime 应被设回 mtimeMs(允许 fs 精度)
    expect(Math.abs(stat.mtimeMs - mtimeMs)).toBeLessThan(2000);
  });

  it('源流抛错时清理半成品文件', async () => {
    const dest = join(dir, 'fail.txt');
    const stream = new Readable({
      read() {
        process.nextTick(() => this.destroy(new Error('模拟流错误')));
      },
    });
    await expect(streamToFile(stream, dest, Date.now())).rejects.toThrow('模拟流错误');
    // 验证半成品被清理
    await expect(fs.access(dest)).rejects.toThrow();
  });
});
