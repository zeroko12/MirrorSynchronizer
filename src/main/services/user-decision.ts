/**
 * user-decision - 弹窗决策(apply / snooze / ignore)
 *
 * 渲染进程调用 ipcRenderer.invoke('user:decide', action, hash) 触发
 *
 * 关键设计:
 * - ignore:写当前 hash → 同样 fp 不再弹(用户已决策)
 * - apply:不预先写 hash — sync 跑完后由本次 sync 的 fp 决定:
 *   成功 → 新 fp;partial/failure → 同 fp
 *   写完之后用"apply 后的新 fp"才不会再问已应用的同样变化
 * - snooze:同 ignore,且加暂休时间窗
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
      // 用户决定"立即同步" → 关闭干运行模式,跑一次实际 sync
      // 注意:这里不写 lastShownChangeHash — 等 sync 跑完后再写"新的 fp"
      // 否则会出现:apply 没成功落地 → 同样 fp 已被 hash 吃掉 → 下次 sync 静默
      // (用户感受:"我点了应用但啥都没发生,下次还不弹框")
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
      // "稍后再问" → 暂休 SNOOZE_DURATION_MS 毫秒,且把当前 hash 记下做兜底
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
