/**
 * 错误原因中文化标签 + UI 友好描述
 *
 * 单一真相源 — main / renderer / 错误消息 全部走这里
 * 避免 UI 中文化散落多处(之前 fatalReasonLabel 在 SettingsView,formatFatalMessage 在 errors)
 */

import type { PathErrorKind } from './errors.js';

/** 简短标签(用于 badge / dropdown / 列) */
export const FATAL_REASON_LABEL: Record<PathErrorKind, string> = {
  'not-found': '路径不存在',
  'network-down': '网络中断',
  'network-not-found': 'SMB/HTTP 不可达',
  'timeout': '连接超时',
  'busy': '资源被占用',
  'permission-denied': '权限不足',
  'disk-full': '磁盘空间不足',
  'target-locked': '目标文件被锁',
  'unknown': '未知错误',
};

/** 详细建议(用于 modal 帮助文本) */
export const FATAL_REASON_ADVICE: Record<PathErrorKind, string> = {
  'not-found': '检查路径是否正确(本地路径需存在,SMB 需已挂载)',
  'network-down': '检查网络连接,源服务器是否可达',
  'network-not-found': '检查 SMB 共享是否已挂载 / HTTP 服务是否可访问',
  'timeout': '服务器响应过慢,可稍后重试',
  'busy': '文件或共享被其他进程占用,稍后重试',
  'permission-denied': '当前用户对源路径无读取权限',
  'disk-full': '目标磁盘空间不足,请清理或更换目录',
  'target-locked': 'applyMode="锁住则拒绝" 检测到目标文件被占用。关闭占用程序后重试,或切换到 staging 模式延迟应用。',
  'unknown': '详见日志(主进程控制台)',
};

/** 给定 reason 返回 label(没匹配用 unknown) */
export function labelOf(reason: PathErrorKind | null | undefined): string {
  if (!reason) return '';
  return FATAL_REASON_LABEL[reason] ?? reason;
}

/** 给定 reason 返回建议(失败 UI 用) */
export function adviceOf(reason: PathErrorKind | null | undefined): string {
  if (!reason) return '';
  return FATAL_REASON_ADVICE[reason] ?? FATAL_REASON_ADVICE.unknown;
}
