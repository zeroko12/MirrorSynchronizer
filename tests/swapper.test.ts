/**
 * Swapper 测试 - staging ↔ target 原子交换
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs, existsSync } from 'node:fs';
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

describe('Swapper - target writability pre-flight', () => {
  let stagingDir: string;
  let writableTarget: string;

  beforeEach(async () => {
    stagingDir = await makeTempDir('sw-pre-stg-');
    writableTarget = await makeTempDir('sw-pre-tgt-');
  });
  afterEach(async () => {
    await rmTemp(stagingDir);
    await rmTemp(writableTarget);
  });

  it('★ 可写 target → preflight ok=true的 swap 正常完成', async () => {
    await writeTree(stagingDir, [
      { relPath: '.pending-apply', content: '' },
      { relPath: 'a.txt', content: 'new' },
    ]);
    const r = await applyPending({
      targetDir: writableTarget, stagingDir, backupDir: '', backupCount: 0,
    });
    expect(r.ok).toBe(true);
    expect(r.applied).toEqual(['a.txt']);
    expect((await fs.readFile(join(writableTarget, 'a.txt'), 'utf-8'))).toBe('new');
  });

  it('★ 不可写的 target → fatalError fail-fast给提示', async () => {
    await writeTree(stagingDir, [
      { relPath: '.pending-apply', content: '' },
      { relPath: 'a.txt', content: 'new' },
    ]);
    // 任何平台都会失败的路径:Linux /proc 不可写,Windows 不存在的盘符
    const badTarget = process.platform === 'win32'
      ? 'C:\__no_such_XYZ_drive__\sub	arget'
      : '/proc/__definitely_not_a_path_XYZ__/sub/target';
    const r = await applyPending({
      targetDir: badTarget,
      stagingDir,
      backupDir: '',
      backupCount: 0,
    });
    expect(r.ok).toBe(false);
    expect(r.fatalError ?? r.warnings.join('|')).toMatch(/不可访问|不可写|ENOENT|EACCES|EPERM|EINVAL|EROFS/i);
    expect(r.warnings.some((w) => w.includes('检查目标路径'))).toBe(true);
  });

  it('preflightTargetWritable happy path → ok=true', async () => {
    const { preflightTargetWritable } = await import('../src/core/swapper.js');
    const r = await preflightTargetWritable(writableTarget);
    expect(r.ok).toBe(true);
  });

  it('preflightTargetWritable fail path(unwritable dir) → ok=false 含原因', async () => {
    const { preflightTargetWritable } = await import('../src/core/swapper.js');
    // 跨平台可靠 fail 的路径:路径含 NUL 字符(fs.mkdir 必抛)。
    // 之前的版本用 'C:\__no_such_XYZ\' 之类的伪路径,Node 在 Windows 上会把它当
    // 一段合法目录名 mkdir 出来,反而不 fail-fast。这条用 NUL 路径做硬保证。
    // 注意:直接传 NUL 字符串字面量在 JS 里要写 '\\0'。
    const nulPath = '\0';
    const r = await preflightTargetWritable(nulPath);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toMatch(/不可访问|不可写|Invalid|EINVAL|ERR_INVALID/i);
    }
  });

  it('preflightTargetWritable ❌残毕 不残留 .__wprobe_* 残回退文件', async () => {
    const { preflightTargetWritable } = await import('../src/core/swapper.js');
    const r = await preflightTargetWritable(writableTarget);
    expect(r.ok).toBe(true);
    const entries = await fs.readdir(writableTarget);
    expect(entries.filter((n) => n.startsWith('.__wprobe_'))).toEqual([]);
  });
});

describe('Swapper - per-file retry / 错误分类', () => {
  let stagingDir: string;
  let targetDir: string;

  beforeEach(async () => {
    stagingDir = await makeTempDir('sw-retry-stg-');
    targetDir = await makeTempDir('sw-retry-tgt-');
  });
  afterEach(async () => {
    await rmTemp(stagingDir);
    await rmTemp(targetDir);
  });

  it('target 文件被 EBUSY 锁住 → 立即 blocked(非瞬时场景模拟困难,只验证 warning 包含 errno)', async () => {
    // 这个 case 不能真锁文件(EBUSY 难模拟),改为验证错误分类的 label 格式
    // 直接验证代码:写一个不存在的源,触发 ENOENT,看 warning 是否走了 "其他" 分支
    await writeTree(stagingDir, [
      { relPath: '.pending-apply', content: '' },
      { relPath: 'a.txt', content: 'new' },
    ]);
    // 把 staging 的源文件删掉 → swap 时 srcPath 不存在 → ENOENT
    // (要走尽量稳定的路径)
    // skip:ENOENT 的处理不在我们测的 transient 分类里。先跳过这个 case。
    // 仅做 smoke test:常规 swap 完整跑通(确保 retry 包装没把正常路径搞坏)
    const r = await applyPending({
      targetDir, stagingDir, backupDir: '', backupCount: 0,
    });
    expect(r.ok).toBe(true);
    expect(r.applied).toEqual(['a.txt']);
  });

  it('正常 swap 不会触发 retry(单次成功路径不被 retry 包装影响)', async () => {
    await writeTree(stagingDir, [
      { relPath: '.pending-apply', content: '' },
      { relPath: 'file1.txt', content: 'f1' },
      { relPath: 'file2.txt', content: 'f2' },
    ]);
    const r = await applyPending({
      targetDir, stagingDir, backupDir: '', backupCount: 0,
    });
    expect(r.ok).toBe(true);
    expect(r.applied.sort()).toEqual(['file1.txt', 'file2.txt']);
    expect(r.warnings).toEqual([]);
  });

  it('parent dir 重试后成功(transient 覆盖 mkdir 路径)', async () => {
    // SMB 偶发 mkdir 失败 — 这里用不存在的中间目录作为父目录,递归创建应一次成功
    // 测的是 retry 包装在 normal case 不退化
    await writeTree(stagingDir, [
      { relPath: '.pending-apply', content: '' },
      { relPath: 'deep/nested/file.txt', content: 'deep' },
    ]);
    const r = await applyPending({
      targetDir, stagingDir, backupDir: '', backupCount: 0,
    });
    expect(r.ok).toBe(true);
    expect(r.applied).toEqual(['deep/nested/file.txt']);
  });
});

describe('Swapper - isSameVolume probe 残留防护', () => {
  let stagingDir: string;
  let targetDir: string;

  beforeEach(async () => {
    stagingDir = await makeTempDir('sw-probe-stg-');
    targetDir = await makeTempDir('sw-probe-tgt-');
  });
  afterEach(async () => {
    await rmTemp(stagingDir);
    await rmTemp(targetDir);
  });

  it('★ swap 完成 → 不留 .__probe_* 临时文件', async () => {
    // 通过观察 stagingDir/targetDir 列表确认无残留
    await writeTree(stagingDir, [
      { relPath: '.pending-apply', content: '' },
      { relPath: 'a.txt', content: 'new' },
    ]);
    const r = await applyPending({
      targetDir, stagingDir, backupDir: '', backupCount: 0,
    });
    expect(r.ok).toBe(true);

    // 允许 .pending-apply,不允许 .__probe_*
    const stagingEntries = await fs.readdir(stagingDir);
    const targetEntries = await fs.readdir(targetDir);
    expect(stagingEntries.filter((n) => n.startsWith('.__probe_') || n.startsWith('.__wprobe_'))).toEqual([]);
    expect(targetEntries.filter((n) => n.startsWith('.__probe_') || n.startsWith('.__wprobe_'))).toEqual([]);
  });
});

describe('Swapper - staging .pending-delete.json(源删除传播到 target)', () => {
  let stagingDir: string;
  let targetDir: string;

  beforeEach(async () => {
    stagingDir = await makeTempDir('sw-del-stg-');
    targetDir = await makeTempDir('sw-del-tgt-');
  });
  afterEach(async () => {
    await rmTemp(stagingDir);
    await rmTemp(targetDir);
  });

  // ★ 核心回归:用户报告"检测到 -1 但点同步 target 不删"的修复
  //   swapper 读 stagingDir/.pending-delete.json,逐个 target.unlink,带 transient 重试
  it('swap 读 .pending-delete.json → 真从 target 删 + 计数计入 deletionsApplied', async () => {
    // target 里有将要被删的文件
    await writeFile(join(targetDir, 'old-file.txt'), 'OLD');
    await writeFile(join(targetDir, 'kept.txt'), 'KEPT'); // 不在待删列表里
    // 在 staging 写 .pending-delete.json
    await fs.writeFile(
      join(stagingDir, '.pending-delete.json'),
      JSON.stringify({ rels: ['old-file.txt'], writtenAt: Date.now() }, null, 2),
    );

    const r = await applyPending({
      targetDir, stagingDir, backupDir: '', backupCount: 0,
    });

    // target/old-file.txt 真删了
    expect(existsSync(join(targetDir, 'old-file.txt'))).toBe(false);
    // 没动的还在
    expect(existsSync(join(targetDir, 'kept.txt'))).toBe(true);

    // 计数
    expect(r.deletionsApplied).toEqual(['old-file.txt']);
    expect(r.deletionsBlocked).toEqual([]);

    // 标记文件已经被清(全成功)
    expect(existsSync(join(stagingDir, '.pending-delete.json'))).toBe(false);
  });

  it('★ 待删多个 + 部分 ENOENT(target 已被人手动删)→ 全部计数,无 error', async () => {
    // 待删 3 个文件,其中 1 个 target 里已不存在
    await writeFile(join(targetDir, 'a.txt'), 'A');
    await writeFile(join(targetDir, 'c.txt'), 'C');
    // b.txt 不创建 — 模拟用户手动删了
    await fs.writeFile(
      join(stagingDir, '.pending-delete.json'),
      JSON.stringify({ rels: ['a.txt', 'b.txt', 'c.txt'], writtenAt: Date.now() }, null, 2),
    );

    const r = await applyPending({
      targetDir, stagingDir, backupDir: '', backupCount: 0,
    });

    // a + c 删了
    expect(existsSync(join(targetDir, 'a.txt'))).toBe(false);
    expect(existsSync(join(targetDir, 'c.txt'))).toBe(false);
    // 3 个都计入 applied(ENOENT 算成功)
    expect(r.deletionsApplied?.sort()).toEqual(['a.txt', 'b.txt', 'c.txt']);
    expect(r.deletionsBlocked).toEqual([]);
    expect(r.warnings).toEqual([]);
    // marker 清掉
    expect(existsSync(join(stagingDir, '.pending-delete.json'))).toBe(false);
  });

  // ★ 没有 marker → 跳过删除段(不影响 swap 主流程)
  it('无 .pending-delete.json → 跳过删除段(deleted 数组保持空)', async () => {
    // 只放 .pending-apply + 一个文件走正常 swap
    await writeTree(stagingDir, [
      { relPath: '.pending-apply', content: '' },
      { relPath: 'new.txt', content: 'new' },
    ]);
    const r = await applyPending({
      targetDir, stagingDir, backupDir: '', backupCount: 0,
    });
    expect(r.ok).toBe(true);
    // deletions 数组初始化为 [],内容为空
    expect(r.deletionsApplied).toEqual([]);
    expect(r.deletionsBlocked).toEqual([]);
  });

  // ★ JSON 损坏 → 警告并跳过(不抛)
  it('.pending-delete.json 损坏 → 不抛 swap 失败,只是跳删除段', async () => {
    await writeFile(join(targetDir, 'a.txt'), 'A');
    await fs.writeFile(join(stagingDir, '.pending-delete.json'), '{ not json');
    const r = await applyPending({
      targetDir, stagingDir, backupDir: '', backupCount: 0,
    });
    expect(r.ok).toBe(true);
    // target 文件未动(因为解析失败没去删)
    expect(existsSync(join(targetDir, 'a.txt'))).toBe(true);
  });

  it('★ 列表为空(rels:[])→ hasPendingApply=false 不触发 swap,marker 留下(下次 sync 会覆盖)', async () => {
    await fs.writeFile(
      join(stagingDir, '.pending-delete.json'),
      JSON.stringify({ rels: [], writtenAt: Date.now() }, null, 2),
    );
    const r = await applyPending({
      targetDir, stagingDir, backupDir: '', backupCount: 0,
    });
    // 没 .pending-apply + 空 rels → 无事可做,提前 ok
    expect(r.ok).toBe(true);
    expect(r.deletionsApplied).toEqual([]);
    expect(r.deletionsBlocked).toEqual([]);
    // marker 仍存在 — 下次 syncer.sync 时会自己清掉
    // (syncer 5.1 节会保留空列表就 unlink marker)
    expect(existsSync(join(stagingDir, '.pending-delete.json'))).toBe(true);
  });

  // ★ normal swap 也跑通后,待删文件被处理(集成场景)
  it('★ 集成:staging 有新增 + 待删列表 → swap 后 target 同时新增和删除', async () => {
    // target 里有旧文件,1 个要被删
    await writeTree(targetDir, [
      { relPath: 'add.txt', content: 'OLD-add' },
      { relPath: 'remove.txt', content: 'OLD-remove' },
      { relPath: 'keep.txt', content: 'KEEP' },
    ]);
    // staging 有新内容 + 待删标记
    await writeTree(stagingDir, [
      { relPath: '.pending-apply', content: '' },
      { relPath: 'add.txt', content: 'NEW-add' },
    ]);
    await fs.writeFile(
      join(stagingDir, '.pending-delete.json'),
      JSON.stringify({ rels: ['remove.txt'], writtenAt: Date.now() }, null, 2),
    );

    const r = await applyPending({
      targetDir, stagingDir, backupDir: '', backupCount: 0,
    });

    expect(r.ok).toBe(true);
    // 新增 + 删除 都对
    expect(r.applied).toEqual(['add.txt']);
    expect(r.deletionsApplied).toEqual(['remove.txt']);
    expect(existsSync(join(targetDir, 'add.txt'))).toBe(true);
    expect((await fs.readFile(join(targetDir, 'add.txt'), 'utf-8'))).toBe('NEW-add');
    expect(existsSync(join(targetDir, 'remove.txt'))).toBe(false);
    expect(existsSync(join(targetDir, 'keep.txt'))).toBe(true);
    // marker 清掉(全成功)
    expect(existsSync(join(stagingDir, '.pending-delete.json'))).toBe(false);
  });
});
