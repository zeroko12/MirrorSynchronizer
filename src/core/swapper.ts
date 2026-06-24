/**
 * Swapper - staging ↔ target 原子交换
 *
 * 解决:同步目标程序包时,目标里的 exe/dll 等被 OS 锁住,直接写 target/
 *       会失败。staging 模式下,sync 把新版本写到 sibling stagingDir,
 *       target/ 一行不动;待目标程序退出后,swap 阶段把 staging 内容
 *       mv 到 target/。
 *
 * 设计:
 * - 所有 swap 在一个 mutex 串行(防并发)
 * - swap 前先调 Backupper.createSnapshot 把当前 target/ 备份进 backupDir
 *   → 用户可一键回退到 swap 前的状态
 * - 单文件 rename:同盘 atomic(Windows / Linux / macOS),跨盘 fallback 走 copy+unlink
 * - 部分成功:某文件锁住 → 跳过 + warning,其余继续 swap;
 *   未 swap 的保留在 staging 下次重试
 *
 * 目录结构(stagingDir):
 *   <relPath>...           待 swap 的新文件
 *   .pending-apply         标记文件(空文件,存在 = 有待 swap)
 *   .swapping              mutex lock(运行期存在)
 *   .swap-staging/{ts}/     swap 中临时保存被覆盖的旧文件(成功即清)
 */

import { promises as fs } from 'node:fs';
import { join, dirname } from 'node:path';
import { Backupper } from './backupper.js';
import { coreLog } from './logger.js';

const PENDING_APPLY_FILE = '.pending-apply';
const SWAPPING_LOCK_FILE = '.swapping';
const SWAP_STAGING_DIR = '.swap-staging';

export interface SwapOptions {
  /** 真正的同步目标 */
  targetDir: string;
  /** staging 目录(sibling,默认 `<targetDir>-staging`) */
  stagingDir: string;
  /** backup 目录(给回退用,默认 `<targetDir>-backups`) */
  backupDir: string;
  /** 保留几个 backup(0 = 不轮转但仍创建) */
  backupCount: number;
  /** 目标可执行文件(相对 targetDir),用于跟踪它的 update 状态 */
  executablePath?: string;
}

export interface SwapResult {
  /** 完全成功(applied + blocked 都齐全,无 fatalError) */
  ok: boolean;
  /** 成功 swap 的文件 relPath 列表 */
  applied: string[];
  /** 仍被锁、跳过的文件 relPath 列表 */
  blocked: string[];
  /** swap 前创建的 backup 路径(有就回填) */
  backupSnapshotPath?: string;
  /** 警告信息 */
  warnings: string[];
  /** 致命错误(整个 swap 中止,不会重试) */
  fatalError?: string;
  /** 目标可执行文件的更新状态(只有 executablePath 配置时才填)
   * - 'success': applied
   * - 'blocked': blocked
   * - 'skipped': 不在 swap 范围(没出现在 pendingFiles 里)
   */
  executableUpdate?: 'success' | 'blocked' | 'skipped';
}

/**
 * 检查 staging 目录是否有待 swap 的内容
 * (有 `.pending-apply` 标记 + staging 下有文件)
 */
export async function hasPendingApply(stagingDir: string): Promise<boolean> {
  try {
    const stat = await fs.stat(stagingDir);
    if (!stat.isDirectory()) return false;
  } catch {
    return false;
  }
  // 检查 .pending-apply
  try {
    await fs.stat(join(stagingDir, PENDING_APPLY_FILE));
  } catch {
    return false;
  }
  // 检查有没有实际文件(忽略标记文件和 .swap-staging)
  try {
    const entries = await fs.readdir(stagingDir);
    return entries.some((name) => name !== PENDING_APPLY_FILE && name !== SWAP_STAGING_DIR && name !== SWAPPING_LOCK_FILE);
  } catch {
    return false;
  }
}

/**
 * 计算待应用的文件数量(用于 UI 提示)
 */
export async function countPendingApply(stagingDir: string): Promise<number> {
  if (!(await hasPendingApply(stagingDir))) return 0;
  try {
    const entries = await fs.readdir(stagingDir);
    let count = 0;
    for (const name of entries) {
      if (name === PENDING_APPLY_FILE || name === SWAP_STAGING_DIR || name === SWAPPING_LOCK_FILE) continue;
      const sub = join(stagingDir, name);
      const st = await fs.stat(sub);
      if (st.isFile()) count++;
      else if (st.isDirectory()) {
        // 递归数文件
        count += await countFilesRecursive(sub);
      }
    }
    return count;
  } catch {
    return 0;
  }
}

async function countFilesRecursive(dir: string): Promise<number> {
  let count = 0;
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    if (e.isDirectory()) {
      count += await countFilesRecursive(join(dir, e.name));
    } else if (e.isFile()) {
      count++;
    }
  }
  return count;
}

/**
 * 列出所有待 swap 的文件 relPath(相对 stagingDir)
 */
async function listPendingFiles(stagingDir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string, prefix: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const fullPath = join(dir, e.name);
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (rel === PENDING_APPLY_FILE || rel === SWAPPING_LOCK_FILE) continue;
      if (rel === SWAP_STAGING_DIR) continue; // 整个 .swap-staging 目录跳过
      if (e.isDirectory()) {
        await walk(fullPath, rel);
      } else if (e.isFile()) {
        out.push(rel);
      }
    }
  }
  await walk(stagingDir, '');
  return out;
}

/**
 * 检查 staging 是否跟 target 在同盘(同盘 = 可 atomic rename,跨盘 = 要 copy)
 */
async function isSameVolume(a: string, b: string): Promise<boolean> {
  // 通过尝试创建临时硬链接判断;失败 = 不同盘
  // (Windows 上 fs.constants.SAME_VOLUME 用不上,这个 trick 简单通用)
  const tmpA = join(a, `.__probe_${process.pid}_${Date.now()}`);
  const tmpB = join(b, `.__probe_${process.pid}_${Date.now()}`);
  try {
    await fs.writeFile(tmpA, '');
    try {
      await fs.link(tmpA, tmpB);
      // 成功 = 同盘
      await fs.unlink(tmpB).catch(() => undefined);
      await fs.unlink(tmpA).catch(() => undefined);
      return true;
    } catch {
      await fs.unlink(tmpA).catch(() => undefined);
      return false;
    }
  } catch {
    return false;
  }
}

/**
 * 移动 staging 下的旧版本临时目录回原 staging(供 swap 中断恢复)
 */
async function recoverInterruptedSwap(stagingDir: string, warnings: string[]): Promise<void> {
  const swapStagingRoot = join(stagingDir, SWAP_STAGING_DIR);
  try {
    const entries = await fs.readdir(swapStagingRoot);
    for (const ts of entries) {
      const oldRoot = join(swapStagingRoot, ts);
      const stat = await fs.stat(oldRoot);
      if (!stat.isDirectory()) continue;
      // 把 .swap-staging/{ts}/ 下文件搬回 target/(如果有对应的 target/X)
      const files = await collectAllFiles(oldRoot);
      for (const f of files) {
        const srcPath = join(oldRoot, f);
        const tgtPath = join(stagingDir, f); // 恢复成 staging 内容(主路径会重试)
        try {
          await fs.mkdir(dirname(tgtPath), { recursive: true });
          await fs.rename(srcPath, tgtPath);
        } catch (err) {
          warnings.push(`swap 中断恢复失败: ${f} (${(err as Error).message})`);
        }
      }
      // 删 .swap-staging/{ts} 空目录
      await fs.rm(oldRoot, { recursive: true, force: true });
    }
    // 整个 .swap-staging 清空
    await fs.rm(swapStagingRoot, { recursive: true, force: true });
  } catch {
    // .swap-staging 不存在 = 没有中断,正常
  }
}

async function collectAllFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(d: string, prefix: string): Promise<void> {
    const entries = await fs.readdir(d, { withFileTypes: true });
    for (const e of entries) {
      const full = join(d, e.name);
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(full, rel);
      else out.push(rel);
    }
  }
  await walk(dir, '');
  return out;
}

/**
 * 应用 staging 中的待 swap 内容到 target
 *
 * 流程:
 * 1. 获取 mutex(创建 .swapping 文件)
 * 2. 恢复上次中断的 swap(如有 .swap-staging/{ts}/ 残留)
 * 3. 创建 backup(Backupper.createSnapshot)→ backupDir
 * 4. 列出所有待 swap 文件,逐个尝试 swap
 * 5. 全部成功 → 清空 staging,删 .pending-apply
 * 6. 部分成功 → 保留未成功的文件在 staging,保留 .pending-apply
 * 7. 释放 mutex
 */
export async function applyPending(opts: SwapOptions): Promise<SwapResult> {
  const { targetDir, stagingDir, backupDir, backupCount } = opts;
  const result: SwapResult = {
    ok: false,
    applied: [],
    blocked: [],
    warnings: [],
  };

  // 1. 检查 pending
  if (!(await hasPendingApply(stagingDir))) {
    result.ok = true; // 没东西可做,算成功
    return result;
  }

  // 2. 拿 mutex
  const lockPath = join(stagingDir, SWAPPING_LOCK_FILE);
  try {
    await fs.writeFile(lockPath, String(process.pid), { flag: 'wx' });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      result.fatalError = 'swap 正在进行中(其他实例持有锁),跳过本次';
      result.warnings.push(result.fatalError);
      return result;
    }
    throw err;
  }

  try {
    // 3. 恢复上次中断的 swap
    await recoverInterruptedSwap(stagingDir, result.warnings);

    // 4. 创建 backup(用现有 Backupper,保证回退功能正常)
    try {
      const backupper = new Backupper();
      // 只有 target/ 存在且有内容才备份(空 target 不需要备份)
      try {
        const tgtStat = await fs.stat(targetDir);
        if (tgtStat.isDirectory()) {
          const snap = await backupper.createSnapshot(targetDir, backupDir || undefined);
          result.backupSnapshotPath = snap.path;
          coreLog.info(`[swap] backup created: ${snap.path}`);
          // 轮转
          if (backupCount > 0 && backupDir) {
            await backupper.rotate(backupDir, backupCount).catch(() => undefined);
          }
        }
      } catch (statErr) {
        if ((statErr as NodeJS.ErrnoException).code !== 'ENOENT') throw statErr;
        // target 不存在 — 不需要备份,后面 swap 会创建 target/
      }
    } catch (err) {
      result.warnings.push(`创建 backup 失败(继续 swap): ${(err as Error).message}`);
    }

    // 5. 检测 stagingDir / targetDir 同盘性
    const sameVol = await isSameVolume(stagingDir, targetDir);

    // 6. 列出待 swap 文件
    const pendingFiles = await listPendingFiles(stagingDir);
    if (pendingFiles.length === 0) {
      // pending 标记文件存在但没有实际文件 = 异常状态,清掉
      await fs.unlink(join(stagingDir, PENDING_APPLY_FILE)).catch(() => undefined);
      // executablePath 配置了但 staging 没内容 → 文件早被忽略或没动过
      if (opts.executablePath) {
        result.executableUpdate = 'skipped';
      }
      result.ok = true;
      return result;
    }

    // 7. 逐个 swap
    for (const rel of pendingFiles) {
      const srcPath = join(stagingDir, rel);
      const tgtPath = join(targetDir, rel);
      try {
        // 确保 target 父目录存在
        await fs.mkdir(dirname(tgtPath), { recursive: true });
        if (sameVol) {
          // 同盘 atomic rename
          await fs.rename(srcPath, tgtPath);
        } else {
          // 跨盘 fallback:copy + unlink
          await fs.copyFile(srcPath, tgtPath);
          await fs.unlink(srcPath);
        }
        result.applied.push(rel);
        // ★ 跟踪目标可执行文件 swap 结果
        if (opts.executablePath && rel === opts.executablePath) {
          result.executableUpdate = 'success';
        }
        coreLog.info(`[swap] applied: ${rel}`);
      } catch (err) {
        const e = err as NodeJS.ErrnoException;
        if (e.code === 'EBUSY' || e.code === 'EPERM' || e.code === 'EACCES' || e.code === 'ENOTEMPTY' || e.code === 'EEXIST') {
          // 文件被锁(或目录非空)→ 跳过 + 警告,下次重试
          result.blocked.push(rel);
          result.warnings.push(`swap 跳过(${e.code}): ${rel}`);
          // ★ 跟踪目标可执行文件被锁
          if (opts.executablePath && rel === opts.executablePath) {
            result.executableUpdate = 'blocked';
          }
        } else {
          // 其他错误(磁盘满、路径太长等)→ 跳过 + 警告
          result.blocked.push(rel);
          result.warnings.push(`swap 跳过: ${rel} (${e.code ?? e.message})`);
        }
      }
    }

    // 8. 清空 staging 里成功的文件 + 删 .pending-apply(如果全成功)
    if (result.blocked.length === 0) {
      // 全成功:清空 staging
      for (const rel of result.applied) {
        await fs.unlink(join(stagingDir, rel)).catch(() => undefined);
      }
      await fs.unlink(join(stagingDir, PENDING_APPLY_FILE)).catch(() => undefined);
      // 尝试清空 staging 里的空目录
      await pruneEmptyDirs(stagingDir);
      result.ok = true;
      coreLog.info(`[swap] 完成 applied=${result.applied.length} blocked=${result.blocked.length}`);
    } else {
      // 部分成功:删成功的,保留阻塞的 + .pending-apply
      for (const rel of result.applied) {
        await fs.unlink(join(stagingDir, rel)).catch(() => undefined);
      }
      result.warnings.push(
        `${result.blocked.length} 个文件 swap 失败(可能被锁),保留 staging 等下次重试`,
      );
      coreLog.warn(`[swap] 部分成功 applied=${result.applied.length} blocked=${result.blocked.length}`);
    }

    // 9. executablePath 配置了但不在 pendingFiles 里(ignoreItems 命中 / 文件没变化)
    //    → 标记 skipped,scheduler 不会 launch
    if (opts.executablePath && !result.executableUpdate) {
      result.executableUpdate = 'skipped';
    }
  } catch (err) {
    result.fatalError = `swap 失败: ${(err as Error).message}`;
    result.warnings.push(result.fatalError);
  } finally {
    // 释放 mutex
    await fs.unlink(lockPath).catch(() => undefined);
  }

  return result;
}

async function pruneEmptyDirs(root: string): Promise<void> {
  // 删 staging 里空目录(自底向上)
  const toDelete: string[] = [];
  async function walk(dir: string): Promise<boolean> {
    let hasContent = false;
    let entries: import('node:fs').Dirent[] = [];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      // 不删标记文件 / mutex / swap-staging 目录
      if (dir === root && (e.name === PENDING_APPLY_FILE || e.name === SWAPPING_LOCK_FILE)) {
        hasContent = true;
        continue;
      }
      if (e.name === SWAP_STAGING_DIR) {
        hasContent = true;
        continue;
      }
      if (e.isDirectory()) {
        const childHasContent = await walk(full);
        if (!childHasContent) toDelete.push(full);
        else hasContent = true;
      } else {
        hasContent = true;
      }
    }
    return hasContent;
  }
  await walk(root);
  for (const dir of toDelete.reverse()) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * 清空 staging 目录(用户点"取消待应用更新")
 *
 * 不删 backup,backup 是独立目录。
 */
export async function clearStaging(opts: { stagingDir: string }): Promise<{ ok: boolean; cleared: number; error?: string }> {
  const { stagingDir } = opts;
  // 检查 mutex:如果有 swap 在跑,不允许清空
  try {
    await fs.stat(join(stagingDir, SWAPPING_LOCK_FILE));
    return { ok: false, cleared: 0, error: 'swap 进行中,无法清空' };
  } catch {
    // lock 不存在 = 没人用
  }

  // 列出所有文件,删除
  let cleared = 0;
  async function walk(dir: string): Promise<void> {
    let entries: import('node:fs').Dirent[] = [];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        await walk(full);
        await fs.rmdir(full).catch(() => undefined);
      } else if (e.name !== SWAPPING_LOCK_FILE) {
        await fs.unlink(full).catch(() => undefined);
        cleared++;
      }
    }
  }
  await walk(stagingDir);
  await fs.unlink(join(stagingDir, PENDING_APPLY_FILE)).catch(() => undefined);
  return { ok: true, cleared };
}
