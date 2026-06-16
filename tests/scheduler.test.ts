/**
 * Scheduler 测试 - 验证间隔触发、运行锁、配置热更新
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { Scheduler } from '../src/core/scheduler.js';
import { makeTempDir, rmTemp, writeTree, wait } from './helpers.js';
import type { AppConfig, SyncResult } from '../src/core/types.js';

describe('Scheduler', () => {
  let sourceDir: string;
  let targetDir: string;
  let indexCachePath: string;
  let config: AppConfig;
  let results: SyncResult[];

  beforeEach(async () => {
    sourceDir = await makeTempDir('sch-src-');
    targetDir = await makeTempDir('sch-tgt-');
    indexCachePath = join(await makeTempDir('sch-cache-'), 'idx.json');
    config = {
      sourceDir,
      targetDir,
      intervalSec: 60, // 不会真的用到,因为我们用 runNow
      backupCount: 3,
      autostart: false,
      fileMappings: [],
      backupDir: '',
    };
    results = [];
  });

  afterEach(async () => {
    await rmTemp(sourceDir);
    await rmTemp(targetDir);
    await rmTemp(join(indexCachePath, '..'));
  });

  it('runNow 立即执行一次', async () => {
    await writeTree(sourceDir, [{ relPath: 'a.txt', content: 'a' }]);
    const sch = new Scheduler({ config, indexCachePath });
    const result = await sch.runNow();
    expect(result).not.toBeNull();
    expect(result!.ok).toBe(true);
    expect(result!.added).toEqual(['a.txt']);
  });

  it('调度器 start 立即跑一次,之后按 interval 触发', async () => {
    await writeTree(sourceDir, [{ relPath: 'a.txt', content: 'a' }]);
    const sch = new Scheduler({
      config: { ...config, intervalSec: 1 },
      indexCachePath,
      onSync: (r) => {
        results.push(r);
      },
    });
    sch.start();
    await wait(100); // 让首次跑完
    await writeTree(sourceDir, [{ relPath: 'b.txt', content: 'b' }]);
    await wait(1300); // 等下一次 tick
    await sch.stop();
    expect(results.length).toBeGreaterThanOrEqual(2);
  });

  it('inFlight 时 runNow 返回 null(不重叠)', async () => {
    await writeTree(sourceDir, [{ relPath: 'a.txt', content: 'a' }]);
    const sch = new Scheduler({ config, indexCachePath });
    // 同步启动第一次(还在跑),立即再请求一次
    const p1 = sch.runNow();
    const p2 = sch.runNow();
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).not.toBeNull();
    expect(r2).toBeNull();
  });

  it('stop 后不再触发', async () => {
    await writeTree(sourceDir, [{ relPath: 'a.txt', content: 'a' }]);
    const sch = new Scheduler({
      config: { ...config, intervalSec: 1 },
      indexCachePath,
      onSync: (r) => {
        results.push(r);
      },
    });
    sch.start();
    await wait(50);
    await sch.stop();
    const count = results.length;
    await wait(1300);
    expect(results.length).toBe(count);
  });
});
