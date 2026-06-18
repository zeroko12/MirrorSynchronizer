/**
 * 核心类型定义 - 平台无关,可在 Node CLI / Electron 主进程 / 测试中复用
 */

import type { PathLike } from 'node:fs';
import type { PathErrorKind, PathRole } from './errors.js';

/** 文件条目,代表源/目标里的一个文件 */
export interface FileEntry {
  /** 相对目录根的路径,使用正斜杠 */
  relPath: string;
  /** 字节数 */
  size: number;
  /** 最后修改时间(毫秒) */
  mtimeMs: number;
  /** 内容哈希,SHA-256 十六进制,可选(仅冲突消解时计算) */
  hash?: string;
  /** ETag,HTTP 源专用,用于条件请求(If-None-Match) */
  etag?: string;
}

/** 索引缓存,持久化到磁盘,用于检测新增/修改/删除 */
export interface IndexCache {
  /** 索引对应的时间戳 */
  indexedAt: number;
  files: FileEntry[];
}

/** 同步一次的结果 */
export interface SyncResult {
  /** 同步开始时间(毫秒) */
  startedAt: number;
  /** 同步耗时(毫秒) */
  durationMs: number;
  /** 是否成功(没有 fatal error) */
  ok: boolean;
  /** 新增的文件 */
  added: string[];
  /** 修改的文件 */
  modified: string[];
  /** 删除的文件(镜像模式) */
  deleted: string[];
  /** 文件映射规则:实际拷贝的(overwrite=true 全覆盖 / overwrite=false 仅缺失补) */
  mappingCopied: string[];
  /** 文件映射规则:跳过的(目标已存在且 overwrite=false) */
  mappingSkippedExisting: string[];
  /** 文件映射规则:跳过的(源文件不存在) */
  mappingSkipped: string[];
  /** 跳过的(无变化) */
  unchanged: number;
  /** 致命错误(不可恢复,如源目录不可读) */
  fatalError?: string;
  /** 致命错误的语义化类别(用于退避策略和 UI 展示) */
  fatalReason?: PathErrorKind;
  /** 致命错误归属(source/target/mapping/backup/config) */
  fatalTarget?: PathRole;
  /** 非致命警告(如某些文件无法访问) */
  warnings: string[];
  /** 本次同步前创建的快照路径(仅当有 modified/deleted 时才创建) */
  backupSnapshotPath?: string;
  /** 是否本次触发了备份 */
  backupCreated: boolean;
}

/** 调度器状态 */
export interface SchedulerStatus {
  running: boolean;
  intervalSec: number;
  lastRunAt: number | null;
  nextRunAt: number | null;
  /** 距下次运行的延迟(毫秒),可空 */
  nextRunDelayMs: number | null;
  lastResult: SyncResult | null;
  /** 任意 fatal 错误连续次数 */
  consecutiveFailures: number;
  /** 网络类错误连续次数(只对 network-down/timeout 累加) */
  consecutiveNetworkFailures: number;
  /** 上次 fatal 错误的类别 */
  lastFatalReason: PathErrorKind | null;
}

/** 文件映射规则 */
export interface FileMapping {
  id: string;
  name: string;
  sourcePath: string;
  targetRelpath: string;
  enabled: boolean;
  /**
   * false(默认)= 仅在目标缺失时补回(模板/初始文件场景)
   * true        = 每次都覆盖目标(配置文件强制刷新场景)
   *
   * 无论 overwrite 如何,映射目标路径都从镜像删除中豁免
   */
  overwrite: boolean;
  /** 源文件不存在时如何处理 */
  ifSourceMissing: 'skip' | 'keep' | 'delete';
}

/** 应用配置 */
export interface AppConfig {
  sourceDir: string;
  targetDir: string;
  /**
   * 备份目录绝对路径。空字符串 = 派生自 targetDir(<targetDir>-backups)
   * 不允许 = targetDir,否则镜像同步会误删备份
   */
  backupDir: string;
  /** 检查间隔(秒),60 - 604800(7 天) */
  intervalSec: number;
  /** 保留备份数,1 - 20 */
  backupCount: number;
  /** 开机自启动(P5 实现,本阶段只持久化) */
  autostart: boolean;
  /** 配置好映射后是否立即应用(P5 增项,默认 true) */
  applyMappingsImmediately?: boolean;
  /** 文件映射规则 */
  fileMappings: FileMapping[];
}

/**
 * 由 targetDir 派生默认备份目录:
 *   D:/game/data        -> D:/game/data-backups
 *   Z:/updates/app      -> Z:/updates/app-backups
 *   /var/lib/myapp/data -> /var/lib/myapp/data-backups
 */
export function deriveDefaultBackupDir(targetDir: string): string {
  // 去除尾部斜杠,统一格式
  const trimmed = targetDir.replace(/[\\/]+$/, '');
  return `${trimmed}-backups`;
}

/** ConfigManager 选项 */
export interface ConfigManagerOptions {
  configPath: PathLike;
  defaults: AppConfig;
}
