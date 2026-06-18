/**
 * Scheduler - 间隔轮询调度器
 *
 * 设计要点:
 * - 用 setTimeout 链而非 setInterval:每次跑完才排下一次,避免重叠
 * - 支持 pause / resume / runNow
 * - 错误不致命:连续失败只累加计数,到达阈值后通过 callback 通知
 * - 不在 in-flight 时再触发 runNow
 */

import { promises as fs } from 'node:fs';
import { Syncer } from './syncer.js';
import type { AppConfig, FileEntry, SchedulerStatus, SyncResult } from './types.js';
import { isNetworkReason, type PathErrorKind } from './errors.js';
import { atomicWriteJson } from './fs-utils.js';
import { CONSECUTIVE_FAILURES_THRESHOLD, MAX_BACKOFF_MS } from './constants.js';

/**
 * 指数退避(参考 AWS Full Jitter 算法)
 * delay = random(0, min(base * 2^(n-1), max))
 *
 * @param baseMs 用户配置的 intervalSec
 * @param consecutiveFailures 连续失败次数
 * @returns 退避毫秒数
 */
export function computeBackoff(baseMs: number, consecutiveFailures: number): number {
  if (consecutiveFailures <= 0) return baseMs;
  // 2^(n-1),n=1 → 1, n=2 → 2, n=3 → 4, n=4 → 8 ...
  const exp = Math.min(baseMs * 2 ** (consecutiveFailures - 1), MAX_BACKOFF_MS);
  // Full jitter:在 [0, exp] 间均匀随机
  return Math.floor(Math.random() * exp);
}

export interface SchedulerOptions {
  config: AppConfig;
  /** 上次源索引缓存路径,null 表示不持久化 */
  indexCachePath?: string;
  /** 每次同步后回调 */
  onSync?: (result: SyncResult) => void | Promise<void>;
  /** 连续失败达到阈值时回调(默认 3) */
  onFatalError?: (consecutiveFailures: number, lastResult: SyncResult) => void;
}

export class Scheduler {
  private config: AppConfig;
  private readonly indexCachePath: string | null;
  private readonly onSync?: SchedulerOptions['onSync'];
  private readonly onFatalError?: SchedulerOptions['onFatalError'];

  private timer: NodeJS.Timeout | null = null;
  private inFlight = false;
  private stopped = false;
  private lastResult: SyncResult | null = null;
  private lastRunAt: number | null = null;
  private nextRunAt: number | null = null;
  private nextRunDelayMs: number | null = null;
  private consecutiveFailures = 0;
  private consecutiveNetworkFailures = 0;
  private lastFatalReason: PathErrorKind | null = null;
  /** P4: 干运行模式 — 只扫描不实际同步,用于弹窗询问模式 */
  private dryRunMode = false;

  constructor(options: SchedulerOptions) {
    this.config = options.config;
    this.indexCachePath = options.indexCachePath ?? null;
    this.onSync = options.onSync;
    this.onFatalError = options.onFatalError;
  }

  /**
   * P4: 设置干运行模式
   * true  = 弹窗询问模式(syncer 只扫描,不创建/修改/删除文件)
   * false = 自动镜像模式(实时同步)
   */
  setDryRunMode(dryRun: boolean): void {
    this.dryRunMode = dryRun;
  }

  /**
   * 启动调度器
   */
  start(): void {
    if (this.timer || this.stopped) return;
    this.scheduleNext(0); // 立即跑一次
  }

  /**
   * 停止调度器(等待当前 sync 完成)
   */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    // 等 in-flight 完成
    while (this.inFlight) {
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  /**
   * 立即触发一次(若已在跑则忽略)
   */
  async runNow(): Promise<SyncResult | null> {
    if (this.inFlight) return null;
    return this.runOnce();
  }

  /**
   * 热更新配置(不改 intervalSec / fileMappings 的语义边界)
   */
  updateConfig(config: AppConfig): void {
    this.config = config;
  }

  getStatus(): SchedulerStatus {
    return {
      running: this.timer !== null && !this.stopped,
      intervalSec: this.config.intervalSec,
      lastRunAt: this.lastRunAt,
      nextRunAt: this.nextRunAt,
      nextRunDelayMs: this.nextRunDelayMs,
      lastResult: this.lastResult,
      consecutiveFailures: this.consecutiveFailures,
      consecutiveNetworkFailures: this.consecutiveNetworkFailures,
      lastFatalReason: this.lastFatalReason,
    };
  }

  private scheduleNext(delayMs: number): void {
    if (this.stopped) return;
    // 清除旧 timer(runNow 触发后,原来排程的 timer 还在事件循环里)
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.nextRunAt = Date.now() + delayMs;
    this.nextRunDelayMs = delayMs;
    this.timer = setTimeout(async () => {
      this.timer = null;
      this.nextRunDelayMs = null;
      await this.runOnce();
      // 下次排程由 runOnce 内部根据成功/失败决定(指数退避 vs 正常)
    }, delayMs);
  }

  private async runOnce(): Promise<SyncResult | null> {
    if (this.inFlight) return null;
    this.inFlight = true;
    try {
      const lastIndex = await this.loadIndex();
      const syncer = new Syncer(this.config);
      const { result, newSourceIndex } = await syncer.sync(lastIndex, {
        dryRun: this.dryRunMode,
      });
      // dryRun 时不更新索引(因为没真的同步,下次还要再 diff 出来)
      if (!this.dryRunMode && result.ok) {
        await this.saveIndex(newSourceIndex);
      }

      this.lastRunAt = Date.now();
      this.lastResult = result;
      this.lastFatalReason = result.fatalReason ?? null;

      // 排下次 + 更新计数(在 onSync 之前,让 callback 拿到最新状态)
      this.scheduleAfterResult(result);

      // onSync 回调 — 让上层(主进程)处理 UI/通知
      if (this.onSync) {
        await this.onSync(result);
      }
      return result;
    } catch (err) {
      const failedResult: SyncResult = {
        startedAt: Date.now(),
        durationMs: 0,
        ok: false,
        added: [],
        modified: [],
        deleted: [],
        mappingCopied: [],
        mappingSkippedExisting: [],
        mappingSkipped: [],
        unchanged: 0,
        warnings: [],
        backupCreated: false,
        fatalError: `调度器异常: ${(err as Error).message}`,
        fatalReason: 'unknown',
        fatalTarget: 'config',
      };
      this.lastResult = failedResult;
      this.lastFatalReason = 'unknown';
      // 异常按网络类处理(常见:SMB 突然断)
      this.scheduleAfterResult(failedResult);
      if (this.onSync) {
        await this.onSync(failedResult);
      }
      return failedResult;
    } finally {
      this.inFlight = false;
    }
  }

  /**
   * 根据结果排下次:
   * - 成功 → 重置计数,按 intervalSec 排
   * - 网络类失败 → 累加网络失败计数,指数退避
   * - 其他 fatal → 累加 consecutiveFailures,正常 interval(用户要修配置)
   */
  private scheduleAfterResult(result: SyncResult): void {
    if (this.stopped) return;

    if (result.ok) {
      this.consecutiveFailures = 0;
      this.consecutiveNetworkFailures = 0;
      this.scheduleNext(this.config.intervalSec * 1000);
      return;
    }

    this.consecutiveFailures++;
    if (this.consecutiveFailures >= CONSECUTIVE_FAILURES_THRESHOLD && this.onFatalError) {
      this.onFatalError(this.consecutiveFailures, result);
    }

    if (isNetworkReason(result.fatalReason)) {
      this.consecutiveNetworkFailures++;
      const backoff = computeBackoff(this.config.intervalSec * 1000, this.consecutiveNetworkFailures);
      this.scheduleNext(backoff);
    } else {
      // 非网络 fatal(权限/不存在/磁盘满):退避无意义,按正常 interval 重试
      this.consecutiveNetworkFailures = 0;
      this.scheduleNext(this.config.intervalSec * 1000);
    }
  }

  private async loadIndex(): Promise<FileEntry[] | null> {
    if (!this.indexCachePath) return null;
    try {
      const raw = await fs.readFile(this.indexCachePath, 'utf-8');
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as FileEntry[]) : null;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      return null; // 损坏就当作首次
    }
  }

  private async saveIndex(entries: FileEntry[]): Promise<void> {
    if (!this.indexCachePath) return;
    const path = this.indexCachePath;
    await atomicWriteJson(path, entries);
  }
}
