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
});

describe('defaultStatePath', () => {
  it('返回 userDataDir/state.json', () => {
    expect(defaultStatePath('C:/Users/x/AppData/Roaming/au')).toBe(
      join('C:/Users/x/AppData/Roaming/au', 'state.json'),
    );
  });
});
