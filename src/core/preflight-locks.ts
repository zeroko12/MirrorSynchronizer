/**
 * Preflight 锁检测 — "swap 关闭"模式的前置探测
 *
 * 用途(applyMode === 'immediate-with-precheck'):
 *   用户希望直接写 target,但写之前先确认所有目标文件**没被锁**。
 *   任何一个文件被锁 → 整次同步拒绝,只弹窗告知。
 *
 * 设计:
 * - 复用 launcher.isExecutableLocked 的 fs.open(r+) 探测(Windows share mode 准;
 *   POSIX advisory lock 不可靠但 Layer 2 EBUSY 兜底)
 * - 全或无:任一失败立即返回,不再尝试后续文件
 * - ENOENT 跳过(将作为新增,目标不存在 → 不存在锁)
 * - 用 Promise.all 并行探测,O(N) 总耗时 ~ max(单文件),不是 sum
 * - 成功路径立即关 fh(我们不保留任何 handle)
 */

import { promises as fs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { coreLog } from './logger.js';

export interface PreflightResult {
  /** 全部能开 → true;任一锁住 → false */
  ok: boolean;
  /** 第一个被锁的 relPath(失败时填,UI 用来告诉用户哪个文件占着) */
  lockedRel?: string;
  /** OS 错误码(失败时填):EBUSY/EPERM/EACCES */
  lockedCode?: 'EBUSY' | 'EPERM' | 'EACCES' | string;
}

/**
 * 探测 targetDir 下所有 relPath 是否可独占打开。
 *
 * @param targetDir  同步目标根目录
 * @param relPaths   这次同步要碰的相对路径列表(ADD/MODIFY/DELETE 合并)
 * @returns          {ok: true} 或第一个失败文件的 {ok: false, lockedRel, lockedCode}
 */
export async function preflightTargetFilesWritable(
  targetDir: string,
  relPaths: readonly string[],
): Promise<PreflightResult> {
  if (relPaths.length === 0) return { ok: true };

  // 并行探测 — 但只要任一失败就 reject,不再继续
  // 实现:逐个 await,任一失败立刻 return(全或无语义)
  for (const rel of relPaths) {
    const abs = join(targetDir, rel);
    let fh: FileHandle | null = null;
    try {
      try {
        // r+ = 读+写,等价于 Windows 探测 share mode;POSIX 上 advisory lock
        // 检测不到(只 fs.open 不会触发 lock 失败),但 Layer 2 EBUSY 兜底
        fh = await fs.open(abs, 'r+');
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') {
          // 文件不存在 → 将作为新增(我们只覆盖/删除,新增不会撞锁)
          continue;
        }
        if (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES') {
          coreLog.warn(`[preflight] locked: ${rel} (${code})`);
          return { ok: false, lockedRel: rel, lockedCode: code };
        }
        // 其他错误(权限错乱 / I/O 错误 / 长路径) — 当作 precheck 失败
        coreLog.warn(`[preflight] failed: ${rel} (${code ?? (err as Error).message})`);
        return {
          ok: false,
          lockedRel: rel,
          lockedCode: code ?? 'PRECHECK-ERROR',
        };
      }
    } finally {
      if (fh) {
        try {
          await fh.close();
        } catch {
          // 关闭失败不影响探测结果,忽略
        }
      }
    }
  }

  return { ok: true };
}
