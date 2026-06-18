/**
 * tryLog - 异步操作的"软失败"包装
 *
 * 替代写法:try { await fn() } catch { ... }
 *
 * 区别:
 * - 失败时把错误打到 console.warn 并加上 label,不让错误悄悄消失
 * - 永远不抛(返回 undefined),调用方不需要再 catch
 * - 若提供 fallback,失败时返回 fallback
 *
 * 用法:
 *   const result = await tryLog('refreshStatus', () => getApi().getStatus());
 *   const fc = await tryLog('countFiles', () => getApi().countFiles(), null);
 */

export async function tryLog<T>(
  label: string,
  fn: () => Promise<T>,
): Promise<T | undefined>;
export async function tryLog<T>(
  label: string,
  fn: () => Promise<T>,
  fallback: T,
): Promise<T>;
export async function tryLog<T>(
  label: string,
  fn: () => Promise<T>,
  fallback?: T,
): Promise<T | undefined> {
  try {
    return await fn();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[tryLog:${label}]`, (err as Error)?.message ?? err);
    return fallback;
  }
}
