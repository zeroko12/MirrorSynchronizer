/**
 * remote server - buildRunSyncAck 单元测试
 *
 * 关键回归:
 *   - 之前的版本 `ok = result != null` 导致 result.ok=false 也报"成功",
 *     反映给 web UI 的是"显示同步成功但实际没成功"。
 *   - 现在按 ok/fatalError 严格判定,并回传 added/modified/deleted 计数
 */

import { describe, it, expect } from 'vitest';
import { buildRunSyncAck } from '../src/main/services/remote/server.js';

describe('buildRunSyncAck', () => {
  it('★ result=null → ok=false + fatal=未返回结果', () => {
    const ack = buildRunSyncAck(null);
    expect(ack.ok).toBe(false);
    expect(ack.fatal).toMatch(/未返回结果/);
    expect(ack.added).toBe(0);
  });

  it('★ result=undefined → ok=false + fatal=未返回结果', () => {
    const ack = buildRunSyncAck(undefined);
    expect(ack.ok).toBe(false);
    expect(ack.fatal).toMatch(/未返回结果/);
  });

  it('★ result.ok=false + fatalError → ok=false + fatal=fatalError(不是 silent success)', () => {
    const ack = buildRunSyncAck({
      ok: false,
      fatalError: '连接 SMB 超时',
    });
    expect(ack.ok).toBe(false);
    expect(ack.fatal).toBe('连接 SMB 超时');
  });

  it('★ result.ok=false 但没 fatalError → ok=false + fatal=默认', () => {
    const ack = buildRunSyncAck({ ok: false });
    expect(ack.ok).toBe(false);
    expect(ack.fatal).toBeTruthy();
  });

  it('result.ok=true + added/modified/deleted → ok=true + 计数回传', () => {
    const ack = buildRunSyncAck({
      ok: true,
      added: ['a.txt', 'b.txt'],
      modified: ['c.txt'],
      deleted: ['d.txt', 'e.txt'],
    });
    expect(ack.ok).toBe(true);
    expect(ack.fatal).toBeNull();
    expect(ack.added).toBe(2);
    expect(ack.modified).toBe(1);
    expect(ack.deleted).toBe(2);
  });

  it('result.ok=true 但空 added/modified/deleted → ok=true + 计数 0', () => {
    const ack = buildRunSyncAck({ ok: true });
    expect(ack.ok).toBe(true);
    expect(ack.added).toBe(0);
    expect(ack.modified).toBe(0);
    expect(ack.deleted).toBe(0);
  });

  it('捕获到异常(超时/IO)→ ok=false + fatal=err.message', () => {
    const ack = buildRunSyncAck(null, new Error('remote run-sync 超时 90s'));
    expect(ack.ok).toBe(false);
    expect(ack.fatal).toBe('remote run-sync 超时 90s');
  });

  it('非 Error 类型异常 → 转 String', () => {
    const ack = buildRunSyncAck(null, 'plain string error');
    expect(ack.ok).toBe(false);
    expect(ack.fatal).toBe('plain string error');
  });

  it('fatalError 不是字符串 → fallback', () => {
    const ack = buildRunSyncAck({ ok: false, fatalError: 42 });
    expect(ack.ok).toBe(false);
    expect(typeof ack.fatal).toBe('string');
  });

  it('added 不是数组 → 计数 0(不崩)', () => {
    const ack = buildRunSyncAck({ ok: true, added: 'not-array' });
    expect(ack.ok).toBe(true);
    expect(ack.added).toBe(0);
  });
});
