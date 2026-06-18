/**
 * scan-timeout - 给 adapter.scan() 加超时保护
 *
 * 超时后 reject — 但底层 fs 扫描仍会跑完(只是不阻塞 UI)
 * HTTP 走 fetch 时,超时后 adapter.close() 会销毁底层 agent,后续请求直接断
 */

import type { ResourceEntry, SourceAdapter } from '@core/adapter';

export function scanWithTimeout(
  adapter: SourceAdapter,
  ms: number,
): Promise<ResourceEntry[]> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`连接超时(>${ms}ms) — 请检查网络或源路径`));
    }, ms);
    adapter.scan()
      .then((entries) => {
        clearTimeout(timer);
        resolve(entries);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}
