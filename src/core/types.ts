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
  /** staging 模式下,写到 stagingDir 等 swap 的文件数。immediate 模式恒为 0 */
  pendingApplyCount?: number;
  /**
   * 同步后目标可执行文件的状态(只在 executablePath 配置时填)
   * - 'success': 成功落到 target/(会被启动)
   * - 'blocked': 被锁,EBUSY 跳过(不会启动)
   * - 'skipped': 不在 sync 范围(ignoreItems 命中 / 文件不存在)
   */
  executableUpdate?: 'success' | 'blocked' | 'skipped';
  /**
   * 同步前检测到的目标可执行文件锁状态(只在 executablePath 配置时填)
   * - true:  同步前目标程序在占用
   * - false: 没锁
   */
  executableLocked?: boolean;
  /**
   * 启动后的 PID(只有 success 时填,启动失败没值)
   */
  launchedPid?: number;
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
  /**
   * 同步时忽略的文件/目录列表(相对 target 根)。
   * - 列表里的项 = 相对路径:可以是文件路径(如 "config/local.ini")或目录(如 "cache"、"build/cache")
   * - 目录项会忽略整个子树(任意深度),文件项只忽略该单个文件
   * - 不参与 diff、不拷贝、不删除、不被映射写入
   * - 备份不受影响(rollback 仍能恢复被忽略的内容)
   * - 匹配规则:relPath === item 或 relPath.startsWith(item + '/'),大小写敏感(Windows 文件系统不敏感但匹配仍按字面)
   * - 例:["cache"] 忽略 cache 目录(包含 cache/sub/deep.txt);
   *      ["config/local.ini"] 只忽略 config/local.ini 这一个文件,不影响同目录其他文件
   */
  ignoreItems: string[];
  /**
   * 同步应用模式
   * - 'immediate': 直接写到 targetDir(旧行为,文件被锁会失败)
   * - 'staging':   写到 stagingDir,swap 时再 mv 到 targetDir(文件锁安全)
   * 默认 'staging'(新行为)。
   * 切换 mode:下次 sync 起生效,无需重启。
   */
  applyMode: 'immediate' | 'staging';
  /**
   * staging 目录绝对路径(applyMode='staging' 时使用)。
   * 空字符串 = 派生自 targetDir:`<targetDir>-staging`
   * 类似 backupDir 的处理方式。不允许 == targetDir(否则跟镜像逻辑冲突)。
   */
  stagingDir: string;
  /**
   * 同步真正完成后自动启动的目标可执行文件(相对 target 根)。
   * 空字符串 = 不启动(默认)。
   * 例:"Game/MyGame.exe"
   *
   * 启动时机:
   * - immediate 模式:sync 完成后
   * - staging 模式:swap 完成后(不是 staging sync 完成后)
   *
   * 文件被目标程序占着时,启动会被跳过,UI 会提示"X.exe 未替换"。
   * 远程 trigger (onRemoteRunNow) 不会启动(传 skipLaunch)。
   */
  executablePath: string;
  /**
   * 远程服务器(同 LAN 浏览器访问,只读 + 弹窗决策)
   * v0.1:仅暴露状态/历史/备份,允许远程确认弹窗;远程编辑 config 在 v0.2
   * 默认开启,密码随机生成 + bcrypt 存盘
   */
  remote?: RemoteConfig;
}

export interface RemoteConfig {
  /** 是否启用远程服务器 */
  enabled: boolean;
  /** 监听端口 */
  port: number;
  /** bcrypt 哈希后的密码(明文不存盘) */
  passwordHash: string;
  /** 是否开启 mDNS / 服务广播(LAN 自动发现) */
  autoDiscover: boolean;
  /** 生成的初始密码(明文,仅首次启动后展示给用户一次;之后清空) */
  initialPassword?: string;
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

/**
 * 由 targetDir 派生默认 staging 目录:
 *   D:/game/data        -> D:/game/data-staging
 *   /var/lib/myapp/data -> /var/lib/myapp/data-staging
 *
 * staging 是同步期间"暂存"位置(避开文件锁),
 * swap 时再 mv 到 target。跟 backupDir 同 disk 模式。
 */
export function deriveDefaultStagingDir(targetDir: string): string {
  const trimmed = targetDir.replace(/[\\/]+$/, '');
  return `${trimmed}-staging`;
}

/**
 * 判断 relPath 是否在 ignoreItems 任何一条命中的位置下。
 *
 * 匹配规则(prefix-only):
 * - relPath === item                → 精确匹配(单文件 / 精确路径)
 * - relPath.startsWith(item + '/')  → 在 item 目录下(目录项,任意深度)
 *
 * 不会"跨位置"匹配:`cache` 只匹配 `cache/...`,不会匹配 `subdir/cache/...`
 * 也不会前缀相似匹配:`cache` 不会匹配 `cachefile.txt`(`cache` + `/` 检查不通过)
 *
 * 抽到 types.js 让 syncer / backupper / detector 等都能复用(避免循环 import)
 */
export function isInIgnoredItem(relPath: string, items: readonly string[]): boolean {
  if (items.length === 0) return false;
  for (const item of items) {
    if (relPath === item || relPath.startsWith(item + '/')) return true;
  }
  return false;
}

/** ConfigManager 选项 */
export interface ConfigManagerOptions {
  configPath: PathLike;
  defaults: AppConfig;
}
