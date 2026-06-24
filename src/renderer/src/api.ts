/**
 * Renderer API 类型化封装
 *
 * 类型本身来自 `@core/api-contracts`,preload 桥接的实际对象用 typeof 推导
 * 这样改 api 对象 → 渲染端类型自动跟随,不会漂移
 */

import type { AppConfig } from '@core/types';
import type {
  AppStateInfo,
  AutostartResult,
  AutostartStatus,
  BackupDeleteResult,
  BackupItem,
  BackupRollbackResult,
  CountFilesResult,
  HistoryDeleteResult,
  HistoryListResult,
  MappingsApplyResult,
  RemoteAccessInfo,
  SaveConfigResult,
  SelectFolderResult,
  SelectPathResult,
  SourceTestResult,
  StateSetPopupEnabledResult,
  StatusInfo,
  UpdatePromptPayload,
  UserDecideAction,
  UserDecideResult,
} from '@core/api-contracts';

// 重新导出,供视图组件直接 import(避免每处都 import 跨模块)
export type {
  AppStateInfo,
  AutostartResult,
  AutostartStatus,
  BackupDeleteResult,
  BackupItem,
  BackupRollbackResult,
  CountFilesResult,
  HistoryDeleteResult,
  HistoryItem,
  HistoryListResult,
  MappingsApplyResult,
  RemoteAccessInfo,
  SaveConfigResult,
  SelectFolderResult,
  SelectPathResult,
  SourceTestFileEntry,
  SourceTestResult,
  StateSetPopupEnabledResult,
  StatusInfo,
  UpdatePromptPayload,
  UserDecideAction,
  UserDecideResult,
} from '@core/api-contracts';

export interface SelectFolderResultLocal extends SelectFolderResult {}
export interface SaveConfigResultLocal extends SaveConfigResult {}

declare global {
  interface Window {
    api: {
      getStatus: () => Promise<StatusInfo>;
      runSyncNow: () => Promise<{ ok: boolean; result?: unknown; error?: string }>;
      /**
       * 强制真同步 — 即便弹窗模式也立刻真删真拷。用于"保存并立即同步"按钮。
       */
      runSyncNowForce: () => Promise<{ ok: boolean; result?: unknown; error?: string }>;
      /** P6 staging 模式:立即应用 staging 中待 swap 的内容 */
      syncApplyNow: () => Promise<{ ok: boolean; applied: number; blocked: number; warnings: string[]; error?: string }>;
      /** P6 staging 模式:取消待应用更新 */
      syncClearStaging: () => Promise<{ ok: boolean; cleared?: number; error?: string }>;
      /** P6 staging 模式:查待应用文件数 */
      syncPendingApplyCount: () => Promise<number>;
      loadConfig: () => Promise<AppConfig>;
      saveConfig: (config: AppConfig) => Promise<SaveConfigResult>;
      selectFolder: (defaultPath?: string) => Promise<SelectFolderResult>;
      selectPath: (opts: { defaultPath?: string; mode: 'file' | 'folder' | 'both' }) => Promise<SelectPathResult>;
      onSyncResult?: (callback: (result: unknown) => void) => () => void;
      // 订阅主进程推送的同步前 preflight(目标程序文件锁状态)
      onSyncPreflight?: (callback: (info: { executableLocked: boolean; relPath: string }) => void) => () => void;
      countFiles: () => Promise<CountFilesResult>;
      historyList: (opts?: { limit?: number; offset?: number }) => Promise<HistoryListResult>;
      historyDelete: (id: number) => Promise<HistoryDeleteResult>;
      backupList: () => Promise<BackupItem[]>;
      backupRollback: (id: number) => Promise<BackupRollbackResult>;
      backupDelete: (id: number) => Promise<BackupDeleteResult>;
      userDecide: (action: UserDecideAction, hash: string) => Promise<UserDecideResult>;
      stateGet: () => Promise<AppStateInfo | null>;
      stateSetPopupEnabled: (enabled: boolean) => Promise<StateSetPopupEnabledResult>;
      autostartGet: () => Promise<AutostartStatus>;
      autostartSet: (enabled: boolean) => Promise<AutostartResult>;
      mappingsApplyAll: () => Promise<MappingsApplyResult>;
      mappingsTestOne: (id: string) => Promise<MappingsApplyResult>;
      sourceTest: (source: string) => Promise<SourceTestResult>;
      getRemoteInfo: () => Promise<RemoteAccessInfo | null>;
      setRemoteEnabled: (enabled: boolean) => Promise<{ ok: boolean; error?: string; info?: RemoteAccessInfo | null }>;
      resetRemotePassword: () => Promise<{ ok: boolean; error?: string; newPassword?: string; info?: RemoteAccessInfo | null }>;
      listNetworkIPs: () => Promise<Array<{ name: string; address: string; family: 'IPv4' | 'IPv6'; internal: boolean; mac: string }>>;
      openExternal: (url: string) => Promise<void>;
      onUpdatePrompt: (callback: (payload: UpdatePromptPayload) => void) => () => void;
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
