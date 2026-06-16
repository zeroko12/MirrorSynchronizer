/**
 * ConfigManager 测试
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { ConfigManager, DEFAULT_CONFIG } from '../src/core/config.js';
import { deriveDefaultBackupDir } from '../src/core/types.js';
import { makeTempDir, rmTemp } from './helpers.js';

describe('ConfigManager', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await makeTempDir('cfg-');
  });

  afterEach(async () => {
    await rmTemp(dir);
  });

  it('配置文件不存在:返回默认值', async () => {
    const mgr = new ConfigManager({ configPath: join(dir, 'cfg.json'), defaults: DEFAULT_CONFIG });
    const cfg = await mgr.load();
    expect(cfg).toEqual(DEFAULT_CONFIG);
  });

  it('写入并读回:内容一致', async () => {
    const mgr = new ConfigManager({ configPath: join(dir, 'cfg.json'), defaults: DEFAULT_CONFIG });
    const custom = {
      ...DEFAULT_CONFIG,
      sourceDir: 'Z:/updates',
      targetDir: 'D:/app',
      intervalSec: 120,
      backupCount: 5,
    };
    await mgr.save(custom);
    const cfg = await mgr.load();
    expect(cfg.sourceDir).toBe('Z:/updates');
    expect(cfg.targetDir).toBe('D:/app');
    expect(cfg.intervalSec).toBe(120);
    expect(cfg.backupCount).toBe(5);
  });

  it('原子写:不会留下 .tmp 文件', async () => {
    const path = join(dir, 'cfg.json');
    const mgr = new ConfigManager({ configPath: path, defaults: DEFAULT_CONFIG });
    await mgr.save({ ...DEFAULT_CONFIG, sourceDir: 'x' });
    const entries = await fs.readdir(dir);
    expect(entries).toContain('cfg.json');
    expect(entries.find((e) => e.includes('.tmp'))).toBeUndefined();
  });

  it('校验失败:intervalSec < 60 抛错', async () => {
    const mgr = new ConfigManager({ configPath: join(dir, 'cfg.json'), defaults: DEFAULT_CONFIG });
    await expect(
      mgr.save({ ...DEFAULT_CONFIG, intervalSec: 30 }),
    ).rejects.toThrow(/intervalSec/);
  });

  it('校验失败:backupCount > 20 抛错', async () => {
    const mgr = new ConfigManager({ configPath: join(dir, 'cfg.json'), defaults: DEFAULT_CONFIG });
    await expect(
      mgr.save({ ...DEFAULT_CONFIG, backupCount: 50 }),
    ).rejects.toThrow(/backupCount/);
  });

  it('深合并:fileMappings 数组可独立更新', async () => {
    const path = join(dir, 'cfg.json');
    const mgr = new ConfigManager({ configPath: path, defaults: DEFAULT_CONFIG });
    await mgr.save({
      ...DEFAULT_CONFIG,
      fileMappings: [
        { id: '1', name: 'a', sourcePath: '/x', targetRelpath: 'a.ini', enabled: true, overwrite: false, ifSourceMissing: 'skip' },
      ],
    });
    const loaded = await mgr.load();
    expect(loaded.fileMappings.length).toBe(1);
    expect(loaded.fileMappings[0].name).toBe('a');
  });

  it('backupDir 字段可持久化', async () => {
    const path = join(dir, 'cfg.json');
    const mgr = new ConfigManager({ configPath: path, defaults: DEFAULT_CONFIG });
    await mgr.save({ ...DEFAULT_CONFIG, backupDir: 'D:/backups/app' });
    const loaded = await mgr.load();
    expect(loaded.backupDir).toBe('D:/backups/app');
  });

  it('backupDir 默认值是空字符串(由 P3 备份器派生)', async () => {
    expect(DEFAULT_CONFIG.backupDir).toBe('');
  });

  it('校验失败:backupDir == targetDir 抛错(避免镜像误删备份)', async () => {
    const path = join(dir, 'cfg.json');
    const mgr = new ConfigManager({ configPath: path, defaults: DEFAULT_CONFIG });
    await expect(
      mgr.save({ ...DEFAULT_CONFIG, targetDir: 'D:/app', backupDir: 'D:/app' }),
    ).rejects.toThrow(/backupDir 不能等于 targetDir/);
  });

  it('校验通过:backupDir 与 targetDir 不同(放兄弟位置)', async () => {
    const path = join(dir, 'cfg.json');
    const mgr = new ConfigManager({ configPath: path, defaults: DEFAULT_CONFIG });
    await expect(
      mgr.save({ ...DEFAULT_CONFIG, targetDir: 'D:/app', backupDir: 'D:/app-backups' }),
    ).resolves.toBeUndefined();
  });
});

describe('deriveDefaultBackupDir', () => {
  it('Windows 风格路径:在父目录生成兄弟位置', () => {
    expect(deriveDefaultBackupDir('D:/game/data')).toBe('D:/game/data-backups');
    expect(deriveDefaultBackupDir('Z:/updates/app')).toBe('Z:/updates/app-backups');
  });

  it('POSIX 风格路径', () => {
    expect(deriveDefaultBackupDir('/var/lib/myapp/data')).toBe('/var/lib/myapp/data-backups');
  });

  it('尾部斜杠被剥除', () => {
    expect(deriveDefaultBackupDir('D:/app/')).toBe('D:/app-backups');
    expect(deriveDefaultBackupDir('D:/app\\')).toBe('D:/app-backups');
  });

  it('不带尾部斜杠保持原样', () => {
    expect(deriveDefaultBackupDir('D:/app')).toBe('D:/app-backups');
  });
});
