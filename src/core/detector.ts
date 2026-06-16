/**
 * Detector - 变化检测 + 弹窗决策
 *
 * 职责:
 * - 每次 sync 跑完后,计算当前变化集(added/modified/deleted)的内容指纹
 * - 对比上次向用户展示过的指纹
 * - 决定要不要弹窗(变化 + 弹窗开启 + 没在暂休 + 锁定场景特殊处理)
 *
 * 设计:
 * - 内容指纹 = sha256(added ∪ modified ∪ deleted 的 relPath + 新 size/mtime 排序)
 *   简单但够用:如果用户改回原状,内容变化但 path+size 一样,hash 也变
 *   (可以容忍 — 多弹一次窗而已)
 * - 锁定场景(回退后):即便变化集 hash 一样也要弹(内容 hash 一样但和"上次的回退状态"不一样)
 */

import { createHash } from 'node:crypto';
import type { SyncResult } from './types.js';

export interface ChangeFingerprint {
  /** 内容指纹(added/modified/deleted 的 path+size+mtime 排序后 hash) */
  hash: string;
  /** 添加的文件数 */
  addedCount: number;
  /** 修改的文件数 */
  modifiedCount: number;
  /** 删除的文件数 */
  deletedCount: number;
}

/**
 * 从 SyncResult 计算内容指纹
 */
export function computeFingerprint(result: SyncResult): ChangeFingerprint {
  const items: string[] = [];
  for (const rel of [...result.added].sort()) items.push(`+${rel}`);
  for (const rel of [...result.modified].sort()) items.push(`~${rel}`);
  for (const rel of [...result.deleted].sort()) items.push(`-${rel}`);
  // 也加 mapping 拷贝的(让 mapping 触发的"新文件"也能被检测出)
  for (const name of [...result.mappingCopied].sort()) items.push(`m:${name}`);

  const hash = createHash('sha256').update(items.join('\n')).digest('hex').slice(0, 16);
  return {
    hash,
    addedCount: result.added.length,
    modifiedCount: result.modified.length,
    deletedCount: result.deleted.length,
  };
}

export type PopupDecision =
  | { kind: 'popup'; reason: 'new-changes' | 'post-rollback'; fingerprint: ChangeFingerprint }
  | { kind: 'silent'; reason: 'no-changes' | 'snoozed' | 'popup-disabled' | 'already-shown' }
  | { kind: 'locked-detect'; fingerprint: ChangeFingerprint }; // 锁定场景,扫描但不弹同步,只弹询问

export interface DecideInput {
  result: SyncResult;
  lastShownChangeHash: string | null;
  popupEnabled: boolean;
  snoozeUntil: number;
  isPostRollbackLockActive: boolean;
  now?: number;
}

/**
 * 决定本次 sync 后要不要弹窗
 */
export function decide(input: DecideInput): PopupDecision {
  const { result, lastShownChangeHash, popupEnabled, snoozeUntil, isPostRollbackLockActive } = input;
  const now = input.now ?? Date.now();

  const fp = computeFingerprint(result);

  // 没变化 → 静默
  if (fp.addedCount + fp.modifiedCount + fp.deletedCount === 0) {
    return { kind: 'silent', reason: 'no-changes' };
  }

  // 锁定场景:有变化但不能直接应用,弹框让用户决定
  if (isPostRollbackLockActive) {
    return { kind: 'locked-detect', fingerprint: fp };
  }

  // 弹窗关闭 → 静默同步(用户主动关的)
  if (!popupEnabled) {
    return { kind: 'silent', reason: 'popup-disabled' };
  }

  // 暂休中 → 静默
  if (now < snoozeUntil) {
    return { kind: 'silent', reason: 'snoozed' };
  }

  // 变化集和上次展示过的一样 → 静默
  if (lastShownChangeHash === fp.hash) {
    return { kind: 'silent', reason: 'already-shown' };
  }

  // 弹!
  return { kind: 'popup', reason: 'new-changes', fingerprint: fp };
}
