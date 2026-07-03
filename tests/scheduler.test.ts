/**
 * Scheduler 测试 - 验证间隔触发、运行锁、配置热更新、指数退避
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Scheduler, computeBackoff } from '../src/core/scheduler.js';
import { makeTempDir, rmTemp, writeTree, writeFile, wait } from './helpers.js';
import type { AppConfig, SyncResult } from '../src/core/types.js';

describe('Scheduler', () => {
  let sourceDir: string;
  let targetDir: string;
  let indexCachePath: string;
  let config: AppConfig;
  let results: SyncResult[];

  beforeEach(async () => {
    sourceDir = await makeTempDir('sch-src-');
    targetDir = await makeTempDir('sch-tgt-');
    indexCachePath = join(await makeTempDir('sch-cache-'), 'idx.json');
    config = {
      sourceDir,
      targetDir,
      intervalSec: 60, // 不会真的用到,因为我们用 runNow
      backupCount: 3,
      autostart: false,
      fileMappings: [],
      ignoreItems: [], applyMode: "immediate", stagingDir: "", executablePath: "",
      backupDir: '',
    };
    results = [];
  });

  afterEach(async () => {
    await rmTemp(sourceDir);
    await rmTemp(targetDir);
    await rmTemp(join(indexCachePath, '..'));
  });

  it('runNow 立即执行一次', async () => {
    await writeTree(sourceDir, [{ relPath: 'a.txt', content: 'a' }]);
    const sch = new Scheduler({ config, indexCachePath });
    const result = await sch.runNow();
    expect(result).not.toBeNull();
    expect(result!.ok).toBe(true);
    expect(result!.added).toEqual(['a.txt']);
  });

  it('调度器 start 立即跑一次,之后按 interval 触发', async () => {
    await writeTree(sourceDir, [{ relPath: 'a.txt', content: 'a' }]);
    const sch = new Scheduler({
      config: { ...config, intervalSec: 1 },
      indexCachePath,
      onSync: (r) => {
        results.push(r);
      },
    });
    sch.start();
    await wait(100); // 让首次跑完
    await writeTree(sourceDir, [{ relPath: 'b.txt', content: 'b' }]);
    await wait(1300); // 等下一次 tick
    await sch.stop();
    expect(results.length).toBeGreaterThanOrEqual(2);
  });

  it('inFlight 时 runNow 返回 null(不重叠)', async () => {
    await writeTree(sourceDir, [{ relPath: 'a.txt', content: 'a' }]);
    const sch = new Scheduler({ config, indexCachePath });
    // 同步启动第一次(还在跑),立即再请求一次
    const p1 = sch.runNow();
    const p2 = sch.runNow();
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).not.toBeNull();
    expect(r2).toBeNull();
  });

  // ★ 回归:runNow({ force: true }) 在 in-flight 时不再立刻返 null
  // 否则场景:调度器周期跑了一半时点"保存并立即同步"→ 返 null → 看似不同步
  it('runNow({ force: true }) 等 in-flight 完成后真同步', async () => {
    await writeTree(sourceDir, [{ relPath: 'a.txt', content: 'a' }]);
    const sch = new Scheduler({ config, indexCachePath });
    // 第一次启动(还在跑)
    const p1 = sch.runNow();
    // 立刻发起 force
    const p2 = sch.runNow({ force: true });
    const [r1, r2] = await Promise.all([p1, p2]);
    // 两个都应该返回结果(force 等了一会儿)
    expect(r1).not.toBeNull();
    expect(r2).not.toBeNull();
    // force 后再次写入 source 再 force 一轮,验证 target 落盘了
    await writeTree(sourceDir, [
      { relPath: 'a.txt', content: 'a' },
      { relPath: 'force-only.txt', content: 'force' },
    ]);
    const r3 = await sch.runNow({ force: true });
    expect(r3!.added).toContain('force-only.txt');
    expect(existsSync(join(targetDir, 'force-only.txt'))).toBe(true);
  });

  // ★ 回归:runNow 不带 force + in-flight → 仍然返 null(不破坏原行为)
  it('runNow() 非 force 时 in-flight 仍返 null', async () => {
    await writeTree(sourceDir, [{ relPath: 'a.txt', content: 'a' }]);
    const sch = new Scheduler({ config, indexCachePath });
    const p1 = sch.runNow();
    const p2 = sch.runNow();
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).not.toBeNull();
    expect(r2).toBeNull();
  });

  it('stop 后不再触发', async () => {
    await writeTree(sourceDir, [{ relPath: 'a.txt', content: 'a' }]);
    const sch = new Scheduler({
      config: { ...config, intervalSec: 1 },
      indexCachePath,
      onSync: (r) => {
        results.push(r);
      },
    });
    sch.start();
    await wait(50);
    await sch.stop();
    const count = results.length;
    await wait(1300);
    expect(results.length).toBe(count);
  });

  // 回归:远程"立即同步"在弹窗模式下应该真删,而不是只算 diff
  // (修复前:dryRun 模式吞了 delete,history 写了 deletedCount=1,但 target 里文件还在)
  it('runNow({ force: true }) 在 dryRun 模式下也会真删文件', async () => {
    await writeTree(sourceDir, [{ relPath: 'a.txt', content: 'a' }]);
    const sch = new Scheduler({ config, indexCachePath });
    sch.setDryRunMode(true); // 模拟 popupEnabled=true

    // 首次 dryRun 同步:diff 出来(在 dryRun 下,这次同步把 a.txt 拷到 target,
    // 因为 syncer 的 ADD/MODIFY/DELETE 都受 dryRun 影响,但文件映射不受 dryRun 影响;
    // 这里没有 mapping,所以 target 不会有 a.txt)
    await sch.runNow();

    // 让 a.txt 已经在 target(用真实拷贝,模拟首次非 dryRun 同步的状态)
    await writeFile(join(targetDir, 'a.txt'), 'a');
    await sch.runNow(); // dryRun:added 不算(target 已有 a.txt),正常 → unchanged=1

    // 源里删除 a.txt
    await fs.unlink(join(sourceDir, 'a.txt'));

    // 不带 force:dryRun 跑一次 → diff 算出来 deleted=['a.txt'],但 target 里不动
    const r1 = await sch.runNow();
    expect(r1!.deleted).toEqual(['a.txt']);
    expect(existsSync(join(targetDir, 'a.txt'))).toBe(true);

    // 带 force:真删(修复点)
    const r2 = await sch.runNow({ force: true });
    expect(r2!.deleted).toEqual(['a.txt']);
    expect(existsSync(join(targetDir, 'a.txt'))).toBe(false);
  });

  it('runNow({ force: true }) 跑完恢复 dryRunMode', async () => {
    const sch = new Scheduler({ config, indexCachePath });
    sch.setDryRunMode(true); // dryRun

    // force 跑一次:过程中临时 false,跑完必须还原
    await writeTree(sourceDir, [{ relPath: 'x.txt', content: 'x' }]);
    await sch.runNow({ force: true });
    expect(existsSync(join(targetDir, 'x.txt'))).toBe(true);

    // 再跑一次普通 runNow:必须仍是 dryRun(只 diff 不动盘)
    await writeTree(sourceDir, [
      { relPath: 'x.txt', content: 'x' },
      { relPath: 'y.txt', content: 'y' },
    ]);
    await fs.unlink(join(targetDir, 'x.txt')).catch(() => undefined);
    await sch.runNow();
    // dryRun:y.txt 算 added 但不会真拷,x.txt 算 added(target 已删)也不会真拷
    expect(existsSync(join(targetDir, 'y.txt'))).toBe(false);
  });

  // ★ 回归:staging 模式 + executablePath + runNow 触发时 staging 是空的
  // 此前问题:swap 一直没机会跑(平时 dryRun 不写 staging),launch 直接起 target/ 里老版本
  // 现在:runNow 走完 sync → step2.5 检测到 pending → swap → launch 启动新版本
  it('staging 模式:runNow 完成 sync 后,launch 之前先 swap staging', async () => {
    const launchSpy = vi.spyOn(
      await import('../src/core/launcher.js'),
      'tryLaunchExecutable',
    );

    const cfg: AppConfig = {
      ...config,
      applyMode: 'staging',
      executablePath: 'Game/Game.exe',
    };

    // source 有 Game.exe(v2)+ 别的文件
    await writeTree(sourceDir, [
      { relPath: 'Game/Game.exe', content: 'v2-new' },
      { relPath: 'readme.txt', content: 'r2' },
    ]);

    // Mock launch 防止真启动 bat/sh
    launchSpy.mockResolvedValue({ launched: true, pid: 99999 });

    const sch = new Scheduler({ config: cfg, indexCachePath });

    // ★ 关键场景:第一次 runNow 没有任何 pending 在 staging 里
    //   step1:hasPendingApply=false → 不 swap
    //   step2:scan + write staging(pendingApplyCount=2)
    //   step2.5:★ 修复后,本次有 pending 触发 swap → staging 清空,target 收到 v2
    //   step3:launch 启动时 target 里已是 v2
    const r = await sch.runNow();

    // 两次现象:
    // - target 收到 Game.exe(v2)
    expect(existsSync(join(cfg.targetDir, 'Game', 'Game.exe'))).toBe(true);
    const targetContent = await fs.readFile(
      join(cfg.targetDir, 'Game', 'Game.exe'),
      'utf-8',
    );
    expect(targetContent).toBe('v2-new');
    // - staging 已清空(说明 swap 跑过)
    const stagingDir = cfg.stagingDir || `${cfg.targetDir}-staging`;
    const remaining = await fs.readdir(stagingDir).catch(() => []);
    expect(remaining.filter((n) => !n.startsWith('.'))).toEqual([]);
    // - launch 必然被调用
    expect(launchSpy).toHaveBeenCalled();
    // - 结果同步成功 + 启动成功
    expect(r?.ok).toBe(true);
    expect(r?.launchedPid).toBe(99999);

    launchSpy.mockRestore();
  });
});

describe('Scheduler - 指数退避', () => {
  let sourceDir: string;
  let targetDir: string;
  let indexCachePath: string;

  beforeEach(async () => {
    sourceDir = await makeTempDir('sch-bkoff-src-');
    targetDir = await makeTempDir('sch-bkoff-tgt-');
    indexCachePath = join(await makeTempDir('sch-bkoff-cache-'), 'idx.json');
  });

  afterEach(async () => {
    await rmTemp(sourceDir);
    await rmTemp(targetDir);
    await rmTemp(join(indexCachePath, '..'));
  });

  it('computeBackoff:第 1 次失败不超过 base', () => {
    const delay = computeBackoff(60_000, 1);
    expect(delay).toBeGreaterThanOrEqual(0);
    expect(delay).toBeLessThanOrEqual(60_000);
  });

  it('computeBackoff:第 2 次失败不超过 2x base', () => {
    const delay = computeBackoff(60_000, 2);
    expect(delay).toBeGreaterThanOrEqual(0);
    expect(delay).toBeLessThanOrEqual(120_000);
  });

  it('computeBackoff:连续失败上限 5 分钟', () => {
    const delay = computeBackoff(60_000, 20); // 20 次后早就 cap 了
    expect(delay).toBeLessThanOrEqual(5 * 60 * 1000);
  });

  it('computeBackoff:n<=0 返回 base', () => {
    expect(computeBackoff(60_000, 0)).toBe(60_000);
    expect(computeBackoff(60_000, -1)).toBe(60_000);
  });

  it('网络类失败 → 退避递增(可观测:nextRunDelayMs 单调不降)', async () => {
    // source 是网络路径 + 不存在 → 每次都是 network-not-found
    const cfg: AppConfig = {
      sourceDir: '\\\\nonexistent-server\\share',
      targetDir,
      intervalSec: 60,
      backupCount: 3,
      autostart: false,
      fileMappings: [],
      ignoreItems: [], applyMode: "immediate", stagingDir: "", executablePath: "",
      backupDir: '',
    };
    const sch = new Scheduler({ config: cfg, indexCachePath });

    const r1 = await sch.runNow();
    expect(r1).not.toBeNull();
    expect(r1!.ok).toBe(false);
    expect(r1!.fatalReason).toBe('network-not-found');

    const s1 = sch.getStatus();
    expect(s1.consecutiveNetworkFailures).toBe(1);
    expect(s1.consecutiveFailures).toBe(1);

    // runNow 后,老 timer 已被清理,新 timer 已排程(nextRunDelayMs 不为 null)
    expect(s1.nextRunDelayMs).not.toBeNull();
    // 退避在 [0, 60s] 范围内
    expect(s1.nextRunDelayMs).toBeLessThanOrEqual(60_000);

    // 第二次失败
    await wait(10);
    const r2 = await sch.runNow();
    expect(r2!.fatalReason).toBe('network-not-found');
    const s2 = sch.getStatus();
    expect(s2.consecutiveNetworkFailures).toBe(2);
    // 第二次退避期望上限翻倍
    expect(s2.nextRunDelayMs).toBeLessThanOrEqual(120_000);

    // 第三次
    const r3 = await sch.runNow();
    expect(r3!.fatalReason).toBe('network-not-found');
    const s3 = sch.getStatus();
    expect(s3.consecutiveNetworkFailures).toBe(3);
    expect(s3.nextRunDelayMs).toBeLessThanOrEqual(240_000);
  });

  it('成功一次 → 网络失败计数重置', async () => {
    // 先用坏 source 跑 2 次
    const badCfg: AppConfig = {
      sourceDir: '\\\\nonexistent\\share',
      targetDir,
      intervalSec: 60,
      backupCount: 3,
      autostart: false,
      fileMappings: [],
      ignoreItems: [], applyMode: "immediate", stagingDir: "", executablePath: "",
      backupDir: '',
    };
    const sch = new Scheduler({ config: badCfg, indexCachePath });
    await sch.runNow();
    await sch.runNow();
    expect(sch.getStatus().consecutiveNetworkFailures).toBe(2);

    // 换成好 source 跑一次
    await writeTree(sourceDir, [{ relPath: 'a.txt', content: 'a' }]);
    sch.updateConfig({ ...badCfg, sourceDir });
    const rOk = await sch.runNow();
    expect(rOk!.ok).toBe(true);

    const s = sch.getStatus();
    expect(s.consecutiveNetworkFailures).toBe(0);
    expect(s.consecutiveFailures).toBe(0);
    expect(s.nextRunDelayMs).toBe(60_000); // 回到 base interval
  });

  it('非网络 fatal → 走原 interval,不计网络失败', async () => {
    // 本地路径不存在 → not-found(非网络)
    const cfg: AppConfig = {
      sourceDir: 'D:/this-path-definitely-does-not-exist-12345',
      targetDir,
      intervalSec: 60,
      backupCount: 3,
      autostart: false,
      fileMappings: [],
      ignoreItems: [], applyMode: "immediate", stagingDir: "", executablePath: "",
      backupDir: '',
    };
    const sch = new Scheduler({ config: cfg, indexCachePath });
    const r = await sch.runNow();
    expect(r!.ok).toBe(false);
    expect(r!.fatalReason).toBe('not-found');

    const s = sch.getStatus();
    expect(s.consecutiveFailures).toBe(1);
    expect(s.consecutiveNetworkFailures).toBe(0);
    expect(s.nextRunDelayMs).toBe(60_000); // 走正常 interval
  });

  it('lastFatalReason 反映最近一次 fatal', async () => {
    const cfg: AppConfig = {
      sourceDir: 'D:/this-path-does-not-exist',
      targetDir,
      intervalSec: 60,
      backupCount: 3,
      autostart: false,
      fileMappings: [],
      ignoreItems: [], applyMode: "immediate", stagingDir: "", executablePath: "",
      backupDir: '',
    };
    const sch = new Scheduler({ config: cfg, indexCachePath });
    await sch.runNow();
    expect(sch.getStatus().lastFatalReason).toBe('not-found');

    // 换网络错
    sch.updateConfig({ ...cfg, sourceDir: '\\\\nonexistent\\share' });
    await sch.runNow();
    expect(sch.getStatus().lastFatalReason).toBe('network-not-found');
  });
});
