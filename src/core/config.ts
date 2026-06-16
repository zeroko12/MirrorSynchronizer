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
import { dirname, resolve as resolvePath } from 'node:path';
import type { AppConfig, ConfigManagerOptions } from './types.js';

const DEFAULT_CONFIG: AppConfig = {
  sourceDir: '',
  targetDir: '',
  backupDir: '',
  intervalSec: 300, // 5 分钟
  backupCount: 3,
  autostart: false,
  applyMappingsImmediately: true,
  fileMappings: [],
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
    const dir = dirname(this.configPath);
    await fs.mkdir(dir, { recursive: true });

    const tmp = `${this.configPath}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(validated, null, 2), 'utf-8');
    await fs.rename(tmp, this.configPath);
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
    };
  }

  private validate(config: AppConfig): AppConfig {
    const errors: string[] = [];
    if (config.intervalSec < 60) errors.push('intervalSec < 60');
    if (config.intervalSec > 604800) errors.push('intervalSec > 604800 (7 days)');
    if (config.backupCount < 1) errors.push('backupCount < 1');
    if (config.backupCount > 20) errors.push('backupCount > 20');
    if (config.backupDir && config.backupDir === config.targetDir) {
      errors.push('backupDir 不能等于 targetDir(否则镜像同步会误删备份)');
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
