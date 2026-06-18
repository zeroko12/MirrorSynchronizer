/**
 * 运行时状态持久化
 *
 * 存什么:
 * - lastShownChangeHash: 上一轮"已向用户展示过"的变化集哈希
 *   (变化集 = 当前源/目标 diff 的内容指纹;hash 变了 = 有新变化)
 * - postRollbackLock: 回退后锁,锁定期间同步只扫描不应用
 * - snoozeUntil: 暂休时间戳,期间不弹窗
 * - popupEnabled: 是否启用弹窗(用户在设置里关掉就 false)
 *
 * 与 config 的区别:config 是用户改的设置,state 是工具运行时的状态(改了就覆盖)
 *
 * 路径: <userData>/state.json(跟 config.json 平级)
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { mainLog } from './logger.js';
import { atomicWriteJson } from './fs-utils.js';

export interface PostRollbackLock {
  /** 锁定的快照时间戳(目录名) */
  snapshotTimestamp: string;
  /** 回退时记录的同步 ID(从 history) */
  syncId: number;
  /** 锁定开始时间(毫秒) */
  lockedAt: number;
}

export interface AppState {
  /** 上次向用户展示过的变化集 hash(内容指纹) */
  lastShownChangeHash: string | null;
  /** 回退锁(锁定期间同步暂停应用) */
  postRollbackLock: PostRollbackLock | null;
  /** 暂休到该时间戳(毫秒) */
  snoozeUntil: number;
  /** 是否启用弹窗(用户在 SettingsView 改) */
  popupEnabled: boolean;
}

const DEFAULT_STATE: AppState = {
  lastShownChangeHash: null,
  postRollbackLock: null,
  snoozeUntil: 0,
  popupEnabled: true, // 默认开
};

export class StateManager {
  private readonly statePath: string;
  private cache: AppState | null = null;

  constructor(statePath: string) {
    this.statePath = statePath;
  }

  async load(): Promise<AppState> {
    if (this.cache) return this.cache;
    const fallback: AppState = { ...DEFAULT_STATE };
    try {
      const raw = await fs.readFile(this.statePath, 'utf-8');
      const parsed = JSON.parse(raw) as Partial<AppState>;
      this.cache = { ...fallback, ...parsed };
      return this.cache;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        // 文件存在但损坏 → 仍然用默认
        mainLog.warn('[state] 文件损坏,使用默认:', (err as Error).message);
      }
      this.cache = fallback;
      return this.cache;
    }
  }

  async save(next: AppState): Promise<void> {
    this.cache = { ...next };
    await atomicWriteJson(this.statePath, next);
  }

  async update(patch: Partial<AppState>): Promise<AppState> {
    const current = await this.load();
    const next = { ...current, ...patch };
    await this.save(next);
    return next;
  }

  /**
   * 便捷:重置"已读"标记
   * 下次 sync 会重新触发弹窗
   */
  async markUnread(): Promise<void> {
    await this.update({ lastShownChangeHash: null });
  }

  /**
   * 便捷:检查是否处于暂休期
   */
  async isSnoozed(now: number = Date.now()): Promise<boolean> {
    const s = await this.load();
    return now < s.snoozeUntil;
  }

  /**
   * 便捷:设置暂休
   */
  async snooze(durationMs: number): Promise<void> {
    await this.update({ snoozeUntil: Date.now() + durationMs });
  }

  /**
   * 便捷:激活回退锁
   */
  async lockPostRollback(snapshotTimestamp: string, syncId: number): Promise<void> {
    await this.update({
      postRollbackLock: {
        snapshotTimestamp,
        syncId,
        lockedAt: Date.now(),
      },
    });
  }

  /**
   * 便捷:解除回退锁
   */
  async unlockPostRollback(): Promise<void> {
    await this.update({ postRollbackLock: null });
  }
}

export function defaultStatePath(userDataDir: string): string {
  return join(userDataDir, 'state.json');
}
