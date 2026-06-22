/**
 * remote/state-provider - 把本地状态快照给 web UI
 *
 * 这是个 thin wrapper,把所有"web 需要的状态"集中到一处
 * 减少 WebSocket 消息的耦合
 */

import type { AppConfig } from '@core/types';
import type { HistoryDB } from '@core/history';
import type { Scheduler } from '@core/scheduler';

export interface RemoteState {
  /** 应用基础信息 */
  app: {
    name: string;
    version: string;
  };
  /** 当前配置(只读) */
  config: AppConfig;
  /** 调度器状态 */
  scheduler: {
    running: boolean;
    intervalSec: number;
    lastRunAt: number | null;
    nextRunAt: number | null;
    nextRunDelayMs: number | null;
    consecutiveNetworkFailures: number;
    lastFatalReason: string | null;
  };
  /** 最近 20 条同步历史 */
  recentHistory: Array<{
    id: number;
    startedAt: number;
    durationMs: number;
    sourceDir: string;
    targetDir: string;
    addedCount: number;
    modifiedCount: number;
    deletedCount: number;
    fatalError: string | null;
  }>;
  /** 待决弹窗(如果有) */
  pendingPopup: {
    hash: string;
    addedCount: number;
    modifiedCount: number;
    deletedCount: number;
    isLocked: boolean;
    lockSnapshotTimestamp: string | null;
  } | null;
}

/** 获取当前完整状态快照 */
export function getRemoteState(deps: {
  config: () => AppConfig | null;
  historyDB: () => HistoryDB | null;
  scheduler: () => Scheduler | null;
  pendingPopup: () => RemoteState['pendingPopup'];
  appName: string;
  appVersion: string;
}): RemoteState {
  const config = deps.config();
  const historyDB = deps.historyDB();
  const scheduler = deps.scheduler();
  const status = scheduler?.getStatus();

  const recentHistory = historyDB
    ? historyDB.listSyncs(20, 0).map((r) => ({
        id: r.id,
        startedAt: r.startedAt,
        durationMs: r.durationMs,
        sourceDir: r.sourceDir,
        targetDir: r.targetDir,
        addedCount: r.addedCount,
        modifiedCount: r.modifiedCount,
        deletedCount: r.deletedCount,
        fatalError: r.fatalError,
      }))
    : [];

  return {
    app: { name: deps.appName, version: deps.appVersion },
    config: config ?? ({} as AppConfig),
    scheduler: {
      running: status?.running ?? false,
      intervalSec: status?.intervalSec ?? 0,
      lastRunAt: status?.lastRunAt ?? null,
      nextRunAt: status?.nextRunAt ?? null,
      nextRunDelayMs: status?.nextRunDelayMs ?? null,
      consecutiveNetworkFailures: status?.consecutiveNetworkFailures ?? 0,
      lastFatalReason: status?.lastFatalReason ?? null,
    },
    recentHistory,
    pendingPopup: deps.pendingPopup(),
  };
}
