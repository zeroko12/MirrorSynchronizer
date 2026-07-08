/**
 * user-decision service 单元测试
 *
 * 验证三种 action 的处理逻辑
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleUserDecision } from '../src/main/services/user-decision.js';
import { StateManager } from '../src/core/state.js';
import { Scheduler } from '../src/core/scheduler.js';
import { makeTempDir, writeFile } from './helpers.js';
import type { AppConfig } from '../src/core/types.js';

describe('user-decision', () => {
  let statePath: string;
  let stateMgr: StateManager;
  let scheduler: Scheduler | null;
  let config: AppConfig;
  let sourceDir: string;
  let targetDir: string;
  let indexCachePath: string;

  beforeEach(async () => {
    const dir = await makeTempDir('user-dec-');
    statePath = `${dir}/state.json`;
    sourceDir = await makeTempDir('user-dec-src-');
    targetDir = await makeTempDir('user-dec-tgt-');
    indexCachePath = `${dir}/idx.json`;
    stateMgr = new StateManager(statePath);
    await stateMgr.load();
    config = {
      sourceDir,
      targetDir,
      intervalSec: 60,
      backupCount: 3,
      autostart: false,
      fileMappings: [],
      ignoreItems: [], applyMode: "immediate", stagingDir: "", executablePath: "",
      backupDir: '',
    };
    scheduler = new Scheduler({ config, indexCachePath });
  });

  describe('snooze', () => {
    it('snooze → state.snoozeUntil 在未来', async () => {
      const before = Date.now();
      await handleUserDecision(stateMgr, scheduler, 'snooze', 'hash-1');
      const state = await stateMgr.load();
      expect(state.snoozeUntil).toBeGreaterThan(before);
      expect(state.snoozeUntil).toBeGreaterThanOrEqual(before + 5 * 60 * 1000);
      // lastShownChangeHash 也应被更新
      expect(state.lastShownChangeHash).toBe('hash-1');
    });

    it('snooze 不调 scheduler.runNow', async () => {
      const spy = vi.spyOn(scheduler!, 'runNow');
      await handleUserDecision(stateMgr, scheduler, 'snooze', 'hash-1');
      expect(spy).not.toHaveBeenCalled();
    });
  });

  describe('ignore', () => {
    it('ignore → 只更新 lastShownChangeHash,不触发同步', async () => {
      const spy = vi.spyOn(scheduler!, 'runNow');
      await handleUserDecision(stateMgr, scheduler, 'ignore', 'hash-2');
      const state = await stateMgr.load();
      expect(state.lastShownChangeHash).toBe('hash-2');
      expect(spy).not.toHaveBeenCalled();
    });
  });

  describe('apply', () => {
    it('apply → 关闭 dryRun,跑一次 runNow({ force: true }),再恢复', async () => {
      // 准备:source 有文件,target 空 → 跑会添加
      await writeFile(`${sourceDir}/hello.txt`, 'hi');
      const spy = vi.spyOn(scheduler!, 'runNow').mockResolvedValue({
        startedAt: Date.now(),
        durationMs: 0,
        ok: true,
        added: ['hello.txt'],
        modified: [],
        deleted: [],
        mappingCopied: [],
        mappingSkippedExisting: [],
        mappingSkipped: [],
        mappingFailed: [],
        unchanged: 0,
        warnings: [],
        backupCreated: false,
      });

      // 初始 dryRunMode 是 false
      expect((scheduler as Scheduler)['dryRunMode']).toBe(false);
      await handleUserDecision(stateMgr, scheduler, 'apply', 'hash-3');
      // 验证:runNow 必须传 force=true(让等 in-flight + 让 launch 守卫启用)
      expect(spy).toHaveBeenCalledOnce();
      expect(spy).toHaveBeenCalledWith({ force: true });
    });

    it('apply 在回退锁状态 → 先解锁', async () => {
      await stateMgr.lockPostRollback('2026-06-17T12-00-00-000Z', 99);
      vi.spyOn(scheduler!, 'runNow').mockResolvedValue(null);
      await handleUserDecision(stateMgr, scheduler, 'apply', 'hash-4');
      const state = await stateMgr.load();
      expect(state.postRollbackLock).toBeNull();
    });

    // ★ 回归:apply 路径必须把 sync 真实结果透传(不能总返 {ok:true})
    // 之前:user:decide IPC 总是返 {ok:true} → 渲染端看到"已同步"成功 toast
    //   即使 target 仍然被锁
    // 现在:handleUserDecision 返 {result, state} → IPC handler 读 result.ok
    it('apply + sync 成功 → 返 result.ok=true', async () => {
      const successResult = {
        startedAt: 0,
        durationMs: 0,
        ok: true,
        added: ['a.txt'],
        modified: [],
        deleted: [],
        mappingCopied: [],
        mappingSkippedExisting: [],
        mappingSkipped: [],
        mappingFailed: [],
        unchanged: 0,
        warnings: [],
        backupCreated: false,
      };
      vi.spyOn(scheduler!, 'runNow').mockResolvedValue(successResult as any);
      const ret = await handleUserDecision(stateMgr, scheduler, 'apply', 'hash-ok');
      expect(ret.result?.ok).toBe(true);
    });

    it('apply + precheck 锁失败 → 返 result.ok=false + fatalReason=target-locked', async () => {
      // 模拟 applyMode='immediate-with-precheck' 锁住
      const lockedResult = {
        startedAt: 0,
        durationMs: 0,
        ok: false,
        added: ['a.txt'],
        modified: [],
        deleted: [],
        mappingCopied: [],
        mappingSkippedExisting: [],
        mappingSkipped: [],
        mappingFailed: [],
        unchanged: 0,
        warnings: ['目标文件被占用 (EBUSY): a.txt。...'],
        backupCreated: false,
        fatalError: '目标文件被占用 (EBUSY): a.txt',
        fatalReason: 'target-locked',
        fatalTarget: 'target',
      };
      vi.spyOn(scheduler!, 'runNow').mockResolvedValue(lockedResult as any);
      const ret = await handleUserDecision(stateMgr, scheduler, 'apply', 'hash-locked');
      expect(ret.result?.ok).toBe(false);
      expect(ret.result?.fatalReason).toBe('target-locked');
    });

    it('apply + scheduler=null → 返 result=null(无 sync 跑过)', async () => {
      // scheduler 是 null,无法跑 sync
      const ret = await handleUserDecision(stateMgr, null, 'apply', 'hash-noop');
      expect(ret.result).toBeNull();
    });

    it('apply + runNow 返 null → 返 result=null(无错误,但也无 ok)', async () => {
      vi.spyOn(scheduler!, 'runNow').mockResolvedValue(null);
      const ret = await handleUserDecision(stateMgr, scheduler, 'apply', 'hash-null');
      expect(ret.result).toBeNull();
    });

    // ★ 回归:apply 不再"提前"写 lastShownChangeHash
    // 之前:handleUserDecision('apply', hash) 在调用 runNow() 之前就写 hash
    //       → sync 真正落地后如果 fp 没变 → 已被 hash 吃掉 → 下次 sync 静默 already-shown
    //       → 用户感受:"我点了应用但啥都没发生,下次还不弹框"
    // 现在:apply 成功/失败都不主动写 hash,等 sync 自然推进 onSync 决定
    it('apply 不提前写 lastShownChangeHash(避免未成功 sync 的 fp 被吃)', async () => {
      vi.spyOn(scheduler!, 'runNow').mockResolvedValue(null);
      await handleUserDecision(stateMgr, scheduler, 'apply', 'hash-presync');
      const state = await stateMgr.load();
      // 关键:还是默认 null,没有把"同步前的 hash"吃进去
      expect(state.lastShownChangeHash).toBeNull();
    });
  });

  describe('null 依赖', () => {
    it('stateMgr 为 null → 不抛,返 null result', async () => {
      const ret = await handleUserDecision(null, null, 'snooze', 'h');
      expect(ret).toEqual({ result: null, state: null });
    });

    it('scheduler 为 null + snooze → 仍更新 state', async () => {
      await handleUserDecision(stateMgr, null, 'snooze', 'h');
      const state = await stateMgr.load();
      expect(state.lastShownChangeHash).toBe('h');
    });
  });
});
