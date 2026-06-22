/**
 * ConfigManager - 应用配置持久化
 *
 * 设计要点:
 * - 配置存在 userData/config.json(CLI 模式可指定路径)
 * - 加载时与默认值深合并,保证新增字段向后兼容
 * - 写入是原子的(写 .tmp 后 rename),防止崩溃导致半截 JSON
 * - 不可变:save() 接收新对象,内部不修改入参
 */

import { promises as fs } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import type { AppConfig, ConfigManagerOptions } from './types.js';
import { atomicWriteJson } from './fs-utils.js';
import { MAX_BACKUP_COUNT, MAX_INTERVAL_SEC, MIN_BACKUP_COUNT, MIN_INTERVAL_SEC } from './constants.js';

const DEFAULT_CONFIG: AppConfig = {
  sourceDir: '',
  targetDir: '',
  backupDir: '',
  intervalSec: 300, // 5 分钟
  backupCount: 3,
  autostart: false,
  applyMappingsImmediately: true,
  fileMappings: [],
  ignoreItems: [],
  remote: {
    enabled: true,           // 默认开启
    port: 9527,              // 默认端口
    passwordHash: '',        // 首次启动时生成
    autoDiscover: true,      // 默认开 mDNS
  },
};

export class ConfigManager {
  private readonly configPath: string;
  private readonly defaults: AppConfig;

  constructor(options: ConfigManagerOptions) {
    this.configPath = String(options.configPath);
    this.defaults = options.defaults;
  }

  /**
   * 从磁盘加载,不存在则返回默认值(不自动创建文件)
   */
  async load(): Promise<AppConfig> {
    let raw: string;
    try {
      raw = await fs.readFile(this.configPath, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return { ...this.defaults };
      }
      throw new Error(`读取配置文件失败: ${(err as Error).message}`);
    }

    let parsed: Partial<AppConfig>;
    try {
      parsed = JSON.parse(raw) as Partial<AppConfig>;
    } catch (err) {
      throw new Error(`配置文件 JSON 解析失败: ${(err as Error).message}`);
    }

    return this.mergeWithDefaults(parsed);
  }

  /**
   * 原子写入:先写 .tmp 再 rename
   */
  async save(config: AppConfig): Promise<void> {
    const validated = this.validate(config);
    await atomicWriteJson(this.configPath, validated);
  }

  /**
   * 强制覆盖为默认值(主要用于 --init)
   */
  async resetToDefaults(): Promise<AppConfig> {
    const cfg = { ...this.defaults };
    await this.save(cfg);
    return cfg;
  }

  /**
   * 配置文件路径
   */
  get path(): string {
    return this.configPath;
  }

  private mergeWithDefaults(partial: Partial<AppConfig>): AppConfig {
    return {
      ...this.defaults,
      ...partial,
      fileMappings: Array.isArray(partial.fileMappings)
        ? partial.fileMappings.map((m) => ({ ...m }))
        : [...this.defaults.fileMappings],
      ignoreItems: Array.isArray(partial.ignoreItems)
        ? partial.ignoreItems.filter((d): d is string => typeof d === 'string')
        : [...this.defaults.ignoreItems],
      remote: partial.remote
        ? { ...this.defaults.remote!, ...partial.remote }
        : { ...this.defaults.remote! },
    };
  }

  private validate(config: AppConfig): AppConfig {
    const errors: string[] = [];
    if (config.intervalSec < MIN_INTERVAL_SEC) errors.push(`intervalSec < ${MIN_INTERVAL_SEC}`);
    if (config.intervalSec > MAX_INTERVAL_SEC) errors.push(`intervalSec > ${MAX_INTERVAL_SEC} (7 days)`);
    if (config.backupCount < MIN_BACKUP_COUNT) errors.push(`backupCount < ${MIN_BACKUP_COUNT}`);
    if (config.backupCount > MAX_BACKUP_COUNT) errors.push(`backupCount > ${MAX_BACKUP_COUNT}`);
    if (config.backupDir && config.backupDir === config.targetDir) {
      errors.push('backupDir 不能等于 targetDir(否则镜像同步会误删备份)');
    }
    // ignoreItems 校验 — 拒绝空、`.`、含 `..`、绝对路径、重复
    // (规范化在 syncer 里做,这里只校验合法性)
    if (Array.isArray(config.ignoreItems)) {
      const seen = new Set<string>();
      for (const raw of config.ignoreItems) {
        if (typeof raw !== 'string' || !raw.trim()) {
          errors.push(`ignoreItems 含有空字符串`);
          continue;
        }
        const normalized = raw.trim().replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
        if (!normalized || normalized === '.') {
          errors.push(`ignoreItems 不允许 "." 或空路径: "${raw}"`);
          continue;
        }
        if (normalized.includes('..')) {
          errors.push(`ignoreItems 不允许包含 "..": "${raw}"`);
          continue;
        }
        if (normalized.includes(':')) {
          errors.push(`ignoreItems 不允许绝对路径(包含 ":"): "${raw}"`);
          continue;
        }
        if (seen.has(normalized)) {
          errors.push(`ignoreItems 重复条目: "${raw}"`);
          continue;
        }
        seen.add(normalized);
      }
    } else {
      errors.push('ignoreItems 必须是数组');
    }
    if (errors.length) {
      throw new Error(`配置校验失败: ${errors.join(', ')}`);
    }
    return config;
  }
}

/**
 * 默认配置(导出供其他模块使用)
 */
export { DEFAULT_CONFIG };

/**
 * 根据平台返回 userData 目录的 config.json 路径
 */
export function defaultConfigPath(userDataDir: string): string {
  return resolvePath(userDataDir, 'config.json');
}
