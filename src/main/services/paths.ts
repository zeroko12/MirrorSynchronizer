/**
 * paths - 主进程 userData 下文件路径
 *
 * 集中所有 app.getPath('userData') 的派生,避免散落
 */

import { app } from 'electron';
import { join } from 'node:path';
import { defaultStatePath } from '@core/state';
import { defaultHistoryDbPath } from '@core/history';

/** 配置文件 */
export function getConfigPath(): string {
  return join(app.getPath('userData'), 'config.json');
}

/** 索引缓存(用于增量检测) */
export function getIndexCachePath(): string {
  return join(app.getPath('userData'), 'index-cache.json');
}

/** SQLite 历史库 */
export function getHistoryDbPath(): string {
  return defaultHistoryDbPath(app.getPath('userData'));
}

/** 运行时状态文件(popup 开关 / 暂休 / 回退锁) */
export function getStatePath(): string {
  return defaultStatePath(app.getPath('userData'));
}
