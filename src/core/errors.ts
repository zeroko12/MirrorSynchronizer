/**
 * 错误分类 - 把 NodeJS errno 映射到语义化类别
 *
 * 设计目标:
 * - 让上游(Syncer/Scheduler/UI)能区分"网络断"、"权限错"、"路径不存在"
 * - 保持分类稳定,新增 errno 不破坏现有消费者
 *
 * 关键发现(Windows SMB):
 * - SMB 共享断网时,fs.stat 通常抛 ENOENT(不是 EHOSTUNREACH)
 * - 但路径形态是网络路径(\\\\server\\share 或挂载到盘符)
 * - 因此:本地路径 + ENOENT = not-found;网络路径 + ENOENT = network-not-found
 */

import { sep } from 'node:path';

/** 路径相关错误的语义化分类 */
export type PathErrorKind =
  | 'not-found'          // ENOENT 且非网络路径 — 路径真的不存在
  | 'network-down'       // EHOSTUNREACH / ENETUNREACH / ENOTCONN / EIO — 网络层不可达
  | 'network-not-found'  // 网络路径 + ENOENT — SMB 共享断开或未挂载
  | 'timeout'            // ETIMEDOUT
  | 'busy'               // EBUSY — 单文件/共享被锁(不是网络断)
  | 'permission-denied'  // EACCES / EPERM
  | 'disk-full'          // ENOSPC / EFBIG
  | 'target-locked'      // applyMode='immediate-with-precheck' 探测到目标文件被锁,整次同步拒绝
  | 'unknown';           // 兜底

/** 致命错误的归属:哪个路径出的问题 */
export type PathRole = 'source' | 'target' | 'mapping' | 'backup' | 'config';

/**
 * 判断路径是否是网络路径
 *
 * 覆盖场景:
 * - UNC 路径: \\server\share 或 //server/share
 * - 盘符挂载(Windows): Z:\, Z:/ — 用户可能把 SMB 挂到 Z 盘
 * - 显式挂载点(Unix): /mnt/smb, /Volumes/share
 *   注意:Linux 的 mount 通常没有协议标识,只能靠路径名启发式判断
 */
export function isNetworkPath(path: string): boolean {
  if (!path) return false;
  // UNC: \\server\share 或 //server/share
  if (/^[\\/]{2}[^\\/]/.test(path)) return true;
  // Linux SMB 挂载点常见路径(/mnt/* /media/* /Volumes/* /srv/*)
  if (/^\/(?:mnt|media|Volumes|srv)\//i.test(path)) return true;
  // 路径名含 'smb' 或 'cifs' 或 'nfs' 关键词(启发式)
  // 关键词前必有路径分隔符;后接路径分隔符、连字符、或结尾
  if (/[\\/](?:smb|cifs|nfs|nas)(?:[\\/._-]|$)/i.test(path)) return true;
  // 盘符 (Windows): 不算网络路径本身,但 SMB 挂载到 Z: 是常见场景
  // 这里不把单字母盘符视为网络路径 — 需要靠 ENOENT 在网络路径形态下才升级
  return false;
}

/**
 * 把 NodeJS errno 映射到 PathErrorKind
 * @param code NodeJS.ErrnoException.code
 * @param path 出错的路径(用于区分 ENOENT 的语义)
 */
export function classifyErrno(code: string | undefined, path: string): PathErrorKind {
  switch (code) {
    case 'ENOENT':
      return isNetworkPath(path) ? 'network-not-found' : 'not-found';
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
    case 'ENETDOWN':
    case 'ENOTCONN':
    case 'EIO':
    case 'EPIPE':
    case 'ECONNRESET':
      return 'network-down';
    case 'ETIMEDOUT':
      return 'timeout';
    case 'EBUSY':
    case 'EAGAIN':
    case 'EWOULDBLOCK':
      return 'busy';
    case 'EACCES':
    case 'EPERM':
      return 'permission-denied';
    case 'ENOSPC':
    case 'EFBIG':
    case 'EDQUOT':
      return 'disk-full';
    default:
      return 'unknown';
  }
}

/** 是否属于"网络类"错误(驱动退避策略) */
export function isNetworkReason(reason: PathErrorKind | null | undefined): boolean {
  return reason === 'network-down' || reason === 'network-not-found' || reason === 'timeout';
}

/**
 * HTTP 状态码 → PathErrorKind
 * 用于 HttpAdapter / WebDAV Adapter 把 HTTP 错误归到统一的错误分类
 *
 * WebDAV 额外码 (RFC 4918):
 * - 207 Multi-Status:成功但响应在 body(对顶层 GET 来说表示"非简单 GET,看 body")
 * - 422 Unprocessable Entity:PROPPIND 等失败
 * - 423 Locked:资源被锁
 * - 424 Failed Dependency:依赖项失败
 * - 507 Insufficient Storage:WebDAV 服务器空间不足
 */
export function classifyHttpStatus(status: number): PathErrorKind {
  if (status === 401 || status === 403) return 'permission-denied';
  if (status === 404 || status === 410 || status === 422) return 'not-found';
  if (status === 408 || status === 504 || status === 524) return 'timeout';
  if (status === 429 || status === 423) return 'busy';
  if (status === 507) return 'disk-full';
  if (status === 424) return 'unknown'; // 依赖项失败,具体看 body
  if (status === 207) return 'unknown'; // Multi-Status,调用方需解析 body
  if (status >= 500) return 'unknown'; // 服务器错误
  if (status >= 400) return 'unknown'; // 其它客户端错误
  return 'unknown';
}

/** HTTP fetch 抛错时,把 error 归类到 PathErrorKind */
export function classifyFetchError(err: unknown): PathErrorKind {
  const code = (err as { code?: string })?.code;
  if (typeof code === 'string') {
    const reason = classifyErrno(code, '');
    if (reason !== 'unknown') return reason;
  }
  const name = (err as { name?: string })?.name;
  if (name === 'AbortError' || name === 'TimeoutError') return 'timeout';
  if (name === 'TypeError') return 'network-down'; // fetch 网络层错误通常抛 TypeError
  return 'unknown';
}

/**
 * 格式化致命错误的中文消息
 * @param reason 错误类别
 * @param role 错误归属(源/目标/...)
 * @param path 出错路径
 */
export function formatFatalMessage(
  reason: PathErrorKind | null | undefined,
  role: PathRole,
  path: string,
): string {
  const roleLabel: Record<PathRole, string> = {
    source: '源目录',
    target: '目标目录',
    mapping: '映射文件',
    backup: '备份目录',
    config: '配置',
  };
  const label = roleLabel[role];

  switch (reason) {
    case 'network-not-found':
      return `${label}网络不可达(${path}),可能 SMB 共享未挂载或断网`;
    case 'network-down':
      return `${label}网络中断(${path}): ${reason}`;
    case 'timeout':
      return `${label}访问超时(${path})`;
    case 'permission-denied':
      return `${label}权限不足(${path})`;
    case 'not-found':
      return `${label}不存在(${path})`;
    case 'busy':
      return `${label}被占用(${path})`;
    case 'disk-full':
      return `磁盘空间不足,无法写入 ${label}(${path})`;
    case 'unknown':
    case null:
    case undefined:
    default:
      return `${label}不可访问(${path})`;
  }
}

/** 路径分隔符(跨平台)— 暴露 sep 供其他模块使用 */
export { sep };
