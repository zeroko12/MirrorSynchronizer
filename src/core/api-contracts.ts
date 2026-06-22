/**
 * 跨进程 API 契约类型
 *
 * 单一真相源:preload / renderer / main 三处都从这里 import,不再各自手抄
 * 任何 IPC 通道的入参 / 返回值类型都集中在这里
 *
 * 设计原则:
 * - 不依赖 Electron / DOM API,可在 main / preload / renderer / 测试 任意环境用
 * - 字段命名统一 camelCase,不做跨边界转换
 * - 未来扩展(如 WebDAV adapter)只需追加 union 成员,不破坏现有消费者
 */

import type { PathErrorKind } from './errors.js';
import type { AppConfig, FileMapping, SyncResult } from './types.js';

/* ============================ 文件夹 / 路径选择 ============================ */

export interface SelectFolderResult {
  canceled: boolean;
  path: string | null;
}

export interface SelectPathResult {
  canceled: boolean;
  path: string | null;
  isDirectory: boolean;
}

export interface SaveConfigResult {
  ok: boolean;
  error?: string;
}

/* ============================ 状态(实时仪表盘) ============================ */

export interface LastResultInfo {
  added: number;
  modified: number;
  deleted: number;
  durationMs: number;
  ok: boolean;
  /** 同步语义分类(网络 / 权限 / 不存在 / ...)— 驱动 UI 提示 */
  fatalReason: PathErrorKind | null;
}

export interface StatusInfo {
  sourceDir: string;
  targetDir: string;
  backupDir: string;
  intervalSec: number;
  backupCount: number;
  autostart: boolean;
  fileMappings: FileMapping[];
  running: boolean;
  lastResult: LastResultInfo | null;
  /** 网络类错误连续次数(0 = 当前网络正常) */
  consecutiveNetworkFailures: number;
  /** 距下次运行的毫秒数(退避中时不为 null) */
  nextRunDelayMs: number | null;
  /** 上次 fatal 错误的语义类别 */
  lastFatalReason: PathErrorKind | null;
}

/* ============================ 调试 ============================ */

export interface CountFilesResult {
  source: number;
  target: number;
  sourcePath: string;
  targetPath: string;
  sourceFatal: boolean;
  targetFatal: boolean;
}

/* ============================ 历史 ============================ */

export interface HistoryItem {
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
}

export interface HistoryListResult {
  items: HistoryItem[];
  total: number;
}

export interface HistoryDeleteResult {
  ok: boolean;
  error?: string;
}

/* ============================ 备份 ============================ */

export interface BackupItem {
  id: number;
  createdAt: number;
  sourceDir: string;
  targetDir: string;
  snapshotPath: string;
  fileCount: number;
  sizeBytes: number;
  /** 文件系统有但 DB 未登记的快照(冷启动扫描补登后置 true) */
  _stale?: boolean;
}

export interface BackupRollbackResult {
  ok: boolean;
  error?: string;
  safetySnapshotPath?: string;
}

export interface BackupDeleteResult {
  ok: boolean;
  error?: string;
}

/* ============================ 弹窗决策 ============================ */

/** 主进程推送到 renderer 的"有变化待确认"事件 payload */
export interface UpdatePromptPayload {
  hash: string;
  addedCount: number;
  modifiedCount: number;
  deletedCount: number;
  /** 是否处于回退后的锁定状态 */
  isLocked: boolean;
  lockSnapshotTimestamp: string | null;
}

export type UserDecideAction = 'apply' | 'snooze' | 'ignore';
export interface UserDecideResult {
  ok: boolean;
  error?: string;
}

/* ============================ 运行时状态(popup / 暂休 / 回退锁) ============================ */

export interface AppStateInfo {
  lastShownChangeHash: string | null;
  postRollbackLock: {
    snapshotTimestamp: string;
    syncId: number;
    lockedAt: number;
  } | null;
  snoozeUntil: number;
  popupEnabled: boolean;
}

export interface StateSetPopupEnabledResult {
  ok: boolean;
  error?: string;
}

/* ============================ 开机自启动 ============================ */

export interface AutostartStatus {
  openAtLogin: boolean;
}

export interface AutostartResult extends AutostartStatus {
  ok: boolean;
  error?: string;
}

/* ============================ 文件映射 ============================ */

export interface MappingsApplyResult {
  ok: boolean;
  mappingCopied?: string[];
  mappingSkippedExisting?: string[];
  mappingSkipped?: string[];
  warnings?: string[];
  error?: string;
}

/* ============================ 源测试(预览) ============================ */

export type SourceAdapterKind = 'fs' | 'http' | 'webdav';

export interface SourceTestFileEntry {
  relPath: string;
  size: number;
  mtimeMs: number;
  etag?: string;
}

/**
 * 源测试结果(只读,不改 config)
 * 用于 UI 预览 + 错误归类展示
 */
export interface SourceTestResult {
  ok: boolean;
  adapterKind?: SourceAdapterKind;
  // 成功
  fileCount?: number;
  totalSize?: number;
  sample?: SourceTestFileEntry[];
  // 失败
  error?: string;
  fatalReason?: PathErrorKind;
  // 计时
  durationMs: number;
}

/* ============================ 同步结果(renderer 端事件) ============================ */

/** 同步结果(可序列化版本,跨 IPC 传输) */
export type SyncResultWire = SyncResult;
export type AppConfigWire = AppConfig;

/* ============================ 远程访问 ============================ */

export interface RemoteAccessInfo {
  enabled: boolean;
  running: boolean;
  url: string | null;
  port: number | null;
  /** 首次启动的初始密码(明文,展示一次后用户复制) */
  initialPassword: string | null;
  passwordReset: boolean;
  clientCount: number;
}
