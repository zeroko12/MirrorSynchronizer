/**
 * fs 工具:atomic JSON 读写
 *
 * 行业标准做法:写 .tmp 再 rename,避免崩溃时半成品
 * - Windows:rename 在同一卷上是原子的
 * - 出错时清理 .tmp
 * - 读时损坏文件返回 fallback(不抛)
 */

import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * 原子写 JSON:写 .tmp + rename
 * 失败时清理半成品文件
 */
export async function atomicWriteJson(path: string, data: unknown): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  try {
    await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf-8');
    await fs.rename(tmp, path);
  } catch (err) {
    // 清理半成品
    try {
      await fs.unlink(tmp);
    } catch {
      // ignore — tmp 可能不存在
    }
    throw err;
  }
}

/**
 * 读 JSON:损坏 / 不存在 返回 fallback,不抛
 */
export async function readJsonSafe<T>(path: string, fallback: T): Promise<T> {
  try {
    const raw = await fs.readFile(path, 'utf-8');
    return JSON.parse(raw) as T;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return fallback;
    // 文件存在但损坏 → log + fallback(与 state.ts 历史行为一致)
    return fallback;
  }
}

/** 衍生 .tmp 路径(给那些需要分两步写的场景,如 scheduler.saveIndex) */
export function tmpPathFor(target: string): string {
  return join(dirname(target), `.${target.split(/[\\/]/).pop() ?? 'file'}.tmp`);
}
