/**
 * notification - Windows Toast 通知 + 致命错误分类弹窗
 *
 * 行为:
 * - 网络类 fatal:首次静默(可能瞬断),第 2 次起每次都弹
 * - 其他 fatal(权限/不存在/磁盘满):立即弹
 * - 网络恢复:发一次"已恢复"通知
 *
 * 状态:
 * - wasNetworkDown — 跟踪是否处于网络断状态,用于触发恢复通知
 *   注意:必须在 main 进程模块级共享,因为 scheduler.onSync 是异步回调
 */

import { Notification } from 'electron';
import { isNetworkReason, type PathErrorKind } from '@core/errors';
import { APP_DISPLAY_NAME } from '@core/constants';
import { mainLog } from '@core/logger';

const log = mainLog;

/** 上次是否处于网络错误状态(模块级共享,scheduler.onSync 跨 tick 可见) */
export let wasNetworkDown = false;
export function setWasNetworkDown(v: boolean): void {
  wasNetworkDown = v;
}
export function getWasNetworkDown(): boolean {
  return wasNetworkDown;
}

/** 显示 Windows Toast(吞掉失败,不影响主流程) */
export function showNotification(title: string, body: string): void {
  try {
    if (Notification.isSupported && !Notification.isSupported()) return;
    new Notification({ title, body }).show();
  } catch (e) {
    log.warn('[notification] 显示失败:', (e as Error).message);
  }
}

/** 致命错误时按类别发不同通知 */
export function handleFatalErrorToast(
  reason: PathErrorKind,
  consecutiveNetwork: number,
  nextRunDelayMs: number | null,
): void {
  if (isNetworkReason(reason)) {
    setWasNetworkDown(true);
    // 第一次失败静默(可能瞬断),第二次起才弹
    if (consecutiveNetwork >= 2) {
      const secStr = nextRunDelayMs != null ? ` · ${Math.ceil(nextRunDelayMs / 1000)}s 后重试` : '';
      showNotification(
        '网络不可达',
        `连续 ${consecutiveNetwork} 次失败,源路径网络可能已断开${secStr}`,
      );
    }
    return;
  }
  // 其他致命(权限/不存在/磁盘满)立即弹
  const title = reason === 'permission-denied' ? '权限不足'
    : reason === 'disk-full' ? '磁盘空间不足'
    : reason === 'not-found' ? '路径不存在'
    : '同步失败';
  showNotification(title, '请打开主窗口查看详情');
}

/** 网络恢复通知(成功路径调用) */
export function notifyRecovered(): void {
  showNotification(APP_DISPLAY_NAME, '已恢复同步');
}
