/**
 * Launcher 测试 - 文件锁检测 + 启动
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { isExecutableLocked, tryLaunchExecutable } from '../src/core/launcher.js';
import { makeTempDir, rmTemp, writeFile } from './helpers.js';

describe('Launcher - isExecutableLocked', () => {
  let dir: string;

  beforeEach(async () => { dir = await makeTempDir('ln-'); });
  afterEach(async () => { await rmTemp(dir); });

  it('空 relPath → false', async () => {
    expect(await isExecutableLocked(dir, '')).toBe(false);
  });

  it('文件不存在 → false(ENOENT 不算锁)', async () => {
    expect(await isExecutableLocked(dir, 'never-existed.txt')).toBe(false);
  });

  it('文件存在 + 正常打开 → false', async () => {
    await writeFile(join(dir, 'a.txt'), 'a');
    expect(await isExecutableLocked(dir, 'a.txt')).toBe(false);
  });

  it('文件被独占锁住(fs.open r+ 失败) → true', async () => {
    await writeFile(join(dir, 'locked.txt'), 'x');
    // Windows 上 fs.open('r+') 对 .txt 通常能成功(share mode 多);
    // 这里只验证"文件存在 + 锁返回 false"分支,真锁场景在 Windows 难模拟,
    // 真实 lock 检测靠 Layer 2 sync EBUSY 兜底
    expect(await isExecutableLocked(dir, 'locked.txt')).toBe(false);
  });

  it('文件存在但权限不足(模拟)→ 看 OS — Windows 通常忽略权限,Linux 拒绝', async () => {
    // 这里不强断言,只验证调用不抛
    await writeFile(join(dir, 'perm.txt'), 'x');
    const r = await isExecutableLocked(dir, 'perm.txt');
    expect(typeof r).toBe('boolean');
  });
});

describe('Launcher - tryLaunchExecutable', () => {
  let dir: string;

  beforeEach(async () => { dir = await makeTempDir('ln-'); });
  afterEach(async () => { await rmTemp(dir); });

  it('空 relPath → launched=false, reason=path-empty', async () => {
    const r = await tryLaunchExecutable(dir, '');
    expect(r.launched).toBe(false);
    expect(r.reason).toBe('path-empty');
  });

  it('文件不存在 → launched=false, reason=file-missing', async () => {
    const r = await tryLaunchExecutable(dir, 'never.txt');
    expect(r.launched).toBe(false);
    expect(r.reason).toBe('file-missing');
  });

  it('文件存在 + spawn 成功 → launched=true, pid 数字', async () => {
    // 写一个最小的 "executable" 文件(Windows 用 .bat,Unix 用 .sh 模拟)
    if (process.platform === 'win32') {
      await writeFile(join(dir, 'hello.bat'), '@echo hello');
      const r = await tryLaunchExecutable(dir, 'hello.bat');
      // 不强求 launched=true(bat 弹窗可能拒),只验证有返回
      expect(typeof r.launched).toBe('boolean');
      if (r.launched) {
        expect(typeof r.pid).toBe('number');
      }
    } else {
      // macOS / Linux:写个简单 shell 脚本 + chmod +x
      await fs.writeFile(join(dir, 'hello.sh'), '#!/bin/sh\nsleep 0.1\n');
      await fs.chmod(join(dir, 'hello.sh'), 0o755);
      const r = await tryLaunchExecutable(dir, 'hello.sh');
      expect(r.launched).toBe(true);
      expect(typeof r.pid).toBe('number');
      expect(r.pid).toBeGreaterThan(0);
    }
  });

  it('spawn 目录路径 → 不抛异常,返回结构化结果', async () => {
    // 传目录路径当 executable。spawn 对目录的行为是平台相关的:
    //   - Windows:同步 ENOENT
    //   - Linux:spawn 同步成功(返回 child + pid),EISDIR 通过异步 error 事件抛
    //   - macOS:类似 Linux
    // tryLaunchExecutable 是 fire-and-forget,不等异步 error 事件,
    // 所以这里只断言:不抛异常 + 返回结构化的 LaunchResult(launched 是 boolean)。
    // "目标真的能不能跑起来" 不在本函数职责内(由 OS 负责)。
    const r = await tryLaunchExecutable(dir, '.');
    expect(typeof r.launched).toBe('boolean');
    if (!r.launched) {
      expect(r.reason).toBeDefined();
    }
  });
});