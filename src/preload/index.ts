/**
 * Preload - 暴露安全 API 给 renderer
 *
 * P2 范围:暴露 getStatus / runSyncNow / loadConfig / saveConfig / selectFolder
 *         + onSyncResult 事件订阅(用于 UI 实时刷新)
 * 后续 P3-P5 会逐步扩展
 */

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

export interface SelectFolderResult {
  canceled: boolean;
  path: string | null;
}

export interface SaveConfigResult {
  ok: boolean;
  error?: string;
}

const api = {
  getStatus: (): Promise<unknown> => ipcRenderer.invoke('status:get'),
  runSyncNow: (): Promise<unknown> => ipcRenderer.invoke('sync:runNow'),
  loadConfig: (): Promise<unknown> => ipcRenderer.invoke('config:load'),
  saveConfig: (config: unknown): Promise<SaveConfigResult> =>
    ipcRenderer.invoke('config:save', config),
  selectFolder: (defaultPath?: string): Promise<SelectFolderResult> =>
    ipcRenderer.invoke('dialog:selectFolder', defaultPath),
  selectPath: (opts: { defaultPath?: string; mode: 'file' | 'folder' | 'both' }): Promise<{
    canceled: boolean;
    path: string | null;
    isDirectory: boolean;
  }> => ipcRenderer.invoke('dialog:selectPath', opts),

  // 订阅主进程推送的同步结果事件,P2 用来在 UI 上实时刷新"上次同步"卡片
  onSyncResult: (callback: (result: unknown) => void): (() => void) => {
    const handler = (_e: IpcRendererEvent, result: unknown) => callback(result);
    ipcRenderer.on('sync:result', handler);
    // 返回解绑函数(简单实现,UI 不严格清理)
    return () => ipcRenderer.removeListener('sync:result', handler);
  },

  // 调试:扫描源/目标文件数
  countFiles: (): Promise<{
    source: number;
    target: number;
    sourcePath: string;
    targetPath: string;
    sourceFatal: boolean;
    targetFatal: boolean;
  }> => ipcRenderer.invoke('debug:countFiles'),

  // P3: 历史日志
  historyList: (opts?: { limit?: number; offset?: number }): Promise<{
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
  }> => ipcRenderer.invoke('history:list', opts ?? {}),
  historyDelete: (id: number): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('history:delete', id),

  // P3: 备份
  backupList: (): Promise<Array<{
    id: number;
    createdAt: number;
    sourceDir: string;
    targetDir: string;
    snapshotPath: string;
    fileCount: number;
    sizeBytes: number;
    _stale?: boolean;
  }>> => ipcRenderer.invoke('backup:list'),
  backupRollback: (id: number): Promise<{ ok: boolean; error?: string; safetySnapshotPath?: string }> =>
    ipcRenderer.invoke('backup:rollback', id),
  backupDelete: (id: number): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('backup:delete', id),

  // P4: 弹窗决策、状态查询、popup 开关
  userDecide: (action: 'apply' | 'snooze' | 'ignore', hash: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('user:decide', action, hash),
  stateGet: (): Promise<{
    lastShownChangeHash: string | null;
    postRollbackLock: { snapshotTimestamp: string; syncId: number; lockedAt: number } | null;
    snoozeUntil: number;
    popupEnabled: boolean;
  } | null> => ipcRenderer.invoke('state:get'),
  stateSetPopupEnabled: (enabled: boolean): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('state:setPopupEnabled', enabled),

  // P5: 开机自启动
  autostartGet: (): Promise<{ openAtLogin: boolean }> =>
    ipcRenderer.invoke('autostart:get'),
  autostartSet: (enabled: boolean): Promise<{ ok: boolean; openAtLogin?: boolean; error?: string }> =>
    ipcRenderer.invoke('autostart:set', enabled),

  // P5: 立即应用所有映射规则(无需等同步周期)
  mappingsApplyAll: (): Promise<{
    ok: boolean;
    mappingCopied?: string[];
    mappingSkippedExisting?: string[];
    mappingSkipped?: string[];
    warnings?: string[];
    error?: string;
  }> => ipcRenderer.invoke('mappings:applyAll'),
  mappingsTestOne: (id: string): Promise<{
    ok: boolean;
    mappingCopied?: string[];
    mappingSkippedExisting?: string[];
    mappingSkipped?: string[];
    warnings?: string[];
    error?: string;
  }> => ipcRenderer.invoke('mappings:testOne', id),

  // 监听主进程推送的"需要弹窗确认"事件
  onUpdatePrompt: (callback: (payload: {
    hash: string;
    addedCount: number;
    modifiedCount: number;
    deletedCount: number;
    isLocked: boolean;
    lockSnapshotTimestamp: string | null;
  }) => void): (() => void) => {
    const handler = (_e: IpcRendererEvent, payload: unknown) => callback(payload as Parameters<typeof callback>[0]);
    ipcRenderer.on('update:prompt', handler);
    return () => ipcRenderer.removeListener('update:prompt', handler);
  },

  // 通用 invoke(给 UpdateDialog 用)
  $invoke: (channel: string, ...args: unknown[]) => ipcRenderer.invoke(channel, ...args),
};

contextBridge.exposeInMainWorld('api', api);
contextBridge.exposeInMainWorld('autoUpdater', api);
