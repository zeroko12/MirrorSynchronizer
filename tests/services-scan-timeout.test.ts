/**
 * scan-timeout service 单元测试
 *
 * 验证:
 * - 正常 scan → resolve entries
 * - scan 抛错 → reject 原错
 * - scan 超过 ms → reject 超时错
 */

import { describe, it, expect, vi } from 'vitest';
import { scanWithTimeout } from '../src/main/services/scan-timeout.js';
import type { SourceAdapter, ResourceEntry } from '../src/core/adapter.js';

function mockAdapter(scanImpl: () => Promise<ResourceEntry[]>): SourceAdapter {
  return {
    kind: 'fs',
    scan: scanImpl,
    open: vi.fn(),
    close: vi.fn(),
  };
}

describe('scan-timeout', () => {
  it('正常 scan → resolve entries', async () => {
    const entries: ResourceEntry[] = [
      { relPath: 'a.txt', size: 10, mtimeMs: 1700000000000 },
    ];
    const adapter = mockAdapter(async () => entries);
    const result = await scanWithTimeout(adapter, 1000);
    expect(result).toEqual(entries);
  });

  it('scan 抛错 → reject 原错', async () => {
    const adapter = mockAdapter(async () => {
      throw new Error('源目录不可达');
    });
    await expect(scanWithTimeout(adapter, 1000)).rejects.toThrow('源目录不可达');
  });

  it('scan 慢于超时 → reject 超时错', async () => {
    // 模拟一个永远 hang 的 adapter
    const adapter = mockAdapter(() => new Promise(() => { /* never resolves */ }));
    await expect(scanWithTimeout(adapter, 50)).rejects.toThrow(/连接超时/);
  });

  it('scan 边界(刚到超时)→ 视实现而定,我们只保证行为可预测', async () => {
    // 50ms 后 resolve — 100ms 超时应能等到
    const adapter = mockAdapter(async () => {
      await new Promise((r) => setTimeout(r, 50));
      return [];
    });
    const result = await scanWithTimeout(adapter, 200);
    expect(result).toEqual([]);
  });

  it('adapter.close 不被 scan-timeout 自动调用(由调用方管)', async () => {
    const close = vi.fn();
    const adapter: SourceAdapter = {
      kind: 'fs',
      scan: async () => [],
      open: vi.fn(),
      close,
    };
    await scanWithTimeout(adapter, 1000);
    expect(close).not.toHaveBeenCalled();
  });
});
