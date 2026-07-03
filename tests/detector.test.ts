/**
 * Detector 测试 — 弹窗决策逻辑
 */

import { describe, it, expect } from 'vitest';
import { decide, computeFingerprint } from '../src/core/detector.js';
import type { SyncResult } from '../src/core/types.js';

function makeResult(overrides: Partial<SyncResult> = {}): SyncResult {
  return {
    startedAt: 0,
    durationMs: 0,
    ok: true,
    added: [],
    modified: [],
    deleted: [],
    mappingCopied: [],
    mappingSkippedExisting: [],
    mappingSkipped: [],
    unchanged: 0,
    warnings: [],
    backupCreated: false,
    ...overrides,
  };
}

describe('computeFingerprint', () => {
  it('空结果 → 全零 + hash 仍可算', () => {
    const r = makeResult();
    const fp = computeFingerprint(r);
    expect(fp.addedCount).toBe(0);
    expect(fp.modifiedCount).toBe(0);
    expect(fp.deletedCount).toBe(0);
    expect(fp.hash).toMatch(/^[0-9a-f]{16}$/);
  });

  it('added/modified/deleted 计数对', () => {
    const r = makeResult({
      added: ['a.txt', 'b/c.txt'],
      modified: ['x.txt'],
      deleted: ['gone.txt'],
    });
    const fp = computeFingerprint(r);
    expect(fp.addedCount).toBe(2);
    expect(fp.modifiedCount).toBe(1);
    expect(fp.deletedCount).toBe(1);
  });

  it('同输入 → 同 hash', () => {
    const r1 = makeResult({ added: ['a'], modified: ['b'] });
    const r2 = makeResult({ added: ['a'], modified: ['b'] });
    expect(computeFingerprint(r1).hash).toBe(computeFingerprint(r2).hash);
  });

  it('路径顺序不影响 hash(sort 后再 hash)', () => {
    const r1 = makeResult({ added: ['a', 'b'] });
    const r2 = makeResult({ added: ['b', 'a'] });
    expect(computeFingerprint(r1).hash).toBe(computeFingerprint(r2).hash);
  });

  it('不同内容 → 不同 hash', () => {
    const r1 = makeResult({ added: ['a'] });
    const r2 = makeResult({ added: ['b'] });
    expect(computeFingerprint(r1).hash).not.toBe(computeFingerprint(r2).hash);
  });
});

describe('decide', () => {
  const baseInput = {
    result: makeResult(),
    lastShownChangeHash: null,
    popupEnabled: true,
    snoozeUntil: 0,
    isPostRollbackLockActive: false,
    now: 1000,
  };

  it('无变化 → silent:no-changes', () => {
    const d = decide(baseInput);
    expect(d.kind).toBe('silent');
    if (d.kind === 'silent') expect(d.reason).toBe('no-changes');
  });

  it('有变化 + popup 开启 → popup:new-changes', () => {
    const d = decide({
      ...baseInput,
      result: makeResult({ added: ['new.txt'] }),
    });
    expect(d.kind).toBe('popup');
  });

  it('有变化 + popup 关闭 → silent:popup-disabled(静默同步)', () => {
    const d = decide({
      ...baseInput,
      popupEnabled: false,
      result: makeResult({ added: ['new.txt'] }),
    });
    expect(d.kind).toBe('silent');
    if (d.kind === 'silent') expect(d.reason).toBe('popup-disabled');
  });

  it('★ 有变化 + 上次已展示(同 hash)→ 仍弹(不再 dedup)', () => {
    // 之前的版本会返回 silent:already-shown,导致"用户感知不到还在变化"。
    // 用户要求:探测到变化就要弹,不再 dedup。
    const realFp = computeFingerprint(makeResult({ added: ['new.txt'] }));
    const d = decide({
      ...baseInput,
      lastShownChangeHash: realFp.hash,
      result: makeResult({ added: ['new.txt'] }),
    });
    expect(d.kind).toBe('popup');
  });

  it('★ 有变化 + 暂休中 → 仍弹(不再 snooze 抑制)', () => {
    // 之前会返回 silent:snoozed。现在每次探测都弹。
    const d = decide({
      ...baseInput,
      now: 1000,
      snoozeUntil: 5000,
      result: makeResult({ added: ['new.txt'] }),
    });
    expect(d.kind).toBe('popup');
  });

  it('有变化 + 锁定状态 → locked-detect', () => {
    const d = decide({
      ...baseInput,
      isPostRollbackLockActive: true,
      result: makeResult({ added: ['will-unlock.txt'] }),
    });
    expect(d.kind).toBe('locked-detect');
  });

  it('锁定 + 无变化 → silent:no-changes', () => {
    const d = decide({
      ...baseInput,
      isPostRollbackLockActive: true,
    });
    expect(d.kind).toBe('silent');
  });
});
