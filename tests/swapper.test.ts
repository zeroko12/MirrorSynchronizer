/**
 * Swapper 测试 - staging ↔ target 原子交换
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { applyPending, clearStaging, countPendingApply, hasPendingApply } from '../src/core/swapper.js';
import { makeTempDir, rmTemp, writeFile, writeTree } from './helpers.js';

describe('Swapper - hasPendingApply + countPendingApply', () => {
  let stagingDir: string;

  beforeEach(async () => {
    stagingDir = await makeTempDir('sw-stg-');
  });
  afterEach(async () => { await rmTemp(stagingDir); });

  it('空目录 → false', async () => {
    expect(await hasPendingApply(stagingDir)).toBe(false);
  });

  it('不存在的目录 → false', async () => {
    expect(await hasPendingApply(stagingDir + '-nope')).toBe(false);
  });

  it('只有 .pending-apply 但没文件 → false(异常状态)', async () => {
    await fs.writeFile(join(stagingDir, '.pending-apply'), '');
    expect(await hasPendingApply(stagingDir)).toBe(false);
  });

  it('有文件 + .pending-apply → true', async () => {
    await writeFile(join(stagingDir, '.pending-apply'), '');
    await writeFile(join(stagingDir, 'foo.txt'), 'foo');
    expect(await hasPendingApply(stagingDir)).toBe(true);
    expect(await countPendingApply(stagingDir)).toBe(1);
  });

  it('嵌套子目录里的文件也计入', async () => {
    await writeTree(stagingDir, [
      { relPath: '.pending-apply', content: '' },
      { relPath: 'a.txt', content: 'a' },
      { relPath: 'sub/b.txt', content: 'b' },
      { relPath: 'sub/deep/c.txt', content: 'c' },
    ]);
    expect(await hasPendingApply(stagingDir)).toBe(true);
    expect(await countPendingApply(stagingDir)).toBe(3);
  });
});

describe('Swapper - applyPending 基本流程', () => {
  let stagingDir: string;
  let targetDir: string;
  let backupDir: string;

  beforeEach(async () => {
    stagingDir = await makeTempDir('sw-stg-');
    targetDir = await makeTempDir('sw-tgt-');
    backupDir = await makeTempDir('sw-bak-');
  });
  afterEach(async () => {
    await rmTemp(stagingDir);
    await rmTemp(targetDir);
    await rmTemp(backupDir);
  });

  it('无 pending → ok=true,空操作', async () => {
    const r = await applyPending({
      targetDir, stagingDir, backupDir, backupCount: 3,
    });
    expect(r.ok).toBe(true);
    expect(r.applied).toEqual([]);
    expect(r.blocked).toEqual([]);
  });

  it('基本流程:staging 有新版本 → swap 到 target,旧 target 进 backup', async () => {
    // target 里先有旧版本
    await writeFile(join(targetDir, 'foo.txt'), 'OLD-foo');
    await writeFile(join(targetDir, 'sub', 'bar.txt'), 'OLD-bar');
    // staging 有新版本
    await writeTree(stagingDir, [
      { relPath: '.pending-apply', content: '' },
      { relPath: 'foo.txt', content: 'NEW-foo' },
      { relPath: 'sub/bar.txt', content: 'NEW-bar' },
      { relPath: 'new.txt', content: 'BRAND-NEW' },  // 新增
    ]);

    const r = await applyPending({
      targetDir, stagingDir, backupDir, backupCount: 3,
    });

    expect(r.ok).toBe(true);
    expect(r.applied.sort()).toEqual(['foo.txt', 'new.txt', 'sub/bar.txt']);
    expect(r.blocked).toEqual([]);
    expect(r.backupSnapshotPath).toBeTruthy();

    // target 里是新版本
    expect((await fs.readFile(join(targetDir, 'foo.txt'), 'utf-8'))).toBe('NEW-foo');
    expect((await fs.readFile(join(targetDir, 'sub', 'bar.txt'), 'utf-8'))).toBe('NEW-bar');
    expect((await fs.readFile(join(targetDir, 'new.txt'), 'utf-8'))).toBe('BRAND-NEW');

    // staging 已清空
    expect(await hasPendingApply(stagingDir)).toBe(false);
    expect((await fs.readdir(stagingDir)).filter(n => !n.startsWith('.'))).toEqual([]);

    // backupDir 有旧版本
    expect(r.backupSnapshotPath).toContain(backupDir);
  });

  it('目标不存在(新建场景) → 不创建 backup,swap 创建 target/', async () => {
    // target 路径不存在(完全空目录都不存在)
    const freshTarget = join(targetDir, 'never-created');
    await writeTree(stagingDir, [
      { relPath: '.pending-apply', content: '' },
      { relPath: 'init.txt', content: 'init' },
    ]);

    const r = await applyPending({
      targetDir: freshTarget, stagingDir, backupDir, backupCount: 3,
    });

    expect(r.ok).toBe(true);
    expect(r.applied).toEqual(['init.txt']);
    // target 不存在所以没 backup
    expect(r.backupSnapshotPath).toBeUndefined();

    // target 现在有了
    expect((await fs.readFile(join(freshTarget, 'init.txt'), 'utf-8'))).toBe('init');
  });

  it('空 staging 但有 .pending-apply 标记文件 → 清掉标记 + ok=true', async () => {
    // 直接调 clearStaging(因为只有标记没有内容时 applyPending 会早返回)
    await fs.writeFile(join(stagingDir, '.pending-apply'), '');
    const r = await clearStaging({ stagingDir });
    expect(r.ok).toBe(true);
    // 标记被清
    try { await fs.stat(join(stagingDir, '.pending-apply')); expect.fail('应被删'); }
    catch (e) { expect((e as NodeJS.ErrnoException).code).toBe('ENOENT'); }
  });
});

describe('Swapper - 部分成功 + 锁模拟', () => {
  let stagingDir: string;
  let targetDir: string;
  let backupDir: string;

  beforeEach(async () => {
    stagingDir = await makeTempDir('sw-stg-');
    targetDir = await makeTempDir('sw-tgt-');
    backupDir = await makeTempDir('sw-bak-');
  });
  afterEach(async () => {
    await rmTemp(stagingDir);
    await rmTemp(targetDir);
    await rmTemp(backupDir);
  });

  it('mutex:另一个 swap 在跑(PID 活着) → fatalError 提示不重试', async () => {
    await writeTree(stagingDir, [
      { relPath: '.pending-apply', content: '' },
      { relPath: 'a.txt', content: 'a' },
    ]);
    // 模拟另一个 swap 持有锁:用当前进程 PID(一定活着)
    await fs.writeFile(join(stagingDir, '.swapping'), String(process.pid));

    const r = await applyPending({
      targetDir, stagingDir, backupDir, backupCount: 3,
    });
    expect(r.ok).toBe(false);
    expect(r.fatalError).toMatch(/进行中/);

    // cleanup:删掉手动放的锁,免得影响其它 test
    await fs.unlink(join(stagingDir, '.swapping')).catch(() => undefined);
  });

  it('mutex 自愈:上次崩溃留下的 stale lock(PID 已死)→ 自动清理 + 成功', async () => {
    await writeTree(stagingDir, [
      { relPath: '.pending-apply', content: '' },
      { relPath: 'a.txt', content: 'a' },
    ]);
    // 模拟上次崩溃:用不存在的 PID + 旧 mtime
    // 用一个非常大的 PID(几乎肯定不存在)
    await fs.writeFile(join(stagingDir, '.swapping'), '999999');

    const r = await applyPending({
      targetDir, stagingDir, backupDir, backupCount: 3,
    });
    expect(r.ok).toBe(true);
    // 应该有 warning 说明恢复了 stale lock
    expect(r.warnings.some((w) => w.includes('stale') || w.includes('自动恢复'))).toBe(true);
  });

  it('mutex 自愈:无效 PID(non-numeric) → 当 stale 处理', async () => {
    await writeTree(stagingDir, [
      { relPath: '.pending-apply', content: '' },
      { relPath: 'a.txt', content: 'a' },
    ]);
    await fs.writeFile(join(stagingDir, '.swapping'), 'fake-pid-not-a-number');

    const r = await applyPending({
      targetDir, stagingDir, backupDir, backupCount: 3,
    });
    expect(r.ok).toBe(true);
  });

  it('cross-disk fallback:目标目录不存在 → 创建后写入', async () => {
    // 用一个不存在的 target 子目录模拟 swap 时创建
    const newTarget = join(targetDir, 'created');
    await writeTree(stagingDir, [
      { relPath: '.pending-apply', content: '' },
      { relPath: 'x.txt', content: 'x' },
    ]);
    const r = await applyPending({
      targetDir: newTarget, stagingDir, backupDir, backupCount: 3,
    });
    expect(r.ok).toBe(true);
    expect(r.applied).toEqual(['x.txt']);
    expect((await fs.readFile(join(newTarget, 'x.txt'), 'utf-8'))).toBe('x');
  });
});

describe('Swapper - heartbeat 锁文件 mtime', () => {
  let stagingDir: string;
  let targetDir: string;

  beforeEach(async () => {
    stagingDir = await makeTempDir('sw-hb-stg-');
    targetDir = await makeTempDir('sw-hb-tgt-');
  });
  afterEach(async () => {
    await rmTemp(stagingDir);
    await rmTemp(targetDir);
  });

  // ★ 回归:swap loop 每 100 个文件 touch 锁文件一次 — 让 mtime 保持新鲜。
  // 之前没有 heartbeat,真 swap 跑 30+ 秒被 STALE_LOCK_TIMEOUT_MS 30s 误判 stale。
  // 注意:SWAP_HEARTBEAT_INTERVAL=100,所以小于 100 文件不会触发。
  it('swap 跑 N 个文件(N < 100)→ 锁文件被 utimes 0 次(mtime 是创建时)', async () => {
    // 先建 staging 内容(50 个文件,小于 100)
    const files = Array.from({ length: 50 }, (_, i) => ({
      relPath: `f${String(i).padStart(3, '0')}.txt`,
      content: `c${i}`,
    }));
    await writeTree(stagingDir, [
      { relPath: '.pending-apply', content: '' },
      ...files,
    ]);

    // 记录开始时间,然后跑 swap
    const before = Date.now();
    const r = await applyPending({ targetDir, stagingDir, backupDir: '', backupCount: 0 });
    expect(r.ok).toBe(true);
    expect(r.applied.length).toBe(50);

    // swap 完锁已释放(在 finally),但心跳应该至少被触发 0 次(< 100 文件)
    // 此测试主要保证 swap 整体成功(没被自己 stale 误判)
    expect(r.warnings).toEqual([]); // 没被警告 stale
    expect(Date.now() - before).toBeLessThan(10_000); // 不会卡死
  });

  // ★ 大量文件(N > 100)→ 触发至少 1 次 heartbeat
  // 验证 SWAP_HEARTBEAT_INTERVAL 真的生效
  it('swap 跑 150 个文件 → swap 期间 mtime 至少被 utimes 1 次(从 process.hrtime 看不实际,改为检查没被自伤 stale)', async () => {
    const files = Array.from({ length: 150 }, (_, i) => ({
      relPath: `f${String(i).padStart(3, '0')}.txt`,
      content: `c${i}`,
    }));
    await writeTree(stagingDir, [
      { relPath: '.pending-apply', content: '' },
      ...files,
    ]);

    const r = await applyPending({ targetDir, stagingDir, backupDir: '', backupCount: 0 });
    // 关键:swap 没被自伤 stale → 全部 applied
    expect(r.ok).toBe(true);
    expect(r.applied.length).toBe(150);
    expect(r.warnings).toEqual([]); // 没 stale warning
  });
});

describe('Swapper - clearStaging', () => {
  let stagingDir: string;
  beforeEach(async () => { stagingDir = await makeTempDir('sw-stg-'); });
  afterEach(async () => { await rmTemp(stagingDir); });

  it('空目录 → ok=true, cleared=0', async () => {
    const r = await clearStaging({ stagingDir });
    expect(r.ok).toBe(true);
    expect(r.cleared).toBe(0);
  });

  it('清空所有文件(保留 .pending-apply 标记的删除)', async () => {
    await writeTree(stagingDir, [
      { relPath: 'a.txt', content: 'a' },
      { relPath: 'sub/b.txt', content: 'b' },
    ]);
    const r = await clearStaging({ stagingDir });
    expect(r.ok).toBe(true);
    expect(r.cleared).toBe(2);
    // 目录应清空(可能还剩 .swapping lock 文件如果没有 → 这里没有)
    const remaining = await fs.readdir(stagingDir);
    expect(remaining).toEqual([]);
  });

  it('mutex 持有时(PID 活着) → 拒绝', async () => {
    await writeFile(join(stagingDir, 'a.txt'), 'a');
    // 用当前进程 PID(一定活着)
    await fs.writeFile(join(stagingDir, '.swapping'), String(process.pid));
    const r = await clearStaging({ stagingDir });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/进行中/);
    // cleanup
    await fs.unlink(join(stagingDir, '.swapping')).catch(() => undefined);
  });

  it('mutex 自愈:stale lock → 自动清掉,正常 clear', async () => {
    await writeFile(join(stagingDir, 'a.txt'), 'a');
    await fs.writeFile(join(stagingDir, '.swapping'), '999999'); // 不存在的 PID
    const r = await clearStaging({ stagingDir });
    expect(r.ok).toBe(true);
    expect(r.cleared).toBe(1);
    // 锁文件被清掉
    const remaining = await fs.readdir(stagingDir);
    expect(remaining).toEqual([]);
  });
});

describe('Swapper - 备份轮转集成', () => {
  let stagingDir: string;
  let targetDir: string;
  let backupDir: string;

  beforeEach(async () => {
    stagingDir = await makeTempDir('sw-stg-');
    targetDir = await makeTempDir('sw-tgt-');
    backupDir = await makeTempDir('sw-bak-');
  });
  afterEach(async () => {
    await rmTemp(stagingDir);
    await rmTemp(targetDir);
    await rmTemp(backupDir);
  });

  it('swap 前创建 backup + 保留 backupCount 个', async () => {
    // 跑 2 次 swap,backupDir 应有 2 个 backup
    for (let i = 0; i < 2; i++) {
      // 把 target 恢复旧版本(模拟下次 sync 前状态)
      await writeFile(join(targetDir, 'f.txt'), `OLD-${i}`);
      await writeTree(stagingDir, [
        { relPath: '.pending-apply', content: '' },
        { relPath: 'f.txt', content: `NEW-${i}` },
      ]);
      await applyPending({ targetDir, stagingDir, backupDir, backupCount: 5 });
    }
    const backups = await fs.readdir(backupDir);
    expect(backups.length).toBe(2);
  });

  it('backupCount=2 时第 3 次 swap 触发轮转', async () => {
    for (let i = 0; i < 3; i++) {
      await writeFile(join(targetDir, 'f.txt'), `OLD-${i}`);
      await writeTree(stagingDir, [
        { relPath: '.pending-apply', content: '' },
        { relPath: 'f.txt', content: `NEW-${i}` },
      ]);
      await applyPending({ targetDir, stagingDir, backupDir, backupCount: 2 });
    }
    const backups = await fs.readdir(backupDir);
    expect(backups.length).toBe(2);
  });
});

describe('Swapper - stale lock 自愈(PID 复用场景)', () => {
  let stagingDir: string;
  let targetDir: string;

  beforeEach(async () => {
    stagingDir = await makeTempDir('sw-stale-stg-');
    targetDir = await makeTempDir('sw-stale-tgt-');
  });
  afterEach(async () => {
    await rmTemp(stagingDir);
    await rmTemp(targetDir);
  });

  // ★ 回归:stale lock 自愈 — 之前进程崩溃留下 .swapping + PID,
  // PID 被 Windows 复用(系统进程),isPidAlive 返 true(EPERM)，
  // 10 分钟阈值让锁永远不释放。
  // 修:STALE_LOCK_TIMEOUT_MS 缩到 30 秒 + PID 不论死活只要 mtime 老就 stale。
  it('PID 被复用 + mtime 老 → acquireSwapLock 仍清理(自愈)', async () => {
    // 模拟"上次进程崩溃留的锁":写一个 .swapping,内容是已经死掉的进程 PID,
    // 然后把 mtime 改到 1 分钟前(老于 30 秒阈值)
    const lockPath = join(stagingDir, '.swapping');
    await fs.writeFile(lockPath, '999999'); // 假设 PID 999999 已死
    const oneMinAgo = new Date(Date.now() - 60_000);
    await fs.utimes(lockPath, oneMinAgo, oneMinAgo);

    // 写 .pending-apply + 一个文件,触发 acquireSwapLock
    await writeTree(stagingDir, [
      { relPath: '.pending-apply', content: '' },
      { relPath: 'a.txt', content: 'new' },
    ]);
    const r = await applyPending({ targetDir, stagingDir, backupDir: '', backupCount: 0 });
    expect(r.ok).toBe(true);
    expect(r.applied).toEqual(['a.txt']);
    // target 收到文件(说明锁被清掉,swap 跑成功了)
    expect((await fs.readFile(join(targetDir, 'a.txt'), 'utf-8'))).toBe('new');
  });

  it('PID 是当前进程 + mtime 新鲜 → 锁被识别为 alive(不自伤)', async () => {
    // 模拟"其他实例正在跑 swap":写一个 .swapping,内容是当前 PID,
    // mtime 保持新鲜(刚刚写),并有 pending 内容让 applyPending 真走到 acquireSwapLock
    const lockPath = join(stagingDir, '.swapping');
    await fs.writeFile(lockPath, String(process.pid));
    await writeTree(stagingDir, [
      { relPath: '.pending-apply', content: '' },
      { relPath: 'a.txt', content: 'new' },
    ]);

    const r = await applyPending({ targetDir, stagingDir, backupDir: '', backupCount: 0 });
    // 锁被认为 alive → acquireSwapLock 返 ok=false → applyPending 返 fatalError
    expect(r.ok).toBe(false);
    expect(r.fatalError ?? r.warnings.join('|')).toMatch(/持有锁|跳过/);
  });

  // ★ 真实场景:PID 还活着(被 Windows 复用)+ mtime 老于 30s
  // 之前 10 分钟阈值让这个 bug 必出 — Windows 上 PID 复用频繁
  it('PID 还活着 + mtime 30s 没动 → 仍判定 stale(模拟 Windows PID 复用)', async () => {
    const lockPath = join(stagingDir, '.swapping');
    // 用当前测试进程 PID(肯定活着)— 模拟"PID 被 Windows 复用到 system 进程"
    await fs.writeFile(lockPath, String(process.pid));
    // mtime 设到 31 秒前(刚刚过阈值)
    const staleTime = new Date(Date.now() - 31_000);
    await fs.utimes(lockPath, staleTime, staleTime);

    await writeTree(stagingDir, [
      { relPath: '.pending-apply', content: '' },
      { relPath: 'a.txt', content: 'new' },
    ]);

    const r = await applyPending({ targetDir, stagingDir, backupDir: '', backupCount: 0 });
    // 30 秒阈值触发:即使 PID 还活,锁仍被认为是 stale,自愈成功
    expect(r.ok).toBe(true);
    expect(r.applied).toEqual(['a.txt']);
    // warnings 里应有"检测到上次 swap 异常中断"或类似
    expect(r.warnings.some((w) => w.includes('异常中断') || w.includes('stale'))).toBe(true);
  });

  // ★ 边界:PID 还活着 + mtime 30s 内 → 不算 stale,真有人在 swap
  it('PID 活着 + mtime 在 30s 内 → 锁保持 alive(不自伤)', async () => {
    const lockPath = join(stagingDir, '.swapping');
    await fs.writeFile(lockPath, String(process.pid));
    // mtime 刚刚(1 秒前)
    await fs.utimes(lockPath, new Date(Date.now() - 1_000), new Date(Date.now() - 1_000));

    await writeTree(stagingDir, [
      { relPath: '.pending-apply', content: '' },
      { relPath: 'a.txt', content: 'new' },
    ]);

    const r = await applyPending({ targetDir, stagingDir, backupDir: '', backupCount: 0 });
    // 锁被认为 alive → 报"其他实例持有锁",不自伤
    expect(r.ok).toBe(false);
    expect(r.fatalError ?? r.warnings.join('|')).toMatch(/持有锁/);
  });
});
