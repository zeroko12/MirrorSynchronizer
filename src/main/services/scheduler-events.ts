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
import { decide } from '@core/detector';
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

export interface SchedulerEventDeps {
  /** 用 getter 打破循环引用(Scheduler.onSync 引用 Scheduler 自身) */
  getScheduler: () => Scheduler | null;
  stateMgr: StateManager | null;
  historyDB: HistoryDB | null;
  currentConfig: () => AppConfig | null;
  getMainWindow: () => BrowserWindow | null;
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
      const status = getScheduler()?.getStatus();
      handleFatalErrorToast(
        r.fatalReason ?? 'unknown',
        status?.consecutiveNetworkFailures ?? 0,
        status?.nextRunDelayMs ?? null,
      );
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

    // 3. 弹窗决策
    void handlePopupDecision(r, stateMgr, getMainWindow);

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
 * 弹窗决策:调 detector.decide → 发 update:prompt + 弹主窗 + Toast
 */
async function handlePopupDecision(
  r: SyncResult,
  stateMgr: StateManager | null,
  getMainWindow: () => BrowserWindow | null,
): Promise<void> {
  if (!stateMgr) return;
  const state = await stateMgr.load();
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
