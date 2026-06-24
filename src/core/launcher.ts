/**
 * Launcher - 目标可执行文件锁检测 + 启动
 *
 * 设计:
 * - isExecutableLocked 用 fs.open(r+) 试探,EBUSY/EPERM/EACCES 视为锁住
 *   (Windows share mode 有 6 种,fs.open 不会 100% 准;Layer 2 EBUSY 兜底)
 * - tryLaunchExecutable 用 child_process.spawn detached + stdio ignore
 *   不监听子进程生死(spawn 即返回);失败 log warning,不阻塞 sync
 *
 * 不依赖原生模块(Node 自带 fs + child_process)
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { coreLog } from './logger.js';

export interface LaunchResult {
  launched: boolean;
  pid?: number;
  reason?: 'path-empty' | 'rel-invalid' | 'file-missing' | 'spawn-failed';
}

/**
 * 检测目标文件是否被锁(另一个进程以独占或写模式打开着)
 * - Windows:取决于 share mode,接近实时但不一定 100%
 * - Linux/macOS:POSIX 文件锁是 advisory,fs.open(r+) 通常能成功即使被锁
 *   (真正的检测靠 Layer 2 sync 中 EBUSY 兜底)
 *
 * ENOENT 不视为锁(文件不存在时不算锁定,直接返回 false)。
 */
export async function isExecutableLocked(targetDir: string, relPath: string): Promise<boolean> {
  if (!relPath) return false;
  const absPath = join(targetDir, relPath);
  try {
    const fh = await fs.open(absPath, 'r+');
    await fh.close();
    return false;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return false;
    return code === 'EBUSY' || code === 'EPERM' || code === 'EACCES';
  }
}

/**
 * 启动 target/executablePath
 * 失败原因(按优先级):
 *   path-empty  → relPath 为空
 *   file-missing→ 启动前 target 文件已不在
 *   spawn-failed→ spawn() 抛错(罕见)
 *
 * 返回 launched=false + reason 给上层显示。
 * detached + unref:不阻塞主进程退出,fire-and-forget。
 */
export async function tryLaunchExecutable(targetDir: string, relPath: string): Promise<LaunchResult> {
  if (!relPath) return { launched: false, reason: 'path-empty' };
  const absPath = join(targetDir, relPath);

  // 文件存在性
  try {
    await fs.stat(absPath);
  } catch {
    coreLog.warn(`[launch] 文件不存在: ${absPath}`);
    return { launched: false, reason: 'file-missing' };
  }

  // spawn(detached + stdio ignore,fire-and-forget)
  try {
    const child = spawn(absPath, [], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    });
    child.unref(); // 不阻塞主进程退出
    coreLog.info(`[launch] 已启动 ${absPath} (PID=${child.pid ?? '?'})`);
    return { launched: true, pid: child.pid };
  } catch (err) {
    coreLog.error(`[launch] spawn 失败 ${absPath}: ${(err as Error).message}`);
    return { launched: false, reason: 'spawn-failed' };
  }
}