/**
 * scheduler-events - Scheduler 同步结果回调处理
 *
 * 每次 Scheduler 完成一次 sync 后触发,职责:
 * 1. 写日志
 * 2. 切换托盘活动状态 + 致命错误 Toast
 * 3. 弹窗决策(调 detector.decide)→ 发 update:prompt + 弹主窗 + Toast
 * 4. 写历史(同步记录 + 备份记录)
 * 5. 发 sync:result 给 renderer
 *
 * 行业标准:rclone / Syncthing / OneDrive 都用类似分层
 * - 上层(UI)只关心"是否有变化"和"是否致命"
 * - 下层(此模块)做编排
 */

import { Notification } from 'electron';
import { Scheduler } from '@core/scheduler';
import { StateManager } from '@core/state';
import { HistoryDB } from '@core/history';
import { statDir } from '@core/backupper';
import { decide, computeFingerprint } from '@core/detector';
import { APP_DISPLAY_NAME } from '@core/constants';
import { mainLog } from '@core/logger';
import type { AppConfig, SyncResult } from '@core/types';
import type { BrowserWindow } from 'electron';
import {
  getWasNetworkDown,
  handleFatalErrorToast,
  notifyRecovered,
  setWasNetworkDown,
} from './notification.js';
import { setActivityState } from './tray.js';

const log = mainLog;

/**
 * 弹窗去重时间窗(ms)。
 *
 * 同一 fp 在窗口内不会被再次决定为 popup。覆盖两个场景:
 *   1. scheduler 周期 tick 紧挨 user:decide apply 后跑完 → 同样 fp 的 sync 接连完成两次
 *   2. handlePopupDecision 自身是 async(里面 state.load() + state.update() 是异步),
 *      并发进入时两边都看到 lastShownChangeHash=null → 都返回 popup → 同一内容弹两次
 *
 * 注意:lastShownChangeHash 的持久化才是真正 dedup 来源,
 * 这个 set 只在窗口内挡掉 race 触发,过了窗口后 fp 仍命中 lastShownChangeHash 也会被挡掉。
 */
const POPUP_DEDUP_WINDOW_MS = 3000;
const recentlySentFp = new Map<string, number>();

function markFpSent(fp: string): boolean {
  const now = Date.now();
  // 清掉过期的(避免无界增长)
  for (const [k, t] of recentlySentFp) {
    if (now - t > POPUP_DEDUP_WINDOW_MS) recentlySentFp.delete(k);
  }
  const last = recentlySentFp.get(fp);
  if (last !== undefined && now - last < POPUP_DEDUP_WINDOW_MS) {
    return false; // 已被 dedup
  }
  recentlySentFp.set(fp, now);
  return true;
}

/**
 * 测试用:清除 dedup map(避免跨用例污染)。
 */
export function _resetPopupDedupForTests(): void {
  recentlySentFp.clear();
}

export interface SchedulerEventDeps {
  /** 用 getter 打破循环引用(Scheduler.onSync 引用 Scheduler 自身) */
  getScheduler: () => Scheduler | null;
  stateMgr: StateManager | null;
  historyDB: HistoryDB | null;
  currentConfig: () => AppConfig | null;
  getMainWindow: () => BrowserWindow | null;
  /**
   * 同步前的 popup 抑制判定(由 main 注入)
   * 返回 true 时本次 sync 跳过本地 popup 弹窗
   * 用于:远程"立即同步"触发的 sync 不应再弹本地弹窗
   */
  shouldSkipPopup?: () => boolean;
}

/**
 * 构建 Scheduler.onSync 回调
 * 工厂模式 — 闭包持有依赖,避免反复传参
 */
export function buildOnSyncHandler(deps: SchedulerEventDeps): (r: SyncResult) => void {
  const { getScheduler, stateMgr, historyDB, currentConfig, getMainWindow } = deps;

  return (r: SyncResult) => {
    // 1. 日志
    const summary = `added=${r.added.length} modified=${r.modified.length} deleted=${r.deleted.length} unchanged=${r.unchanged} mapping=${r.mappingCopied.length} duration=${r.durationMs}ms`;
    if (r.fatalError) {
      log.error(`[sync FATAL] ${r.fatalError}`);
      log.error(`[sync FATAL] | ${summary}`);
    } else if (r.warnings.length > 0) {
      log.warn(`[sync WARN] warnings=${r.warnings.length}`);
      log.warn(`[sync WARN] | ${summary}`);
      for (const w of r.warnings) log.warn(`  - ${w}`);
    } else {
      log.info(`[sync OK] ${summary}`);
    }

    // 2. 托盘状态 + 致命错误 Toast
    if (r.fatalError) {
      setActivityState('error');
      if (!deps.shouldSkipPopup?.()) {
        const status = getScheduler()?.getStatus();
        handleFatalErrorToast(
          r.fatalReason ?? 'unknown',
          status?.consecutiveNetworkFailures ?? 0,
          status?.nextRunDelayMs ?? null,
        );
      } else {
        log.info('[scheduler-events] 远程触发,跳过 fatal toast');
      }
    } else {
      if (getWasNetworkDown()) {
        setWasNetworkDown(false);
        notifyRecovered();
      }
      if (r.added.length + r.modified.length + r.deleted.length > 0) {
        setActivityState('has-update');
      } else {
        setActivityState('idle');
      }
    }

    // 3. 弹窗决策(远程触发的 sync 可抑制)
    if (!deps.shouldSkipPopup?.()) {
      void handlePopupDecision(r, stateMgr, getMainWindow);
    } else {
      log.info('[scheduler-events] 远程触发,跳过本地 popup');
    }

    // 4. 写历史
    void writeHistory(r, historyDB, currentConfig);

    // 5. 发同步结果给 renderer
    const w = getMainWindow();
    if (w && !w.isDestroyed()) {
      w.webContents.send('sync:result', r);
    }
  };
}

/**
 * 弹窗决策:调 detector.decide → 发 update:prompt + 弹主窗 + Toast + 写入 lastShownChangeHash
 *
 * 关键:弹窗弹出后**必须**写 lastShownChangeHash,否则下次同 fp 的 sync
 *   会重新弹(用户感受"连续弹两个框")。
 *   detector.decide 的 "already-shown" 分支靠这个字段去重。
 *
 * exported:供单元测试验证 dedup 行为。
 */
export async function handlePopupDecision(
  r: SyncResult,
  stateMgr: StateManager | null,
  getMainWindow: () => BrowserWindow | null,
): Promise<void> {
  if (!stateMgr) return;
  const state = await stateMgr.load();

  // ★ 特殊路径:applyMode='immediate-with-precheck' 时目标被锁
  // 与常规"新变化"流程不同:
  // 1. 重置 lastShownChangeHash → 下次 dryRun 还能再弹(用户没确认呢)
  // 2. 不用 decide() 走 silent 分支 — 强制弹窗,带 lockedRel/lockedCode
  // 3. 也不写 hash 进 state(因为我们刚 reset 了)
  if (r.fatalReason === 'target-locked') {
    const lockedRel = r.warnings
      .map((w) => /目标文件被占用 \(([A-Z]+)\): ([^\s。]+)/.exec(w)?.[2])
      .find((x): x is string => !!x) ?? null;
    const lockedCode = r.warnings
      .map((w) => /目标文件被占用 \(([A-Z]+)\):/.exec(w)?.[1])
      .find((x): x is string => !!x) ?? null;
    log.info(`[decide] target-locked: rel=${lockedRel} code=${lockedCode}`);
    // 关键:重置已展示 hash,让用户解锁程序后下次检测还能再弹
    try {
      await stateMgr.update({ lastShownChangeHash: null });
    } catch (err) {
      log.warn(`[decide] 重置 lastShownChangeHash 失败: ${(err as Error).message}`);
    }
    // 推"locked" prompt 到 renderer
    const fp = computeFingerprint(r);
    const w = getMainWindow();
    if (!w || w.isDestroyed()) return;
    w.webContents.send('update:prompt', {
      ...fp,
      isLocked: false, // 不是 post-rollback lock
      lockSnapshotTimestamp: state.postRollbackLock?.snapshotTimestamp ?? null,
      lockedRel,
      lockedCode,
    });
    w.show();
    w.focus();
    return;
  }

  const decision = decide({
    result: r,
    lastShownChangeHash: state.lastShownChangeHash,
    popupEnabled: state.popupEnabled,
    snoozeUntil: state.snoozeUntil,
    isPostRollbackLockActive: !!state.postRollbackLock,
  });

  if (decision.kind === 'silent') {
    log.info(`[decide] silent (${decision.reason})`);
    return;
  }

  const fingerprint = decision.fingerprint;
  log.info(`[decide] ${decision.kind} (${decision.kind === 'popup' ? decision.reason : 'locked'}) hash=${fingerprint.hash}`);

  // Race 去重:同 fp 在窗口内已经被"决定要弹"就别再发一次 IPC。
  // 注意:这里 dedup 的是"发 IPC"动作,state 持久化才是真正去重来源(下一段就写)。
  if (!markFpSent(fingerprint.hash)) {
    log.info(`[decide] 同 fp 在 dedup 窗口内(${POPUP_DEDUP_WINDOW_MS}ms),跳过重复 IPC`);
    return;
  }

  // ★ 写 lastShownChangeHash — 必须先于任何"发 IPC/弹主窗"步骤。
  // 即使后面的 webContents.send 失败、窗口销毁、或 renderer 正处于 reload 中,
  // state 层的 already-shown 去重仍能保证下一轮同 fp sync 静默,
  // 避免用户感受的"连续弹两个框"反复出现。
  try {
    await stateMgr.update({ lastShownChangeHash: fingerprint.hash });
  } catch (err) {
    log.warn(`[decide] 写 lastShownChangeHash 失败(非致命): ${(err as Error).message}`);
  }

  const w = getMainWindow();
  if (!w || w.isDestroyed()) return;

  w.webContents.send('update:prompt', {
    ...fingerprint,
    isLocked: decision.kind === 'locked-detect',
    lockSnapshotTimestamp: state.postRollbackLock?.snapshotTimestamp ?? null,
  });
  w.show();
  w.focus();

  // Windows Toast
  try {
    new Notification({
      title: APP_DISPLAY_NAME,
      body: decision.kind === 'locked-detect'
        ? `已回退 · 检测到 ${fingerprint.addedCount + fingerprint.modifiedCount + fingerprint.deletedCount} 个新变更,需确认`
        : `检测到 ${fingerprint.addedCount + fingerprint.modifiedCount + fingerprint.deletedCount} 个文件变化,需确认`,
    }).show();
  } catch (e) {
    log.warn('[notification] 显示失败:', (e as Error).message);
  }
}

/**
 * 写历史(异步,失败不阻塞同步)
 */
async function writeHistory(
  r: SyncResult,
  historyDB: HistoryDB | null,
  currentConfig: () => AppConfig | null,
): Promise<void> {
  if (!historyDB) return;
  const cfg = currentConfig();
  if (!cfg) return;
  try {
    let backupId: number | null = null;
    if (r.backupCreated && r.backupSnapshotPath) {
      const { fileCount, sizeBytes } = await statDir(r.backupSnapshotPath);
      backupId = historyDB.recordBackup({
        createdAt: r.startedAt,
        sourceDir: cfg.sourceDir,
        targetDir: cfg.targetDir,
        snapshotPath: r.backupSnapshotPath,
        fileCount,
        sizeBytes,
      });
      log.info(`[history] 备份 #${backupId} 已记录`);
    }
    const syncId = historyDB.recordSync({
      startedAt: r.startedAt,
      durationMs: r.durationMs,
      sourceDir: cfg.sourceDir,
      targetDir: cfg.targetDir,
      addedCount: r.added.length,
      modifiedCount: r.modified.length,
      deletedCount: r.deleted.length,
      unchangedCount: r.unchanged,
      mappingCopiedCount: r.mappingCopied.length,
      mappingSkippedExistingCount: r.mappingSkippedExisting.length,
      mappingSkippedCount: r.mappingSkipped.length,
      fatalError: r.fatalError ?? null,
      backupId,
    });
    log.info(`[history] 同步 #${syncId} 已记录(added=${r.added.length} mod=${r.modified.length} del=${r.deleted.length})`);
  } catch (e) {
    log.error('[history] 写入失败:', (e as Error).message);
  }
}
