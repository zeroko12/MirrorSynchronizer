/**
 * Syncer.applyMapping 测试 - 远程源(HTTP / WebDAV)支持
 *
 * 起本地 HTTP server 模拟远程文件,验证:
 * - 远程源存在 → 拷贝成功
 * - 远程源 404 → 按 ifSourceMissing 策略处理
 * - webdav:// 走 WebDAVAdapter(实际就是 PROPFIND + GET,这里用 HTTP mock)
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { Syncer } from '../src/core/syncer.js';
import { makeTempDir, rmTemp } from './helpers.js';
import type { AppConfig, FileMapping } from '../src/core/types.js';

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = req.url ?? '/';
    if (req.method === 'HEAD' && url === '/config.json') {
      res.writeHead(200, { 'content-length': '42' });
      res.end();
      return;
    }
    if (req.method === 'GET' && url === '/config.json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"version":"1.0","remoteSource":true}');
      return;
    }
    if (req.method === 'HEAD' && url === '/missing.txt') {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(404);
    res.end('not found');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

describe('applyMapping - 远程 HTTP 源', () => {
  let targetDir: string;
  let localDir: string;
  let config: AppConfig;

  beforeEach(async () => {
    targetDir = await makeTempDir('map-http-tgt-');
    localDir = await makeTempDir('map-http-local-');
    config = {
      sourceDir: localDir, // 主 source 用本地(空目录,只测映射)
      targetDir,
      intervalSec: 60,
      backupCount: 3,
      autostart: false,
      fileMappings: [],
      ignoreItems: [],
      backupDir: '',
    };
  });

  afterEach(async () => {
    await rmTemp(targetDir);
    await rmTemp(localDir);
  });

  it('远程源存在 + overwrite=true → 拷贝到 target,内容正确', async () => {
    const mapping: FileMapping = {
      id: 'm1',
      name: 'remote-config',
      sourcePath: `${baseUrl}/config.json`,
      targetRelpath: 'app/config.json',
      enabled: true,
      overwrite: true,
      ifSourceMissing: 'skip',
    };
    const syncer = new Syncer({ ...config, fileMappings: [mapping] });
    const { result } = await syncer.sync(null);

    expect(result.ok).toBe(true);
    expect(result.mappingCopied).toContain('remote-config');
    const written = await fs.readFile(join(targetDir, 'app', 'config.json'), 'utf-8');
    expect(written).toBe('{"version":"1.0","remoteSource":true}');
  });

  it('远程源 404 + ifSourceMissing=skip → mappingSkipped', async () => {
    const mapping: FileMapping = {
      id: 'm2',
      name: 'remote-missing',
      sourcePath: `${baseUrl}/missing.txt`,
      targetRelpath: 'app/missing.txt',
      enabled: true,
      overwrite: true,
      ifSourceMissing: 'skip',
    };
    const syncer = new Syncer({ ...config, fileMappings: [mapping] });
    const { result } = await syncer.sync(null);

    expect(result.ok).toBe(true);
    expect(result.mappingSkipped).toContain('remote-missing');
    expect(result.mappingCopied).not.toContain('remote-missing');
    // target 不应被创建
    await expect(fs.access(join(targetDir, 'app', 'missing.txt'))).rejects.toThrow();
  });

  it('远程源 404 + ifSourceMissing=keep → 不删 target,target 内容保留', async () => {
    // 先放一个目标文件
    await fs.mkdir(join(targetDir, 'app'), { recursive: true });
    await fs.writeFile(join(targetDir, 'app', 'keep.txt'), 'old-content');
    const mapping: FileMapping = {
      id: 'm3',
      name: 'remote-keep',
      sourcePath: `${baseUrl}/missing.txt`,
      targetRelpath: 'app/keep.txt',
      enabled: true,
      overwrite: true,
      ifSourceMissing: 'keep',
    };
    const syncer = new Syncer({ ...config, fileMappings: [mapping] });
    const { result } = await syncer.sync(null);

    // keep 策略:source 不存在时啥都不做 — 既不拷贝也不删
    expect(result.mappingCopied).not.toContain('remote-keep');
    expect(result.mappingSkipped).not.toContain('remote-keep');
    expect(result.deleted).not.toContain('app/keep.txt');
    // 旧文件保留
    const content = await fs.readFile(join(targetDir, 'app', 'keep.txt'), 'utf-8');
    expect(content).toBe('old-content');
  });

  it('远程源 404 + ifSourceMissing=delete → 删 target', async () => {
    await fs.mkdir(join(targetDir, 'app'), { recursive: true });
    await fs.writeFile(join(targetDir, 'app', 'doomed.txt'), 'will-be-deleted');
    const mapping: FileMapping = {
      id: 'm4',
      name: 'remote-delete',
      sourcePath: `${baseUrl}/missing.txt`,
      targetRelpath: 'app/doomed.txt',
      enabled: true,
      overwrite: true,
      ifSourceMissing: 'delete',
    };
    const syncer = new Syncer({ ...config, fileMappings: [mapping] });
    const { result } = await syncer.sync(null);

    expect(result.deleted).toContain('app/doomed.txt');
    await expect(fs.access(join(targetDir, 'app', 'doomed.txt'))).rejects.toThrow();
  });

  it('远程源 unreachable(端口关闭)→ warning,映射标 copied 但实际未拉', async () => {
    const mapping: FileMapping = {
      id: 'm5',
      name: 'remote-down',
      sourcePath: 'http://127.0.0.1:1/this-port-is-closed/config.json',
      targetRelpath: 'app/down.json',
      enabled: true,
      overwrite: true,
      ifSourceMissing: 'skip',
    };
    const syncer = new Syncer({ ...config, fileMappings: [mapping] });
    const { result } = await syncer.sync(null);

    // ok 仍为 true(网络失败不影响主同步)
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings.some((w) => w.includes('remote-down'))).toBe(true);
    // target 不应有文件
    await expect(fs.access(join(targetDir, 'app', 'down.json'))).rejects.toThrow();
  });
});

describe('isRemotePath helper', () => {
  it('本地路径 false', async () => {
    const { isRemotePath } = await import('../src/core/adapter.js');
    expect(isRemotePath('C:/test')).toBe(false);
    expect(isRemotePath('/home/user')).toBe(false);
    expect(isRemotePath('\\\\server\\share')).toBe(false);
  });

  it('http / https / webdav true', async () => {
    const { isRemotePath } = await import('../src/core/adapter.js');
    expect(isRemotePath('http://x')).toBe(true);
    expect(isRemotePath('https://x')).toBe(true);
    expect(isRemotePath('webdav://x')).toBe(true);
    expect(isRemotePath('HTTPS://X')).toBe(true);
  });
});
