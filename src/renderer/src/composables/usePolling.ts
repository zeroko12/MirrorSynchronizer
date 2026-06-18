/**
 * usePolling - 组件级定时轮询 composable
 *
 * 解决 BackupsView / HistoryView / SettingsView 重复实现的"5s/1s setInterval"模式
 *
 * 用法:
 *   usePolling(async () => {
 *     await refreshStatus();
 *   }, 5000);
 *
 * 行为:
 * - onMounted 时立即触发一次(可选,immediate: true 默认)
 * - 之后按 intervalMs 周期性触发
 * - onUnmounted 自动清理 timer
 * - 支持手动 stop()/start()
 */
import { onMounted, onUnmounted } from 'vue';

export interface UsePollingOptions {
  /** 启动时立即触发一次(默认 true) */
  immediate?: boolean;
}

export interface UsePollingReturn {
  stop: () => void;
  start: () => void;
}

export function usePolling(
  fn: () => void | Promise<void>,
  intervalMs: number,
  options: UsePollingOptions = {},
): UsePollingReturn {
  const { immediate = true } = options;
  let timer: number | null = null;

  const stop = (): void => {
    if (timer !== null) {
      window.clearInterval(timer);
      timer = null;
    }
  };

  const start = (): void => {
    stop();
    timer = window.setInterval(() => {
      void Promise.resolve(fn()).catch(() => {
        // 静默:轮询失败不应让组件崩
        // 调用方可以在 fn 内部把错误记到自己的 ref
      });
    }, intervalMs);
  };

  onMounted(() => {
    if (immediate) {
      void Promise.resolve(fn()).catch(() => undefined);
    }
    start();
  });

  onUnmounted(stop);

  return { stop, start };
}
