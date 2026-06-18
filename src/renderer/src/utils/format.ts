/**
 * 渲染层通用格式化函数
 *
 * 单一真相源 — 任何视图里出现"格式化数字/时间/字节"都走这里
 * 避免 SettingsView 写一份 formatBytes、BackupsView 写一份 formatSize 的漂移
 */

/** 字节数 → 人类可读(KB/MB/GB) */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '-';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** 毫秒时间戳 → 本地化字符串(YYYY-MM-DD HH:mm:ss) */
export function formatTimestamp(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '-';
  return new Date(ms).toLocaleString('zh-CN', { hour12: false });
}

/** 毫秒数 → "X 秒/分/小时" 简短格式 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '-';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
  return `${Math.floor(ms / 3_600_000)}h`;
}

/** 距未来的毫秒数 → "Ns 后重试" */
export function formatRetryIn(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const sec = Math.ceil(ms / 1000);
  if (sec < 60) return `${sec}s 后重试`;
  return `${Math.ceil(sec / 60)}m 后重试`;
}
