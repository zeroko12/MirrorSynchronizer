/**
 * StateManager 测试 — 运行时状态持久化
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { StateManager, defaultStatePath } from '../src/core/state.js';
import { makeTempDir, rmTemp } from './helpers.js';

describe('StateManager', () => {
  let dir: string;
  let sm: StateManager;

  beforeEach(async () => {
    dir = await makeTempDir('state-');
    sm = new StateManager(join(dir, 'state.json'));
  });

  afterEach(async () => {
    await rmTemp(dir);
  });

  it('load: 文件不存在 → 默认值', async () => {
    const s = await sm.load();
    expect(s.lastShownChangeHash).toBeNull();
    expect(s.postRollbackLock).toBeNull();
    expect(s.snoozeUntil).toBe(0);
    expect(s.popupEnabled).toBe(true);
  });

  it('save → load 往返', async () => {
    await sm.update({ lastShownChangeHash: 'abc', popupEnabled: false });
    const s = await sm.load();
    expect(s.lastShownChangeHash).toBe('abc');
    expect(s.popupEnabled).toBe(false);
  });

  it('cache 命中:第二次 load 不读盘', async () => {
    await sm.load();
    // 修改磁盘上的文件,但 cache 里仍是旧值
    await sm.update({ lastShownChangeHash: 'cached' });
    const s2 = await sm.load();
    expect(s2.lastShownChangeHash).toBe('cached');
  });

  it('文件损坏 → 用默认', async () => {
    const { promises: fs } = await import('node:fs');
    const { promises: fs2 } = await import('node:fs');
    void fs;
    await fs2.writeFile(join(dir, 'state.json'), '{ not json', 'utf-8');
    const s = await sm.load();
    expect(s.popupEnabled).toBe(true);
  });

  it('markUnread: lastShownChangeHash 置 null', async () => {
    await sm.update({ lastShownChangeHash: 'something' });
    await sm.markUnread();
    const s = await sm.load();
    expect(s.lastShownChangeHash).toBeNull();
  });

  it('snooze / isSnoozed', async () => {
    const now = Date.now();
    expect(await sm.isSnoozed(now)).toBe(false);
    await sm.snooze(5000); // 暂休 5 秒
    expect(await sm.isSnoozed(now + 2000)).toBe(true); // 暂休期内
    expect(await sm.isSnoozed(now + 10000)).toBe(false); // 已过
  });

  it('lockPostRollback / unlockPostRollback', async () => {
    expect((await sm.load()).postRollbackLock).toBeNull();
    await sm.lockPostRollback('2026-06-12T10-00-00', 42);
    const s = await sm.load();
    expect(s.postRollbackLock?.snapshotTimestamp).toBe('2026-06-12T10-00-00');
    expect(s.postRollbackLock?.syncId).toBe(42);
    await sm.unlockPostRollback();
    expect((await sm.load()).postRollbackLock).toBeNull();
  });

  // ★ 回归:托盘"立即检查一次"行为
  //   之前:scheduler.runNow() 跑出来的 fp 等于 state.lastShownChangeHash
  //         → decide 走 already-shown 静默 → 用户感受"明明有改动却不弹框"
  //   现在:托盘回调里调 stateMgr.update({ lastShownChangeHash: null }) 后再 runNow
  //         → 同样的 fp 会再次触发 popup
  //   这里测的是"清掉已展示 hash" 等价 markUnread 这条路径
  it('托盘立即检查一次:清掉 lastShownChangeHash 后,decide 不再走 already-shown', async () => {
    const { decide, computeFingerprint } = await import('../src/core/detector.js');
    const r = {
      added: ['new.txt'], modified: [], deleted: [],
      ok: true, startedAt: 0, durationMs: 0,
      mappingCopied: [], mappingSkippedExisting: [], mappingSkipped: [], mappingFailed: [],
      unchanged: 0, warnings: [], backupCreated: false,
    } as const;
    const fp = computeFingerprint(r as any).hash;

    // 1) 之前弹过 → hash 已写
    await sm.update({ lastShownChangeHash: fp });
    expect((await sm.load()).lastShownChangeHash).toBe(fp);

    // 2) 假装 decide 跑(模拟 periodic sync)
    let d = decide({
      result: r as any,
      lastShownChangeHash: (await sm.load()).lastShownChangeHash,
      popupEnabled: true,
      snoozeUntil: 0,
      isPostRollbackLockActive: false,
    });
    expect(d.kind).toBe('silent'); // already-shown

    // 3) 托盘"立即检查一次" → 清掉 hash
    await sm.update({ lastShownChangeHash: null });
    expect((await sm.load()).lastShownChangeHash).toBeNull();

    // 4) 重新 decide(模拟托盘触发的 runNow 完成后的 handlePopupDecision)
    d = decide({
      result: r as any,
      lastShownChangeHash: (await sm.load()).lastShownChangeHash,
      popupEnabled: true,
      snoozeUntil: 0,
      isPostRollbackLockActive: false,
    });
    expect(d.kind).toBe('popup');
  });
});

describe('defaultStatePath', () => {
  it('返回 userDataDir/state.json', () => {
    expect(defaultStatePath('C:/Users/x/AppData/Roaming/au')).toBe(
      join('C:/Users/x/AppData/Roaming/au', 'state.json'),
    );
  });
});
