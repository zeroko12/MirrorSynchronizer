/**
 * 应用常量
 *
 * 单一真相源 — 任何数字 / 字符串字面量都走这里
 * 改一次,所有调用点跟随
 *
 * 分类:
 * - 应用标识(应用名、userData 子目录名)
 * - 配置边界(检查间隔、备份数、暂休时长)
 * - 调度器行为(退避上限、致命阈值)
 * - 性能预算(源测试超时、源测试样例数、性能断言阈值)
 * - UI 行为(轮询间隔)
 */

/* ============================ 应用标识 ============================ */

/** 应用显示名(中文)— tray / 主窗口 / toast 共用 */
export const APP_DISPLAY_NAME = '自动更新检测';

/** Electron appId — 来自 package.json,但 CLI 模式读不到,这里兜底 */
export const APP_ID = 'com.local.auto-updater';

/** userData 子目录名(CLI / 主进程共用) */
export const APP_DATA_SUBDIR = 'auto-updater';

/* ============================ 配置边界 ============================ */

/** 同步间隔最小值(秒)— config 校验下界 */
export const MIN_INTERVAL_SEC = 60;

/** 同步间隔最大值(秒)— 7 天 */
export const MAX_INTERVAL_SEC = 7 * 24 * 60 * 60;

/** 保留备份数最小值 */
export const MIN_BACKUP_COUNT = 1;

/** 保留备份数最大值 */
export const MAX_BACKUP_COUNT = 20;

/** 用户暂休时长(毫秒)— 5 分钟 */
export const SNOOZE_DURATION_MS = 5 * 60 * 1000;

/* ============================ 调度器行为 ============================ */

/** 指数退避硬上限(毫秒)— 5 分钟,SMB 重连常见周期 */
export const MAX_BACKOFF_MS = 5 * 60 * 1000;

/** 连续失败阈值(任何 fatal 错误)— 触发 onFatalError 回调 */
export const CONSECUTIVE_FAILURES_THRESHOLD = 3;

/** mtime 比较时 2ms 抖动容忍 — 文件系统精度差异 */
export const MTIME_JITTER_TOLERANCE_MS = 2;

/* ============================ 性能预算 ============================ */

/** 源测试超时(毫秒) */
export const SOURCE_TEST_TIMEOUT_MS = 10_000;

/** 源测试样例文件数(展示给用户的预览) */
export const SOURCE_TEST_SAMPLE_SIZE = 20;

/* ============================ UI 行为 ============================ */

/** 状态栏轮询间隔(毫秒)— SettingsView 5s */
export const UI_STATUS_POLL_MS = 5_000;

/** 列表轮询间隔(毫秒)— Backups/History 1s */
export const UI_LIST_POLL_MS = 1_000;
