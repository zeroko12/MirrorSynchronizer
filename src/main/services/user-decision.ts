/**
 * user-decision - 弹窗决策(apply / snooze / ignore)
 *
 * 渲染进程调用 ipcRenderer.invoke('user:decide', action, hash) 触发
 */

import { Scheduler } from '@core/scheduler';
import { StateManager } from '@core/state';
import { mainLog } from '@core/logger';
import { SNOOZE_DURATION_MS } from '@core/constants';

const log = mainLog;

export type UserDecideAction = 'apply' | 'snooze' | 'ignore';

export async function handleUserDecision(
  stateMgr: StateManager | null,
  scheduler: Scheduler | null,
  action: UserDecideAction,
  hash: string,
): Promise<void> {
  if (!stateMgr) return;
  const state = await stateMgr.load();

  switch (action) {
    case 'apply': {
      // 用户决定"立即同步" → 关闭干运行模式,强制跑一次实际 sync
      await stateMgr.update({ lastShownChangeHash: hash });
      if (scheduler) {
        // 已回退锁 → 先解锁
        if (state.postRollbackLock) {
          await stateMgr.update({ postRollbackLock: null });
          log.info('[decide] 回退锁已解除');
        }
        scheduler.setDryRunMode(false);
        const result = await scheduler.runNow();
        scheduler.setDryRunMode(state.popupEnabled);
        if (result?.ok) {
          log.info('[decide] 用户决定应用,同步成功');
        } else {
          log.error('[decide] 用户决定应用,但同步失败');
        }
      }
      break;
    }
    case 'snooze': {
      // "稍后再问" → 暂休 SNOOZE_DURATION_MS 毫秒
      await stateMgr.update({
        snoozeUntil: Date.now() + SNOOZE_DURATION_MS,
        lastShownChangeHash: hash,
      });
      log.info(`[decide] 用户暂休 ${SNOOZE_DURATION_MS / 1000}s`);
      break;
    }
    case 'ignore': {
      // "忽略本次" → 标记为已读,不实际同步
      await stateMgr.update({ lastShownChangeHash: hash });
      log.info('[decide] 用户忽略本次');
      break;
    }
  }
}
