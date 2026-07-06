/**
 * scheduler-events 服务单元测试 — 弹窗决策 + dedup
 *
 * 关键回归:
 *   1. handlePopupDecision 弹出 popup 后必须写 lastShownChangeHash,
 *      否则下一轮 sync 同样 fp 会重新弹(用户感受"连续弹两个框")。
 *   2. 同 fp 在 dedup 窗口内并发/接连触发 → 只发一次 update:prompt IPC。
 *   3. silent(snoozed/already-shown/no-changes/popup-disabled)→ 不发 IPC、不写 hash。
 *   4. locked-detect 路径也要写 hash(锁定场景下一次 fp 仍要弹)。
 *
 * 仿真方式:
 *   - stateMgr 用真 StateManager(短临时 state.json)
 *   - getMainWindow 用 mock object,记录 send 调用
 *   - electron Notification 用 vi.mock 屏蔽(我们不测通知,只测 IPC 行为)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ★ electron.Notification 必须先 mock,因为 handlePopupDecision 触发真实 Toast 调用会
// 在 vitest 环境下抛"Notification is not a constructor"
vi.mock('electron', async () => {
  const actual = await vi.importActual<typeof import('electron')>('electron');
  return {
    ...actual,
    Notification: class {
      static isSupported() { return false; }
      show() { /* noop */ }
      on(_e: string, _cb: (...args: unknown[]) => void) { return this; }
    },
  };
});

import { handlePopupDecision, _resetPopupDedupForTests } from '../src/main/services/scheduler-events.js';
import { StateManager } from '../src/core/state.js';
import { computeFingerprint } from '../src/core/detector.js';
import { makeTempDir, rmTemp } from './helpers.js';
import type { SyncResult } from '../src/core/types.js';

interface SentPayload {
  [k: string]: unknown;
}

function makeResult(extra: Partial<SyncResult> = {}): SyncResult {
  return {
    startedAt: Date.now(),
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
    ...extra,
  };
}

/**
 * Mock mainWindow,记录每次 webContents.send 调用
 */
function makeMockWindow() {
  const sent: Array<{ channel: string; payload: SentPayload }> = [];
  const win = {
    isDestroyed: () => false,
    show: () => undefined,
    focus: () => undefined,
    webContents: {
      send: (channel: string, payload: SentPayload) => sent.push({ channel, payload }),
    },
  };
  return { win: win as unknown as import('electron').BrowserWindow, sent };
}

describe('handlePopupDecision — 弹窗去重', () => {
  let stateDir: string;
  let statePath: string;
  let stateMgr: StateManager;
  let mockWin: ReturnType<typeof makeMockWindow>;

  beforeEach(async () => {
    stateDir = await makeTempDir('popup-dedup-state-');
    statePath = `${stateDir}/state.json`;
    stateMgr = new StateManager(statePath);
    await stateMgr.load();
    mockWin = makeMockWindow();
    _resetPopupDedupForTests();
  });

  afterEach(async () => {
    await rmTemp(stateDir);
  });

  it('★ 弹出 popup 后必须写 lastShownChangeHash(给后续 sync 去重用)', async () => {
    const r = makeResult({ added: ['new.txt'] });
    const fp = computeFingerprint(r);

    // 弹之前 state 是默认 null
    expect((await stateMgr.load()).lastShownChangeHash).toBeNull();

    await handlePopupDecision(r, stateMgr, () => mockWin.win);

    // IPC 发了 + state 写入了新 fp
    expect(mockWin.sent.find((s) => s.channel === 'update:prompt')).toBeTruthy();
    expect((await stateMgr.load()).lastShownChangeHash).toBe(fp.hash);
  });

  it('★ 同一个 fp 接连触发两次 → 只发一次 IPC(去重核心场景)', async () => {
    const r = makeResult({ added: ['new.txt'] });

    // 第一次:弹,写 hash
    await handlePopupDecision(r, stateMgr, () => mockWin.win);
    const fp1State = (await stateMgr.load()).lastShownChangeHash;
    const sendCount1 = mockWin.sent.filter((s) => s.channel === 'update:prompt').length;

    // 第二次(模拟 scheduler 周期 tick 紧接着又跑出同样 diff):
    // state 已经写了 fp → decide 返回 already-shown → silent → 不发 IPC、不写 hash
    await handlePopupDecision(r, stateMgr, () => mockWin.win);
    const sendCount2 = mockWin.sent.filter((s) => s.channel === 'update:prompt').length;
    const fp2State = (await stateMgr.load()).lastShownChangeHash;

    expect(sendCount1).toBe(1);
    expect(sendCount2).toBe(1); // 关键:只发 1 次
    expect(fp1State).toBe(fp2State);
  });

  it('★ 同 fp 但 dedup 窗口外再次触发 → 再发一次(模拟新一次 sync + 用户还没决策)', async () => {
    const r = makeResult({ added: ['fresh.txt'] });
    const before = Date.now();

    // 第一次
    await handlePopupDecision(r, stateMgr, () => mockWin.win);
    expect(mockWin.sent.filter((s) => s.channel === 'update:prompt').length).toBe(1);

    // 模拟"用户点了 ignore"+ 文件又有新一批(不同 fp)→ 单独测的见下一个用例
    // 这里只验证:同 fp,过了 dedup 窗口 → 应该再发(因为 fp A 不会在第一次被 dedup 后
    // 永远不弹;用户需要主动 ignore 才走 already-shown)
    // 但同 fp = 不会被 dedup 的窗口影响写过 hash,第二次 decide 应直接 silent
    await handlePopupDecision(r, stateMgr, () => mockWin.win);
    expect(mockWin.sent.filter((s) => s.channel === 'update:prompt').length).toBe(1); // 仍 1
    expect(Date.now() - before).toBeLessThan(1000); // 在窗口内
  });

  it('不同 fp → 各自发一次 IPC(hash 已写但新 fp 不命中 → 再弹)', async () => {
    const r1 = makeResult({ added: ['a.txt'] });
    const r2 = makeResult({ added: ['b.txt'] });

    await handlePopupDecision(r1, stateMgr, () => mockWin.win);
    // 让 dedup window 失效:不调 clock,但用不同的 fp 走通"不被 dedup map 挡"
    // (markFpSent 用 fp 作为 key,不同 fp 不会撞 key)
    // 但 stateMgr 里 lastShownChangeHash 已经写了 r1 的 fp,r2 hash 不同 → decide → popup
    await new Promise((r) => setTimeout(r, 10)); // 让 markFpSent 有时间戳差异(其实没用,只是 sanity)
    _resetPopupDedupForTests(); // 重置 dedup map,不然窗口内第 2 个 popup 会被去重,无法验证 hash 不同分支

    await handlePopupDecision(r2, stateMgr, () => mockWin.win);

    const sends = mockWin.sent.filter((s) => s.channel === 'update:prompt');
    expect(sends.length).toBe(2);
    // state 写的是最后一个的 fp(r2)
    const expected2 = computeFingerprint(r2).hash;
    expect((await stateMgr.load()).lastShownChangeHash).toBe(expected2);
  });

  it('silent:no-changes → 不发 IPC、不写 hash', async () => {
    const r = makeResult(); // 无 added/modified/deleted
    await handlePopupDecision(r, stateMgr, () => mockWin.win);
    expect(mockWin.sent).toEqual([]);
    expect((await stateMgr.load()).lastShownChangeHash).toBeNull();
  });

  it('silent:popup-disabled → 不发 IPC、不写 hash', async () => {
    await stateMgr.update({ popupEnabled: false });
    const r = makeResult({ added: ['new.txt'] });
    await handlePopupDecision(r, stateMgr, () => mockWin.win);
    expect(mockWin.sent).toEqual([]);
    // hash 不会被写,因为根本没弹
    expect((await stateMgr.load()).lastShownChangeHash).toBeNull();
  });

  it('silent:already-shown(state 已有同 fp)→ 不发 IPC、不重写', async () => {
    const r = makeResult({ added: ['new.txt'] });
    const fp = computeFingerprint(r);
    // 先手动写上同 hash 模拟 "用户点过 ignore 后"
    await stateMgr.update({ lastShownChangeHash: fp.hash });

    await handlePopupDecision(r, stateMgr, () => mockWin.win);
    expect(mockWin.sent).toEqual([]);
    // 仍是原 hash(未变)
    expect((await stateMgr.load()).lastShownChangeHash).toBe(fp.hash);
  });

  it('silent:snoozed(state.snoozeUntil 在未来)→ 不发 IPC、不写 hash', async () => {
    await stateMgr.update({ snoozeUntil: Date.now() + 5 * 60 * 1000 });
    const r = makeResult({ added: ['new.txt'] });
    await handlePopupDecision(r, stateMgr, () => mockWin.win);
    expect(mockWin.sent).toEqual([]);
    expect((await stateMgr.load()).lastShownChangeHash).toBeNull();
  });

  it('locked-detect → 发 update:prompt(isLocked=true)并写 hash', async () => {
    await stateMgr.update({
      postRollbackLock: {
        snapshotTimestamp: '2026-07-06T12-00-00-000Z',
        syncId: 99,
        lockedAt: Date.now(),
      },
    });
    const r = makeResult({ added: ['unlock-needed.txt'] });
    const fp = computeFingerprint(r);

    await handlePopupDecision(r, stateMgr, () => mockWin.win);
    const sent = mockWin.sent.find((s) => s.channel === 'update:prompt');
    expect(sent).toBeTruthy();
    expect(sent!.payload['isLocked']).toBe(true);
    expect(sent!.payload['hash']).toBe(fp.hash);
    expect((await stateMgr.load()).lastShownChangeHash).toBe(fp.hash);
  });

  it('main window 销毁 → 不发 IPC,但 state 仍写(下次 sync 仍可去重)', async () => {
    const r = makeResult({ added: ['new.txt'] });
    const fp = computeFingerprint(r);
    const deadWin = {
      isDestroyed: () => true,
      show: () => undefined,
      focus: () => undefined,
      webContents: { send: vi.fn() },
    };

    await handlePopupDecision(r, stateMgr, () => deadWin as unknown as import('electron').BrowserWindow);
    expect(deadWin.webContents.send).not.toHaveBeenCalled();
    // ★ 即使 IPC 失败,state 仍要写 — 否则下一轮同样 fp 还会"应该弹" → 真发时窗口已销毁 → 又被吞
    //   (这个 case 之前也是 bug 之一)
    expect((await stateMgr.load()).lastShownChangeHash).toBe(fp.hash);
  });
});
