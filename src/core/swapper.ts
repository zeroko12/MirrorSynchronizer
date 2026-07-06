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

/**
 * 锁文件 stale 判定阈值。
 *
 * 真 swap 跑 10000 个文件也就几分钟,30 秒不更新 mtime = 真卡死或进程崩。
 * 关键场景:之前 swap 进程被 kill -9(强关、电源断)→ .swapping 文件留在盘上,
 * 上次进程的 PID 在 Windows 上经常被其他进程复用(PID 数字只到几万,系统满了循环用),
 * isPidAlive 返 true(EPERM) → 锁永远不释放。
 *
 * 之前的 10 分钟阈值让这个 bug 在 PID 复用场景下必出现。
 * 改 30 秒:真 swap loop 每 100 个文件 touch 一次 mtime(见 swapHeartbeat),
 *          真在跑 swap → mtime 永远新鲜 → 锁不被误清;
 *          进程崩溃 + PID 复用 → mtime 30 秒没更新 → 锁被认为 stale → 自愈。
 */
const STALE_LOCK_TIMEOUT_MS = 30_000;

/** swap loop 每 N 个文件 touch 一次锁文件,让 mtime 保持新鲜 */
const SWAP_HEARTBEAT_INTERVAL = 100;

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
  /** 备份时跳过的文件/目录(相对 targetDir,prefix 匹配) */
  ignoreItems?: string[];
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
 *
 * 历史上用 `__probe_<pid>_<ts>` 写两个临时文件再 `fs.link` 判断。
 * 这里加 try/finally + 唯一文件名前缀:`pid+ts+random`,防多进程并发留下冲突文件。
 * 失败时仍返回 false(用 copy+unlink 兜底),但 probe 文件清理在 finally 里。
 */
async function isSameVolume(a: string, b: string): Promise<boolean> {
  const rand = `${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const tmpA = join(a, `.__probe_${rand}`);
  const tmpB = join(b, `.__probe_${rand}`);
  let aWritten = false;
  try {
    try {
      await fs.writeFile(tmpA, '');
      aWritten = true;
      try {
        await fs.link(tmpA, tmpB);
        return true; // 同盘
      } catch {
        return false; // 跨盘
      }
    } catch {
      // tmpA 创建失败(SMB 不稳 / 权限 / 路径不存在)— 视作跨盘,让 sync 走 copy+unlink 路径
      return false;
    }
  } finally {
    // 清理 probe,必须在所有返回路径都跑(防 SMB 偶发失败留下垃圾)
    if (aWritten) {
      await fs.unlink(tmpA).catch(() => undefined);
    }
    await fs.unlink(tmpB).catch(() => undefined);
  }
}

/**
 * 检查 target 是否可写(swap 前必跑)。
 *
 * 之前没有这一步 — 用户在只读 SMB 共享上配了 stagingDir → 第一次 swap 才暴露
 * "失败 N 个文件"→ 用户不知道是权限不够还是配置错。
 * 现在 swap 前预检:写空文件 + 立刻删 + 看 mkdir(根目录)是否能成功;
 * 失败立刻 fatalError 报告,避免跑几千行 rename 才暴雷。
 *
 * exported for unit tests。
 */
export async function preflightTargetWritable(targetDir: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  // 1. 根目录能不能 mkdir(根已存在的话 recursive:true 不会失败,只看 errno)
  try {
    await fs.mkdir(targetDir, { recursive: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return {
      ok: false,
      reason: `目标目录不可访问 (${code ?? (err as Error).message}): ${targetDir}`,
    };
  }

  // 2. 写并立即删一个 probe 文件
  const probe = join(targetDir, `.__wprobe_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
  try {
    await fs.writeFile(probe, '');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return {
      ok: false,
      reason: `目标目录不可写 (${code ?? (err as Error).message}): ${targetDir}`,
    };
  }
  await fs.unlink(probe).catch(() => undefined);
  return { ok: true };
}

/**
 * 瞬时错误码 — 这些 swap 在网络共享/AV 锁定时常返,加短期重试通常能恢复
 */
const TRANSIENT_ERRNO_CODES = new Set([
  'EBUSY',       // AV / 系统锁住
  'EAGAIN',      // 资源暂时不可用
  'EWOULDBLOCK', // EAGAIN 别名
  'ENETUNREACH', // 网络不可达
  'EHOSTUNREACH',
  'ETIMEDOUT',
  'ENETRESET',   // 网络连接被重置
  'EPIPE',       // 管道破裂
]);

/**
 * 权限类错误 — 重试也没用,只会浪费 IO
 */
const PERM_ERRNO_CODES = new Set([
  'EACCES', 'EPERM', 'EROFS',
]);

/**
 * 不可恢复错误 — 重试没用,直接 blocked
 */
const CONFLICT_ERRNO_CODES = new Set([
  'EEXIST', 'ENOTEMPTY', 'EISDIR', 'ENOTDIR', 'ELOOP',
]);

/**
 * 检测 PID 是否仍在运行
 * - process.kill(pid, 0) 抛 ESRCH = 进程不存在
 * - 抛 EPERM = 进程存在但无权限(我们同用户不会遇到)
 * - 不抛 = 进程存在
 */
function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === 'EPERM'; // 存在但无权限(罕见,视为 alive)
  }
}

/** 锁的获取结果 */
type LockAcquireResult =
  | { ok: true; recovered?: number } // recovered = 清掉了一个 stale lock,值是原 PID(给 log/warning)
  | { ok: false; heldBy?: number };  // 真的有人在用

/**
 * 锁状态检查(给 clearStaging 之类的"只读"操作复用)
 * - 'none'  : 锁文件不存在
 * - 'stale' : 锁文件存在但 stale(PID 已死 / mtime 超时 / 内容非数字)
 * - 'alive' : 锁文件存在且真的有人在跑
 */
async function isLockStale(stagingDir: string): Promise<'none' | 'stale' | 'alive'> {
  const STALE_MTIME_MS = STALE_LOCK_TIMEOUT_MS;
  let stat: import('node:fs').Stats;
  try {
    stat = await fs.stat(join(stagingDir, SWAPPING_LOCK_FILE));
  } catch {
    return 'none';
  }
  const ageMs = Date.now() - stat.mtimeMs;
  const content = await fs.readFile(join(stagingDir, SWAPPING_LOCK_FILE), 'utf-8').catch(() => '');
  const heldBy = parseInt(content.trim(), 10);
  const pidDead = !isPidAlive(heldBy);
  const tooOld = ageMs > STALE_MTIME_MS;
  if (pidDead || tooOld) return 'stale';
  return 'alive';
}

/**
 * 获取 swap 互斥锁(自愈版)
 * - 正常情况:wx 创建,返回 ok
 * - 锁文件已存在:读 PID,检查是否还活着
 *   - 死了(PID 不存在 / 锁文件 mtime 太久)→ 删掉,重试创建
 *   - 活着 → 返 ok=false,heldBy=那个 PID
 *
 * 为什么需要自愈:之前进程如果在 create 后、finally 前崩溃(电源断 / OOM / 强杀),
 * .swapping 文件留在盘上,下次启动会一直报"其他实例持有锁",重启电脑也没用(文件还在)。
 */
async function acquireSwapLock(lockPath: string): Promise<LockAcquireResult> {
  // 共享 STALE_LOCK_TIMEOUT_MS(顶部定义)— 30 秒
  const STALE_MTIME_MS = STALE_LOCK_TIMEOUT_MS;
  let recoveredFrom: number | undefined; // 清掉的 stale lock 原 PID(给 log/warning)

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      // wx = 排他创建,文件已存在会抛 EEXIST
      await fs.writeFile(lockPath, String(process.pid), { flag: 'wx' });
      return recoveredFrom !== undefined
        ? { ok: true, recovered: recoveredFrom }
        : { ok: true };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }

    // 文件已存在 — 判断是不是 stale
    let stat: import('node:fs').Stats;
    try {
      stat = await fs.stat(lockPath);
    } catch {
      // 文件在 stat 之间被删了(并发)→ 下一轮 retry 创建
      continue;
    }
    const ageMs = Date.now() - stat.mtimeMs;
    const content = await fs.readFile(lockPath, 'utf-8').catch(() => '');
    const heldBy = parseInt(content.trim(), 10);

    const pidDead = !isPidAlive(heldBy);
    const tooOld = ageMs > STALE_MTIME_MS;
    if (pidDead || tooOld) {
      // Stale lock — 删掉,retry 创建
      const reason = pidDead ? `PID ${heldBy} 已退出` : `锁文件 ${Math.round(ageMs / 1000)}s 未刷新(超过 ${STALE_MTIME_MS / 1000}s)`;
      coreLog.warn(`[swap] 检测到 stale lock: ${reason} — 清理并重试`);
      await fs.unlink(lockPath).catch(() => undefined);
      recoveredFrom = heldBy;
      continue; // retry create(下次循环会返 ok + recoveredFrom)
    }

    // 真的有人在跑
    return { ok: false, heldBy };
  }

  // 极端情况:重试两次还失败,让上层报错
  return { ok: false };
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

  // 2. 拿 mutex(自愈:若锁文件是上次崩溃留下的 stale lock,先清理)
  const lockPath = join(stagingDir, SWAPPING_LOCK_FILE);
  const lock = await acquireSwapLock(lockPath);
  if (!lock.ok) {
    // 真有另一个实例在跑
    result.fatalError = `swap 正在进行中(其他实例持有锁,PID=${lock.heldBy ?? '?'}),跳过本次`;
    result.warnings.push(result.fatalError);
    return result;
  }
  if (lock.recovered) {
    // 之前进程崩溃,留了 .swapping + 可能 .swap-staging/{ts}/
    coreLog.warn(`[swap] 清理了崩溃进程的 stale lock (PID=${lock.recovered})`);
    result.warnings.push(`检测到上次 swap 异常中断(PID=${lock.recovered} 已退出),已自动恢复`);
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
          const snap = await backupper.createSnapshot(targetDir, backupDir || undefined, {
            ignoreItems: opts.ignoreItems,
          });
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

    // 4.5 ★ 新增 pre-flight:swap 前先确认 target 可写
    // 之前用户在只读 SMB / 配置错 → 跑完整个 rename loop 才看到一堆 EBUSY,
    // 用户根本看不出来是"权限不够"还是"网络临时挂"。现在先短消息 fail-fast。
    const writableCheck = await preflightTargetWritable(targetDir);
    if (!writableCheck.ok) {
      result.fatalError = writableCheck.reason;
      result.warnings.push(result.fatalError);
      result.warnings.push('提示:检查目标路径是否在可读写的卷上,网络共享是否断开或权限不足');
      return result;
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
    //
    // 改进:
    //   - 瞬时错误 (EBUSY/EAGAIN/ENETUNREACH 等网络共享常见错误) → 重试 3 次
    //     backoff 250ms(网络共享短抖动通常恢复)
    //   - 永久错误 → 立即 blocked
    //   - 错误分类更准:perm/conflict/transient/other(给用户更清楚诊断)
    //
    // 之前:所有 errno(EBUSY/EPERM/EACCES/ENOTEMPTY/EEXIST)一起进 blocked,
    //       剩余全归 "其他错误" → 用户看不出"权限问题"和"临时网络抖动"的区别。
    const SWAP_MAX_RETRIES = 3;
    let swappedCount = 0;
    for (const rel of pendingFiles) {
      const srcPath = join(stagingDir, rel);
      const tgtPath = join(targetDir, rel);
      const parentDir = dirname(tgtPath);

      // 7a. parent dir 创建(也加 retry — SMB 上偶发失败)
      let mkdirAttempts = 0;
      let mkdirOk = false;
      let lastMkdirErr: NodeJS.ErrnoException | null = null;
      while (mkdirAttempts <= SWAP_MAX_RETRIES && !mkdirOk) {
        try {
          await fs.mkdir(parentDir, { recursive: true });
          mkdirOk = true;
        } catch (err) {
          lastMkdirErr = err as NodeJS.ErrnoException;
          if (lastMkdirErr.code && TRANSIENT_ERRNO_CODES.has(lastMkdirErr.code) && mkdirAttempts < SWAP_MAX_RETRIES) {
            await new Promise((r) => setTimeout(r, 250 * (mkdirAttempts + 1)));
            mkdirAttempts++;
            continue;
          }
          break;
        }
      }
      if (!mkdirOk) {
        const code = lastMkdirErr?.code ?? 'unknown';
        result.blocked.push(rel);
        result.warnings.push(
          PERM_ERRNO_CODES.has(code ?? '')
            ? `swap 跳过(目标目录权限不足 ${code}): ${rel}`
            : `swap 跳过(创建目标父目录失败 ${code}): ${rel}`,
        );
        if (opts.executablePath && rel === opts.executablePath) {
          result.executableUpdate = 'blocked';
        }
        continue;
      }

      // 7b. swap 主体(rename 或 copy+unlink),瞬时错误重试
      let attempts = 0;
      let done = false;
      let lastErr: NodeJS.ErrnoException | null = null;
      while (attempts <= SWAP_MAX_RETRIES && !done) {
        try {
          if (sameVol) {
            await fs.rename(srcPath, tgtPath);
          } else {
            await fs.copyFile(srcPath, tgtPath);
            await fs.unlink(srcPath);
          }
          done = true;
        } catch (err) {
          lastErr = err as NodeJS.ErrnoException;
          const code = lastErr.code;
          if (code && TRANSIENT_ERRNO_CODES.has(code) && attempts < SWAP_MAX_RETRIES) {
            attempts++;
            // backoff:250ms × 尝试次数(1→250, 2→500, 3→750)
            await new Promise((r) => setTimeout(r, 250 * attempts));
            continue;
          }
          break; // 非瞬时或重试用尽 → 跳出
        }
      }

      if (done) {
        result.applied.push(rel);
        swappedCount++;
        // ★ Heartbeat:每 N 个文件 touch 一次锁文件,让 mtime 保持新鲜
        if (swappedCount % SWAP_HEARTBEAT_INTERVAL === 0) {
          try {
            await fs.utimes(lockPath, new Date(), new Date());
          } catch {
            // lockPath 已被其他进程删了(理论上不该,但兜底)→ 继续
          }
        }
        // ★ 跟踪目标可执行文件 swap 结果
        if (opts.executablePath && rel === opts.executablePath) {
          result.executableUpdate = 'success';
        }
        coreLog.info(`[swap] applied: ${rel}`);
      } else {
        // swap 未成功,记录错误分类 + 重试信息
        const code = (lastErr?.code ?? 'unknown') as string;
        const errMsg = lastErr?.message ?? String(lastErr ?? '');
        const retried = attempts > 0 ? `, 重试 ${attempts} 次仍失败` : '';
        let label: string;
        if (PERM_ERRNO_CODES.has(code)) {
          label = `swap 跳过(权限不足 ${code}${retried})`;
        } else if (CONFLICT_ERRNO_CODES.has(code)) {
          label = `swap 跳过(冲突 ${code}${retried})`;
        } else if (code === 'ENOSPC') {
          label = `swap 跳过(磁盘空间不足)`;
        } else if (code === 'EIO') {
          label = `swap 跳过(I/O 错误 ${code}${retried})`;
        } else {
          label = `swap 跳过(${code}${retried})`;
        }
        result.blocked.push(rel);
        result.warnings.push(`${label}: ${rel}`);
        if (opts.executablePath && rel === opts.executablePath) {
          result.executableUpdate = 'blocked';
        }
        coreLog.warn(`[swap] blocked: ${rel} (${code}${retried}) ${errMsg}`);
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
  // 检查 mutex(自愈版:stale lock 自动清理,只有真活着才拒绝)
  const lockCheck = await isLockStale(stagingDir);
  if (lockCheck === 'alive') {
    return { ok: false, cleared: 0, error: 'swap 进行中,无法清空' };
  }
  if (lockCheck === 'stale') {
    // 死锁残留,直接清掉
    await fs.unlink(join(stagingDir, SWAPPING_LOCK_FILE)).catch(() => undefined);
    coreLog.warn('[clearStaging] 清理了 stale .swapping lock');
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
