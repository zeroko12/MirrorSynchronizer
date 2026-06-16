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
import { dirname } from 'node:path';
import { Syncer } from './syncer.js';
import type { AppConfig, FileEntry, SchedulerStatus, SyncResult } from './types.js';

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
  private consecutiveFailures = 0;
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
  setDryRun(dryRun: boolean): void {
    this.dryRunMode = dryRun;
  }

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
      lastResult: this.lastResult,
      consecutiveFailures: this.consecutiveFailures,
    };
  }

  private scheduleNext(delayMs: number): void {
    if (this.stopped) return;
    this.nextRunAt = Date.now() + delayMs;
    this.timer = setTimeout(async () => {
      this.timer = null;
      await this.runOnce();
      if (!this.stopped) {
        this.scheduleNext(this.config.intervalSec * 1000);
      }
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
      if (!this.dryRunMode) {
        await this.saveIndex(newSourceIndex);
      }

      this.lastRunAt = Date.now();
      this.lastResult = result;

      if (!result.ok) {
        this.consecutiveFailures++;
        if (this.consecutiveFailures >= 3 && this.onFatalError) {
          this.onFatalError(this.consecutiveFailures, result);
        }
      } else {
        this.consecutiveFailures = 0;
      }

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
      };
      this.lastResult = failedResult;
      this.consecutiveFailures++;
      if (this.onFatalError && this.consecutiveFailures >= 3) {
        this.onFatalError(this.consecutiveFailures, failedResult);
      }
      return failedResult;
    } finally {
      this.inFlight = false;
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
    await fs.mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(entries), 'utf-8');
    await fs.rename(tmp, path);
  }
}
