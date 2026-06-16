/**
 * Renderer API 类型化封装
 *
 * preload 暴露的 window.api 是 unknown,这里包成强类型
 * 所有 UI 代码都通过 useApi() 拿,避免直接接触 window
 */

import type { AppConfig } from '@core/types';

export interface StatusInfo {
  sourceDir: string;
  targetDir: string;
  backupDir: string;
  intervalSec: number;
  backupCount: number;
  autostart: boolean;
  fileMappings: AppConfig['fileMappings'];
  running: boolean;
  lastResult: {
    added: number;
    modified: number;
    deleted: number;
    durationMs: number;
    ok: boolean;
  } | null;
}

export interface SelectFolderResult {
  canceled: boolean;
  path: string | null;
}

export interface SaveConfigResult {
  ok: boolean;
  error?: string;
}

declare global {
  interface Window {
    api: {
      getStatus: () => Promise<StatusInfo>;
      runSyncNow: () => Promise<{ ok: boolean; result?: unknown; error?: string }>;
      loadConfig: () => Promise<AppConfig>;
      saveConfig: (config: AppConfig) => Promise<SaveConfigResult>;
      selectFolder: (defaultPath?: string) => Promise<SelectFolderResult>;
      selectPath: (opts: { defaultPath?: string; mode: 'file' | 'folder' | 'both' }) => Promise<{
        canceled: boolean;
        path: string | null;
        isDirectory: boolean;
      }>;
      onSyncResult?: (callback: (result: unknown) => void) => () => void;
      countFiles: () => Promise<{
        source: number;
        target: number;
        sourcePath: string;
        targetPath: string;
        sourceFatal: boolean;
        targetFatal: boolean;
      }>;
      historyList: (opts?: { limit?: number; offset?: number }) => Promise<{
        items: Array<{
          id: number;
          startedAt: number;
          durationMs: number;
          sourceDir: string;
          targetDir: string;
          addedCount: number;
          modifiedCount: number;
          deletedCount: number;
          unchangedCount: number;
          mappingCopiedCount: number;
          mappingSkippedExistingCount: number;
          mappingSkippedCount: number;
          fatalError: string | null;
          backupId: number | null;
        }>;
        total: number;
      }>;
      historyDelete: (id: number) => Promise<{ ok: boolean; error?: string }>;
      backupList: () => Promise<Array<{
        id: number;
        createdAt: number;
        sourceDir: string;
        targetDir: string;
        snapshotPath: string;
        fileCount: number;
        sizeBytes: number;
        _stale?: boolean;
      }>>;
      backupRollback: (id: number) => Promise<{
        ok: boolean;
        error?: string;
        safetySnapshotPath?: string;
      }>;
      backupDelete: (id: number) => Promise<{ ok: boolean; error?: string }>;

      // P4: 弹窗决策、状态查询、popup 开关
      userDecide: (action: 'apply' | 'snooze' | 'ignore', hash: string) => Promise<{
        ok: boolean;
        error?: string;
      }>;
      stateGet: () => Promise<{
        lastShownChangeHash: string | null;
        postRollbackLock: { snapshotTimestamp: string; syncId: number; lockedAt: number } | null;
        snoozeUntil: number;
        popupEnabled: boolean;
      } | null>;
      stateSetPopupEnabled: (enabled: boolean) => Promise<{ ok: boolean; error?: string }>;
      autostartGet: () => Promise<{ openAtLogin: boolean }>;
      autostartSet: (enabled: boolean) => Promise<{ ok: boolean; openAtLogin?: boolean; error?: string }>;
      mappingsApplyAll: () => Promise<{
        ok: boolean;
        mappingCopied?: string[];
        mappingSkippedExisting?: string[];
        mappingSkipped?: string[];
        warnings?: string[];
        error?: string;
      }>;
      mappingsTestOne: (id: string) => Promise<{
        ok: boolean;
        mappingCopied?: string[];
        mappingSkippedExisting?: string[];
        mappingSkipped?: string[];
        warnings?: string[];
        error?: string;
      }>;
      onUpdatePrompt: (callback: (payload: {
        hash: string;
        addedCount: number;
        modifiedCount: number;
        deletedCount: number;
        isLocked: boolean;
        lockSnapshotTimestamp: string | null;
      }) => void) => () => void;
      $invoke: (channel: string, ...args: unknown[]) => Promise<{ ok: boolean; error?: string; [k: string]: unknown }>;
    };
    autoUpdater: typeof window.api;
  }
}

export function getApi() {
  if (!window.api) {
    throw new Error('preload 未注入 api,请检查 Electron 启动配置');
  }
  return window.api;
}
