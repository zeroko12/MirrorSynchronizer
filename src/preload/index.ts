/**
 * Preload - 暴露安全 API 给 renderer
 *
 * 所有跨进程类型统一从 `@core/api-contracts` import
 * 这里是纯 IPC 桥,不持有业务逻辑
 */

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type {
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

const api = {
  getStatus: (): Promise<StatusInfo> => ipcRenderer.invoke('status:get'),
  runSyncNow: (): Promise<{ ok: boolean; result?: unknown; error?: string }> =>
    ipcRenderer.invoke('sync:runNow'),
  /**
   * 强制真同步 — 即便弹窗模式也立刻真删真拷。用于"保存并立即同步"按钮。
   * 语义跟远程"立即同步"和本地弹窗"应用"按钮一致。
   */
  runSyncNowForce: (): Promise<{ ok: boolean; result?: unknown; error?: string }> =>
    ipcRenderer.invoke('sync:runNowForce'),

  /** P6 staging 模式:立即把 stagingDir 待应用内容 mv 到 target */
  syncApplyNow: (): Promise<{
    ok: boolean;
    applied: number;
    blocked: number;
    warnings: string[];
    error?: string;
  }> => ipcRenderer.invoke('sync:applyNow'),

  /** P6 staging 模式:取消待应用更新(清空 stagingDir) */
  syncClearStaging: (): Promise<{ ok: boolean; cleared?: number; error?: string }> =>
    ipcRenderer.invoke('sync:clearStaging'),

  /** P6 staging 模式:查待应用文件数(给 UI banner) */
  syncPendingApplyCount: (): Promise<number> =>
    ipcRenderer.invoke('sync:pendingApplyCount'),
  loadConfig: (): Promise<unknown> => ipcRenderer.invoke('config:load'),
  saveConfig: (config: unknown): Promise<SaveConfigResult> =>
    ipcRenderer.invoke('config:save', config),
  selectFolder: (defaultPath?: string): Promise<SelectFolderResult> =>
    ipcRenderer.invoke('dialog:selectFolder', defaultPath),
  selectPath: (opts: { defaultPath?: string; mode: 'file' | 'folder' | 'both' }): Promise<SelectPathResult> =>
    ipcRenderer.invoke('dialog:selectPath', opts),

  // 订阅主进程推送的同步结果事件
  onSyncResult: (callback: (result: unknown) => void): (() => void) => {
    const handler = (_e: IpcRendererEvent, result: unknown) => callback(result);
    ipcRenderer.on('sync:result', handler);
    return () => ipcRenderer.removeListener('sync:result', handler);
  },

  // 订阅主进程推送的同步前 preflight 事件(目标程序是否被锁)
  onSyncPreflight: (callback: (info: { executableLocked: boolean; relPath: string }) => void): (() => void) => {
    const handler = (_e: IpcRendererEvent, info: unknown) => callback(info as { executableLocked: boolean; relPath: string });
    ipcRenderer.on('sync:preflight', handler);
    return () => ipcRenderer.removeListener('sync:preflight', handler);
  },

  // 调试:扫描源/目标文件数
  countFiles: (): Promise<CountFilesResult> => ipcRenderer.invoke('debug:countFiles'),

  // 历史
  historyList: (opts?: { limit?: number; offset?: number }): Promise<HistoryListResult> =>
    ipcRenderer.invoke('history:list', opts ?? {}),
  historyDelete: (id: number): Promise<HistoryDeleteResult> =>
    ipcRenderer.invoke('history:delete', id),

  // 备份
  backupList: (): Promise<BackupItem[]> => ipcRenderer.invoke('backup:list'),
  backupRollback: (id: number): Promise<BackupRollbackResult> =>
    ipcRenderer.invoke('backup:rollback', id),
  backupDelete: (id: number): Promise<BackupDeleteResult> =>
    ipcRenderer.invoke('backup:delete', id),

  // 弹窗决策
  userDecide: (action: UserDecideAction, hash: string): Promise<UserDecideResult> =>
    ipcRenderer.invoke('user:decide', action, hash),

  // 运行时状态
  stateGet: (): Promise<{
    lastShownChangeHash: string | null;
    postRollbackLock: { snapshotTimestamp: string; syncId: number; lockedAt: number } | null;
    snoozeUntil: number;
    popupEnabled: boolean;
  } | null> => ipcRenderer.invoke('state:get'),
  stateSetPopupEnabled: (enabled: boolean): Promise<StateSetPopupEnabledResult> =>
    ipcRenderer.invoke('state:setPopupEnabled', enabled),

  // 开机自启动
  autostartGet: (): Promise<AutostartStatus> => ipcRenderer.invoke('autostart:get'),
  autostartSet: (enabled: boolean): Promise<AutostartResult> =>
    ipcRenderer.invoke('autostart:set', enabled),

  // 文件映射
  mappingsApplyAll: (): Promise<MappingsApplyResult> => ipcRenderer.invoke('mappings:applyAll'),
  mappingsTestOne: (id: string): Promise<MappingsApplyResult> => ipcRenderer.invoke('mappings:testOne', id),

  // 源测试(只读,不改 config)
  sourceTest: (source: string): Promise<SourceTestResult> => ipcRenderer.invoke('source:test', source),

  // 远程访问信息
  getRemoteInfo: (): Promise<RemoteAccessInfo | null> => ipcRenderer.invoke('remote:getInfo'),
  setRemoteEnabled: (enabled: boolean): Promise<{ ok: boolean; error?: string; info?: RemoteAccessInfo | null }> =>
    ipcRenderer.invoke('remote:setEnabled', enabled),
  resetRemotePassword: (): Promise<{ ok: boolean; error?: string; newPassword?: string; info?: RemoteAccessInfo | null }> =>
    ipcRenderer.invoke('remote:resetPassword'),
  listNetworkIPs: (): Promise<Array<{ name: string; address: string; family: 'IPv4' | 'IPv6'; internal: boolean; mac: string }>> =>
    ipcRenderer.invoke('remote:listIPs'),
  // 在系统默认浏览器打开 URL
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke('shell:openExternal', url),

  // 监听主进程推送的"需要弹窗确认"事件
  onUpdatePrompt: (callback: (payload: UpdatePromptPayload) => void): (() => void) => {
    const handler = (_e: IpcRendererEvent, payload: unknown) =>
      callback(payload as UpdatePromptPayload);
    ipcRenderer.on('update:prompt', handler);
    return () => ipcRenderer.removeListener('update:prompt', handler);
  },

  // 通用 invoke(逃生口,给需要时用)
  $invoke: (channel: string, ...args: unknown[]) => ipcRenderer.invoke(channel, ...args),
};

contextBridge.exposeInMainWorld('api', api);
contextBridge.exposeInMainWorld('autoUpdater', api);
