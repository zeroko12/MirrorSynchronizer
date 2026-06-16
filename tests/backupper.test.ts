/**
 * Backupper 测试
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { Backupper, formatTimestamp, statDir } from '../src/core/backupper.js';
import { makeTempDir, rmTemp, writeTree, writeFile } from './helpers.js';

describe('Backupper', () => {
  let target: string;
  let backupDir: string;
  const bk = new Backupper();

  beforeEach(async () => {
    target = await makeTempDir('bk-tgt-');
    backupDir = await makeTempDir('bk-bkdir-');
  });

  afterEach(async () => {
    await rmTemp(target);
    await rmTemp(backupDir);
  });

  it('createSnapshot: 拷贝 target 内容到 backupDir/<timestamp>', async () => {
    await writeTree(target, [
      { relPath: 'a.txt', content: 'aaa' },
      { relPath: 'sub/b.txt', content: 'bbb' },
    ]);

    const snap = await bk.createSnapshot(target, backupDir);
    expect(snap.path.startsWith(backupDir)).toBe(true);
    expect(snap.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/);
    expect(snap.fileCount).toBe(2);
    expect(snap.sizeBytes).toBeGreaterThan(0);

    // 快照内容应与 target 一致
    const a = await fs.readFile(join(snap.path, 'a.txt'), 'utf-8');
    const b = await fs.readFile(join(snap.path, 'sub', 'b.txt'), 'utf-8');
    expect(a).toBe('aaa');
    expect(b).toBe('bbb');
  });

  it('createSnapshot: 不传 backupDir 时派生(targetDir-backups)', async () => {
    await writeFile(join(target, 'x.txt'), 'x');
    const snap = await bk.createSnapshot(target);
    // 跨平台:用 path.join 构造期望值,避免 / vs \ 差异
    const expectedDir = target + '-backups';
    expect(snap.path.startsWith(expectedDir)).toBe(true);
    expect(snap.path.endsWith(snap.timestamp)).toBe(true);
  });

  it('list: 按 mtime 降序返回', async () => {
    await writeFile(join(target, 'a.txt'), 'a');
    const s1 = await bk.createSnapshot(target, backupDir);
    // 隔 10ms 避免 mtime 同毫秒
    await new Promise((r) => setTimeout(r, 10));
    await writeFile(join(target, 'a.txt'), 'a2');
    const s2 = await bk.createSnapshot(target, backupDir);
    await new Promise((r) => setTimeout(r, 10));
    const s3 = await bk.createSnapshot(target, backupDir);

    const list = await bk.list(backupDir);
    expect(list.length).toBe(3);
    expect(list[0].timestamp).toBe(s3.timestamp);
    expect(list[1].timestamp).toBe(s2.timestamp);
    expect(list[2].timestamp).toBe(s1.timestamp);
  });

  it('rotate: 保留最新 N 个,删老的', async () => {
    for (let i = 0; i < 5; i++) {
      await writeFile(join(target, `f${i}.txt`), `v${i}`);
      await bk.createSnapshot(target, backupDir);
      await new Promise((r) => setTimeout(r, 5));
    }
    const removed = await bk.rotate(backupDir, 3);
    expect(removed.length).toBe(2);
    const remaining = await bk.list(backupDir);
    expect(remaining.length).toBe(3);
  });

  it('rotate: keepN=0 全删(异常配置但要支持)', async () => {
    await writeFile(join(target, 'a.txt'), 'a');
    await bk.createSnapshot(target, backupDir);
    const removed = await bk.rotate(backupDir, 0);
    expect(removed.length).toBe(1);
    expect((await bk.list(backupDir)).length).toBe(0);
  });

  it('rotate: 当前数量 < keepN 时不删', async () => {
    await bk.createSnapshot(target, backupDir);
    const removed = await bk.rotate(backupDir, 5);
    expect(removed.length).toBe(0);
  });

  it('rollback: 把快照内容恢复到 target', async () => {
    await writeTree(target, [{ relPath: 'a.txt', content: 'v1' }]);
    const snap = await bk.createSnapshot(target, backupDir);

    // 改 target
    await writeTree(target, [{ relPath: 'a.txt', content: 'v2-modified' }]);
    expect(await fs.readFile(join(target, 'a.txt'), 'utf-8')).toBe('v2-modified');

    // 回退
    await bk.rollback(snap.path, target);
    expect(await fs.readFile(join(target, 'a.txt'), 'utf-8')).toBe('v1');
  });

  it('rollback: 严格回退,删掉 target 里比快照多的文件', async () => {
    await writeTree(target, [{ relPath: 'a.txt', content: 'a' }]);
    const snap = await bk.createSnapshot(target, backupDir);

    // target 里加个新文件
    await writeFile(join(target, 'extra.txt'), 'extra');
    expect((await fs.readdir(target)).sort()).toEqual(['a.txt', 'extra.txt']);

    await bk.rollback(snap.path, target);
    const files = await fs.readdir(target);
    expect(files).toEqual(['a.txt']);
    expect(files.includes('extra.txt')).toBe(false);
  });

  it('rollback: 快照不存在时抛错', async () => {
    await expect(bk.rollback('/non/existent/path', target)).rejects.toThrow(/快照不存在/);
  });

  it('deleteSnapshot: 删除指定快照', async () => {
    await writeFile(join(target, 'a.txt'), 'a');
    const snap = await bk.createSnapshot(target, backupDir);
    expect((await bk.list(backupDir)).length).toBe(1);
    await bk.deleteSnapshot(snap.path);
    expect((await bk.list(backupDir)).length).toBe(0);
  });
});

describe('formatTimestamp', () => {
  it('输出符合预期格式', () => {
    const ts = formatTimestamp(new Date(Date.UTC(2026, 5, 12, 9, 30, 45, 123)));
    expect(ts).toBe('2026-06-12T09-30-45-123Z');
  });

  it('Windows 友好(无 : 和 .)', () => {
    const ts = formatTimestamp(new Date());
    expect(ts).not.toContain(':');
    expect(ts).not.toContain('.');
  });
});

describe('statDir', () => {
  it('统计文件数和总大小', async () => {
    const dir = await makeTempDir('stat-');
    try {
      await writeTree(dir, [
        { relPath: 'a.txt', content: '12345' },
        { relPath: 'b.txt', content: '678' },
        { relPath: 'sub/c.txt', content: 'xyz' },
      ]);
      const s = await statDir(dir);
      expect(s.fileCount).toBe(3);
      expect(s.sizeBytes).toBe(5 + 3 + 3);
    } finally {
      await rmTemp(dir);
    }
  });
});
