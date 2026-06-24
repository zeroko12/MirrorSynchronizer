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
    it('apply → 关闭 dryRun,跑一次 runNow,再恢复', async () => {
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
        unchanged: 0,
        warnings: [],
        backupCreated: false,
      });

      // 初始 dryRunMode 是 false
      expect((scheduler as Scheduler)['dryRunMode']).toBe(false);
      await handleUserDecision(stateMgr, scheduler, 'apply', 'hash-3');
      // 验证 setDryRunMode(false) → runNow → setDryRunMode(false) 流程
      expect(spy).toHaveBeenCalledOnce();
    });

    it('apply 在回退锁状态 → 先解锁', async () => {
      await stateMgr.lockPostRollback('2026-06-17T12-00-00-000Z', 99);
      vi.spyOn(scheduler!, 'runNow').mockResolvedValue(null);
      await handleUserDecision(stateMgr, scheduler, 'apply', 'hash-4');
      const state = await stateMgr.load();
      expect(state.postRollbackLock).toBeNull();
    });
  });

  describe('null 依赖', () => {
    it('stateMgr 为 null → 不抛', async () => {
      await expect(handleUserDecision(null, null, 'snooze', 'h')).resolves.toBeUndefined();
    });

    it('scheduler 为 null + snooze → 仍更新 state', async () => {
      await handleUserDecision(stateMgr, null, 'snooze', 'h');
      const state = await stateMgr.load();
      expect(state.lastShownChangeHash).toBe('h');
    });
  });
});
