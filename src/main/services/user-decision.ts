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
import type { SyncResult } from '@core/types';
import { mainLog } from '@core/logger';
import { SNOOZE_DURATION_MS } from '@core/constants';

const log = mainLog;

export type UserDecideAction = 'apply' | 'snooze' | 'ignore';

export async function handleUserDecision(
  stateMgr: StateManager | null,
  scheduler: Scheduler | null,
  action: UserDecideAction,
  hash: string,
): Promise<{ result: SyncResult | null; state: Awaited<ReturnType<StateManager['load']>> | null }> {
  if (!stateMgr) return { result: null, state: null };
  const state = await stateMgr.load();

  switch (action) {
    case 'apply': {
      // 用户决定"立即同步" → 关闭干运行模式,跑一次实际 sync
      // 注意:这里不写 lastShownChangeHash — 等 sync 跑完后再写"新的 fp"
      // 否则会出现:apply 没成功落地 → 同样 fp 已被 hash 吃掉 → 下次 sync 静默
      // (用户感受:"我点了应用但啥都没发生,下次还不弹框")
      if (!scheduler) return { result: null, state };
      // 已回退锁 → 先解锁
      if (state.postRollbackLock) {
        await stateMgr.update({ postRollbackLock: null });
        log.info('[decide] 回退锁已解除');
      }
      scheduler.setDryRunMode(false);
      // 传 force=true:让 runNow 等 in-flight 完成(用户主动 apply 不该被吞),
      // 同时 launch 守卫会启用 → apply 成功 + 配了 executablePath 才启动
      const result = await scheduler.runNow({ force: true });
      scheduler.setDryRunMode(state.popupEnabled);
      if (result?.ok) {
        log.info('[decide] 用户决定应用,同步成功');
      } else {
        // ★ 重要:让 IPC handler 知道结果(否则它返回 {ok:true},渲染端误报"已同步")
        log.error(
          `[decide] 用户决定应用,但同步失败:${result?.fatalError ?? result?.fatalReason ?? '未知'}`,
        );
      }
      return { result, state };
    }
    case 'snooze': {
      // "稍后再问" → 暂休 SNOOZE_DURATION_MS 毫秒,且把当前 hash 记下做兜底
      await stateMgr.update({
        snoozeUntil: Date.now() + SNOOZE_DURATION_MS,
        lastShownChangeHash: hash,
      });
      log.info(`[decide] 用户暂休 ${SNOOZE_DURATION_MS / 1000}s`);
      return { result: null, state };
    }
    case 'ignore': {
      // "忽略本次" → 标记为已读,不实际同步
      await stateMgr.update({ lastShownChangeHash: hash });
      log.info('[decide] 用户忽略本次');
      return { result: null, state };
    }
  }
}
