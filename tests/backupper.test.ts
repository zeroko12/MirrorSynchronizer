/**
 * Backupper 测试
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
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

  describe('ignoreItems 支持', () => {
    it('createSnapshot 跳过 ignoreItems 命中的文件/目录', async () => {
      await writeTree(target, [
        { relPath: 'a.txt', content: 'a' },
        { relPath: 'cache/1.dat', content: 'cache-1' },
        { relPath: 'cache/sub/2.dat', content: 'cache-2' },
        { relPath: 'config/local.ini', content: 'local' },
        { relPath: 'b.txt', content: 'b' },
      ]);
      const snap = await bk.createSnapshot(target, backupDir, {
        ignoreItems: ['cache', 'config/local.ini'],
      });
      // 快照里应只有 a.txt 和 b.txt(以及 .meta.json)
      const files = await fs.readdir(snap.path);
      const normalFiles = files.filter((f) => f !== '.meta.json').sort();
      expect(normalFiles).toEqual(['a.txt', 'b.txt']);
      // fileCount 应是 2(不包含被忽略的)
      expect(snap.fileCount).toBe(2);
      // .meta.json 记录了 ignoreItems
      const meta = await bk.readMeta(snap.path);
      expect(meta?.ignoreItems).toEqual(['cache', 'config/local.ini']);
    });

    it('createSnapshot 空 ignoreItems → 全量备份(向后兼容)', async () => {
      await writeTree(target, [
        { relPath: 'a.txt', content: 'a' },
        { relPath: 'cache/x.dat', content: 'x' },
      ]);
      const snap = await bk.createSnapshot(target, backupDir, { ignoreItems: [] });
      const files = (await fs.readdir(snap.path)).filter((f) => f !== '.meta.json').sort();
      expect(files).toEqual(['a.txt', 'cache']);
      expect(snap.fileCount).toBe(2);
    });

    it('rollback 三向:target 里的 ignoreItems 文件被保留', async () => {
      // 备份时 cache/ 不存在(target 里也没)
      await writeTree(target, [{ relPath: 'a.txt', content: 'a' }]);
      const snap = await bk.createSnapshot(target, backupDir, {
        ignoreItems: ['cache'],
      });

      // 改 target:加 a 的新版本 + 用户私有的 cache/2.dat
      await writeFile(join(target, 'a.txt'), 'a-modified');
      await writeFile(join(target, 'cache/2.dat'), 'USER-CACHE');
      expect((await fs.readdir(target)).sort()).toEqual(['a.txt', 'cache']);

      // 回退
      await bk.rollback(snap.path, target, { fallbackIgnoreItems: ['cache'] });

      // a.txt 应被回退
      expect(await fs.readFile(join(target, 'a.txt'), 'utf-8')).toBe('a');
      // cache/2.dat 应被**保留**(用户私有的内容)
      expect(await fs.readFile(join(target, 'cache/2.dat'), 'utf-8')).toBe('USER-CACHE');
    });

    it('rollback:快照有 + 不在 ignoreItems → 拷到 target', async () => {
      await writeTree(target, [
        { relPath: 'keep.txt', content: 'keep' },
        { relPath: 'cache/x.dat', content: 'cache' },
      ]);
      const snap = await bk.createSnapshot(target, backupDir, { ignoreItems: ['cache'] });
      // target 里删掉 keep.txt
      await fs.unlink(join(target, 'keep.txt'));

      await bk.rollback(snap.path, target, { fallbackIgnoreItems: ['cache'] });

      // keep.txt 应被恢复
      expect(await fs.readFile(join(target, 'keep.txt'), 'utf-8')).toBe('keep');
    });

    it('rollback:用快照自带的 ignoreItems(回退到 ignoreItems 改之前的快照)', async () => {
      // 备份时 ignoreItems = ['cache']
      await writeTree(target, [
        { relPath: 'a.txt', content: 'a' },
        { relPath: 'cache/x.dat', content: 'old-cache' },
      ]);
      const snap = await bk.createSnapshot(target, backupDir, { ignoreItems: ['cache'] });

      // 改 target(模拟用户之后改了 config,加 'logs' 到 ignoreItems)
      await writeFile(join(target, 'a.txt'), 'a-new');
      await writeFile(join(target, 'cache/y.dat'), 'new-cache-by-user');
      await writeFile(join(target, 'logs/app.log'), 'user-logs');

      // 回退时 config 已变(ignoreItems = ['cache', 'logs']),
      // 但快照自带 ignoreItems = ['cache'],应该用快照的
      await bk.rollback(snap.path, target, { fallbackIgnoreItems: ['cache', 'logs'] });

      // 快照里的 cache 内容恢复
      expect(await fs.readFile(join(target, 'cache/x.dat'), 'utf-8')).toBe('old-cache');
      // 用户之后加的 cache/y.dat 因为在 ignoreItems 里 → 保留
      expect(await fs.readFile(join(target, 'cache/y.dat'), 'utf-8')).toBe('new-cache-by-user');
      // 用户后加的 logs/app.log 在当前 config 的 ignoreItems 里,
      // 但快照里没有,不在快照的 ignoreItems 里 → 应当被回退删除
      // (回退用快照的 ignoreItems,快照的 ['cache'] 不含 'logs')
      expect(existsSync(join(target, 'logs/app.log'))).toBe(false);
    });

    it('rollback:快照无 .meta.json(老快照)→ 用 fallbackIgnoreItems', async () => {
      // 模拟老快照:创建一个没有 .meta.json 的目录
      const oldSnap = join(backupDir, '2020-01-01T00-00-00-000Z');
      await fs.mkdir(oldSnap, {recursive: true});
      await writeFile(join(oldSnap, 'a.txt'), 'old-a');

      await writeFile(join(target, 'a.txt'), 'new-a');
      await writeFile(join(target, 'cache/x.dat'), 'user-cache');

      await bk.rollback(oldSnap, target, { fallbackIgnoreItems: ['cache'] });

      expect(await fs.readFile(join(target, 'a.txt'), 'utf-8')).toBe('old-a');
      expect(await fs.readFile(join(target, 'cache/x.dat'), 'utf-8')).toBe('user-cache');
    });
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
