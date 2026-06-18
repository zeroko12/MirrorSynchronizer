/**
 * Syncer 核心测试
 *
 * 覆盖 P1 验收点:
 *  - 源 → 目标 新增文件
 *  - 源修改文件 → 目标覆盖
 *  - 源删除文件 → 目标镜像删除
 *  - 文件映射规则(源文件不存在:skip / keep / delete)
 *  - 镜像模式不会保留目标里的"孤儿"文件
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { Syncer } from '../src/core/syncer.js';
import { DEFAULT_CONFIG } from '../src/core/config.js';
import { makeTempDir, rmTemp, readTree, writeTree, writeFile, TreeFile } from './helpers.js';
import type { AppConfig } from '../src/core/types.js';

function makeConfig(sourceDir: string, targetDir: string, overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    ...DEFAULT_CONFIG,
    sourceDir,
    targetDir,
    ...overrides,
  };
}

describe('Syncer - 镜像同步', () => {
  let sourceDir: string;
  let targetDir: string;
  let config: AppConfig;

  beforeEach(async () => {
    sourceDir = await makeTempDir('src-');
    targetDir = await makeTempDir('tgt-');
    config = makeConfig(sourceDir, targetDir);
  });

  afterEach(async () => {
    await rmTemp(sourceDir);
    await rmTemp(targetDir);
  });

  it('首轮:把源目录所有文件拷到目标', async () => {
    await writeTree(sourceDir, [
      { relPath: 'a.txt', content: 'aaa' },
      { relPath: 'sub/b.txt', content: 'bbb' },
      { relPath: 'sub/deep/c.txt', content: 'ccc' },
    ]);

    const syncer = new Syncer(config);
    const { result } = await syncer.sync(null);

    expect(result.ok).toBe(true);
    expect(result.fatalError).toBeUndefined();
    expect(result.added.sort()).toEqual(['a.txt', 'sub/b.txt', 'sub/deep/c.txt']);
    expect(result.modified).toEqual([]);
    expect(result.deleted).toEqual([]);
    expect(result.unchanged).toBe(0);

    const targetTree = await readTree(targetDir);
    expect(targetTree.get('a.txt')).toBe('aaa');
    expect(targetTree.get('sub/b.txt')).toBe('bbb');
    expect(targetTree.get('sub/deep/c.txt')).toBe('ccc');
  });

  it('第二轮:源未变化,全部 unchanged', async () => {
    await writeTree(sourceDir, [
      { relPath: 'a.txt', content: 'aaa' },
      { relPath: 'b.txt', content: 'bbb' },
    ]);
    const syncer = new Syncer(config);
    await syncer.sync(null);
    const { result } = await syncer.sync(null);

    expect(result.unchanged).toBe(2);
    expect(result.added).toEqual([]);
    expect(result.modified).toEqual([]);
    expect(result.deleted).toEqual([]);
  });

  it('第二轮:源文件修改,目标被覆盖', async () => {
    await writeTree(sourceDir, [{ relPath: 'a.txt', content: 'v1' }]);
    const syncer = new Syncer(config);
    const { newSourceIndex: prevIndex } = await syncer.sync(null);

    // 修改源
    await writeFile(join(sourceDir, 'a.txt'), 'v2-modified');
    const { result } = await syncer.sync(prevIndex);

    expect(result.modified).toEqual(['a.txt']);
    const target = await fs.readFile(join(targetDir, 'a.txt'), 'utf-8');
    expect(target).toBe('v2-modified');
  });

  it('第二轮:源文件删除,目标镜像删除', async () => {
    await writeTree(sourceDir, [
      { relPath: 'keep.txt', content: 'k' },
      { relPath: 'remove.txt', content: 'r' },
    ]);
    const syncer = new Syncer(config);
    const { newSourceIndex: prevIndex } = await syncer.sync(null);

    // 源里删除 remove.txt
    await fs.unlink(join(sourceDir, 'remove.txt'));
    const { result } = await syncer.sync(prevIndex);

    expect(result.deleted).toEqual(['remove.txt']);
    const targetFiles = await readTree(targetDir);
    expect(targetFiles.has('remove.txt')).toBe(false);
    expect(targetFiles.has('keep.txt')).toBe(true);
  });

  it('镜像模式:目标里残留的"孤儿"文件被清理', async () => {
    // 先做一次完整同步
    await writeTree(sourceDir, [{ relPath: 'a.txt', content: 'a' }]);
    const syncer = new Syncer(config);
    await syncer.sync(null);

    // 手动在目标里塞一个源里没有的"孤儿"文件
    await writeFile(join(targetDir, 'orphan.txt'), 'orphan');
    // 确认它在目标里
    expect((await readTree(targetDir)).has('orphan.txt')).toBe(true);

    // 再次同步,应该被清掉
    const { result } = await syncer.sync(null);
    expect(result.deleted).toEqual(['orphan.txt']);
    expect((await readTree(targetDir)).has('orphan.txt')).toBe(false);
  });

  it('子目录递归同步', async () => {
    const deep: TreeFile[] = [];
    for (let i = 0; i < 50; i++) {
      deep.push({ relPath: `dir${i}/file${i}.txt`, content: `content-${i}` });
    }
    await writeTree(sourceDir, deep);
    const syncer = new Syncer(config);
    const { result } = await syncer.sync(null);

    expect(result.added.length).toBe(50);
    expect(result.ok).toBe(true);
    const target = await readTree(targetDir);
    expect(target.size).toBe(50);
  });
});

describe('Syncer - 文件映射规则', () => {
  let sourceDir: string;
  let targetDir: string;
  let localDir: string;
  let config: AppConfig;

  beforeEach(async () => {
    sourceDir = await makeTempDir('src-');
    targetDir = await makeTempDir('tgt-');
    localDir = await makeTempDir('local-');
    config = {
      sourceDir,
      targetDir,
      intervalSec: 60,
      backupCount: 3,
      autostart: false,
      fileMappings: [],
      backupDir: '',
    };
  });

  afterEach(async () => {
    await rmTemp(sourceDir);
    await rmTemp(targetDir);
    await rmTemp(localDir);
  });

  it('映射规则:目标缺失 → 补回(overwrite=false 默认行为)', async () => {
    await writeFile(join(localDir, 'my-config.ini'), '[main]\nkey=value');
    config.fileMappings = [
      {
        id: '1',
        name: 'my-config',
        sourcePath: join(localDir, 'my-config.ini'),
        targetRelpath: 'config/app.ini',
        enabled: true,
        overwrite: false,
        ifSourceMissing: 'skip',
      },
    ];

    const syncer = new Syncer(config);
    const { result } = await syncer.sync(null);

    expect(result.mappingCopied).toEqual(['my-config']);
    expect(result.mappingSkippedExisting).toEqual([]);
    const target = await readTree(targetDir);
    expect(target.get('config/app.ini')).toBe('[main]\nkey=value');
  });

  it('映射规则:目标已存在 + overwrite=false → 不覆盖,记入 skippedExisting', async () => {
    await writeFile(join(localDir, 'config.ini'), 'template-content');
    // 预先在目标放一个"用户已编辑过"的版本
    await writeFile(join(targetDir, 'config.ini'), 'user-edited-content');
    config.fileMappings = [
      {
        id: '1',
        name: 'config',
        sourcePath: join(localDir, 'config.ini'),
        targetRelpath: 'config.ini',
        enabled: true,
        overwrite: false, // 不覆盖
        ifSourceMissing: 'skip',
      },
    ];
    const syncer = new Syncer(config);
    const { result } = await syncer.sync(null);

    expect(result.mappingCopied).toEqual([]);
    expect(result.mappingSkippedExisting).toEqual(['config']);
    // 目标内容应保持"用户已编辑过"的版本
    const target = await readTree(targetDir);
    expect(target.get('config.ini')).toBe('user-edited-content');
  });

  it('映射规则:目标已存在 + overwrite=true → 强制覆盖', async () => {
    await writeFile(join(localDir, 'config.ini'), 'fresh-template');
    await writeFile(join(targetDir, 'config.ini'), 'stale-version');
    config.fileMappings = [
      {
        id: '1',
        name: 'config',
        sourcePath: join(localDir, 'config.ini'),
        targetRelpath: 'config.ini',
        enabled: true,
        overwrite: true,
        ifSourceMissing: 'skip',
      },
    ];
    const syncer = new Syncer(config);
    const { result } = await syncer.sync(null);

    expect(result.mappingCopied).toEqual(['config']);
    const target = await readTree(targetDir);
    expect(target.get('config.ini')).toBe('fresh-template');
  });

  it('映射规则:镜像豁免 — 目标里有但源里没有,不会被镜像删除', async () => {
    // 模拟:目标里有 user-notes.txt(源里没有),且配了映射规则保护它
    await writeFile(join(sourceDir, 'data.bin'), 'binary');
    await writeFile(join(targetDir, 'user-notes.txt'), '我的笔记'); // 用户文件
    // 本地"模板"文件用于映射(目标里没有时补回)
    await writeFile(join(localDir, 'template.txt'), 'default-template');
    config.fileMappings = [
      {
        id: '1',
        name: 'user-notes',
        sourcePath: join(localDir, 'template.txt'),
        targetRelpath: 'user-notes.txt',
        enabled: true,
        overwrite: false,
        ifSourceMissing: 'skip',
      },
    ];

    const syncer = new Syncer(config);
    const { result } = await syncer.sync(null);

    // user-notes.txt 不在 deleted 里(镜像豁免)
    expect(result.deleted).not.toContain('user-notes.txt');
    // 但也不在 mappingCopied 里(因为目标已有,overwrite=false)
    expect(result.mappingCopied).toEqual([]);
    expect(result.mappingSkippedExisting).toEqual(['user-notes']);
    // 内容应保留
    const target = await readTree(targetDir);
    expect(target.get('user-notes.txt')).toBe('我的笔记');
  });

  it('映射规则:用户删除了受保护文件 → 下次同步自动补回', async () => {
    // 源没有 user-notes.txt(纯本地模板生成)
    await writeFile(join(sourceDir, 'app.exe'), 'app');
    // 本地模板存在
    await writeFile(join(localDir, 'template.ini'), '[default]');
    // 目标里**没有** user-notes.ini(模拟用户误删)
    config.fileMappings = [
      {
        id: '1',
        name: 'user-config',
        sourcePath: join(localDir, 'template.ini'),
        targetRelpath: 'user-notes.ini',
        enabled: true,
        overwrite: false,
        ifSourceMissing: 'skip',
      },
    ];

    const syncer = new Syncer(config);
    const { result } = await syncer.sync(null);

    // 缺失 → 补回
    expect(result.mappingCopied).toEqual(['user-config']);
    const target = await readTree(targetDir);
    expect(target.get('user-notes.ini')).toBe('[default]');
  });

  it('映射规则:源文件不存在,skip 策略不报错', async () => {
    config.fileMappings = [
      {
        id: '1',
        name: 'missing',
        sourcePath: join(localDir, 'does-not-exist.ini'),
        targetRelpath: 'config/missing.ini',
        enabled: true,
        overwrite: false,
        ifSourceMissing: 'skip',
      },
    ];
    const syncer = new Syncer(config);
    const { result } = await syncer.sync(null);

    expect(result.warnings.find((w) => w.includes('missing'))).toBeUndefined();
    expect(result.mappingSkipped).toEqual(['missing']);
  });

  it('映射规则:disabled 时不执行', async () => {
    await writeFile(join(localDir, 'a.ini'), 'a');
    config.fileMappings = [
      {
        id: '1',
        name: 'a',
        sourcePath: join(localDir, 'a.ini'),
        targetRelpath: 'a.ini',
        enabled: false,
        overwrite: false,
        ifSourceMissing: 'skip',
      },
    ];
    const syncer = new Syncer(config);
    const { result } = await syncer.sync(null);
    expect(result.mappingCopied).toEqual([]);
  });

  it('映射规则:targetRelpath="" 时用源文件名补全(根目录)', async () => {
    await writeFile(join(localDir, 'inject.ini'), 'inject-content');
    config.fileMappings = [
      {
        id: '1',
        name: 'root-inject',
        sourcePath: join(localDir, 'inject.ini'),
        targetRelpath: '', // 根目录
        enabled: true,
        overwrite: false,
        ifSourceMissing: 'skip',
      },
    ];
    const syncer = new Syncer(config);
    const { result } = await syncer.sync(null);

    expect(result.mappingCopied).toEqual(['root-inject']);
    const target = await readTree(targetDir);
    // 应该在目标根目录下出现 inject.ini
    expect(target.get('inject.ini')).toBe('inject-content');
    // 回归:映射注入的文件不能被镜像删除阶段算作 −1
    // 之前豁免集用的是原始 targetRelpath(""),与解析后的 relPath("inject.ini")对不上
    expect(result.deleted).toEqual([]);
  });

  it('映射规则:targetRelpath 以 / 结尾时,用源文件名补全', async () => {
    await writeFile(join(localDir, 'cfg.bin'), 'bin-content');
    config.fileMappings = [
      {
        id: '1',
        name: 'subdir-inject',
        sourcePath: join(localDir, 'cfg.bin'),
        targetRelpath: 'sub/', // 以 / 结尾,补 cfg.bin
        enabled: true,
        overwrite: false,
        ifSourceMissing: 'skip',
      },
    ];
    const syncer = new Syncer(config);
    const { result } = await syncer.sync(null);

    expect(result.mappingCopied).toEqual(['subdir-inject']);
    const target = await readTree(targetDir);
    expect(target.get('sub/cfg.bin')).toBe('bin-content');
    // 回归:同上,"sub/" 解析后是 "sub/cfg.bin",豁免集要跟解析后路径一致
    expect(result.deleted).toEqual([]);
  });

  it('回归:source N 个 + 1 个映射(targetRelpath=""),跑完删除必须为 0', async () => {
    // 模拟用户实际场景:source 3 个文件 + 1 条把本地文件注入到 target 根的映射
    await writeFile(join(sourceDir, 'a.txt'), 'A');
    await writeFile(join(sourceDir, 'b.txt'), 'B');
    await writeFile(join(sourceDir, 'c.txt'), 'C');
    await writeFile(join(localDir, 'extra.ini'), 'extra');
    config.fileMappings = [
      {
        id: '1',
        name: 'root-extra',
        sourcePath: join(localDir, 'extra.ini'),
        targetRelpath: '',
        enabled: true,
        overwrite: false,
        ifSourceMissing: 'skip',
      },
    ];
    const syncer = new Syncer(config);

    // 跑两次:第一次把 target 填好(用户报的是后续轮询的 −1),
    // 第二次才是用户实际看到的"−1 删除"场景
    await syncer.sync(null);
    const { result } = await syncer.sync(null);

    // 核心断言:删除 = 0(之前这里会显示 −1,UI 误报"有变化")
    expect(result.deleted).toEqual([]);
    expect(result.added).toEqual([]);
    expect(result.modified).toEqual([]);
    expect(result.unchanged).toBe(3);
    expect(result.mappingCopied).toEqual([]); // 第二次:目标已存在 + overwrite=false,跳过
    expect(result.mappingSkippedExisting).toEqual(['root-extra']);
  });
});

describe('Syncer - 边界与错误', () => {
  let sourceDir: string;
  let targetDir: string;

  beforeEach(async () => {
    sourceDir = await makeTempDir('src-');
    targetDir = await makeTempDir('tgt-');
  });

  afterEach(async () => {
    await rmTemp(sourceDir);
    await rmTemp(targetDir);
  });

  it('源目录不存在 → fatal 错误,不写目标', async () => {
    const config: AppConfig = {
      sourceDir: 'Z:/non-existent-smb-share',
      targetDir,
      intervalSec: 60,
      backupCount: 3,
      autostart: false,
      fileMappings: [],
      backupDir: '',
    };
    const syncer = new Syncer(config);
    const { result } = await syncer.sync(null);

    expect(result.ok).toBe(false);
    expect(result.fatalError).toContain('源目录');
    // 'Z:/non-existent-smb-share' 不被 isNetworkPath 识别为网络路径
    // (单字母盘符,无 smb/cifs/nfs 关键词),所以归 not-found
    expect(result.fatalReason).toBe('not-found');
    expect(result.fatalTarget).toBe('source');
    // 目标不应被创建(或者保持空)
    const targetFiles = await readTree(targetDir);
    expect(targetFiles.size).toBe(0);
  });

  it('源是 UNC 路径 + 不存在 → fatalReason=network-not-found', async () => {
    const config = makeConfig('\\\\nonexistent-server\\share', targetDir);
    const syncer = new Syncer(config);
    const { result } = await syncer.sync(null);

    expect(result.ok).toBe(false);
    expect(result.fatalReason).toBe('network-not-found');
    expect(result.fatalTarget).toBe('source');
    expect(result.fatalError).toContain('网络不可达');
  });

  it('源是 smb 挂载点 + 不存在 → fatalReason=network-not-found', async () => {
    const config = makeConfig('/mnt/smb/nonexistent', targetDir);
    const syncer = new Syncer(config);
    const { result } = await syncer.sync(null);

    expect(result.ok).toBe(false);
    expect(result.fatalReason).toBe('network-not-found');
  });

  it('目标目录不存在 → 自动创建', async () => {
    const newTarget = join(targetDir, 'new-subdir');
    await writeTree(sourceDir, [{ relPath: 'x.txt', content: 'x' }]);
    const config: AppConfig = {
      sourceDir,
      targetDir: newTarget,
      intervalSec: 60,
      backupCount: 3,
      autostart: false,
      fileMappings: [],
      backupDir: '',
    };
    const syncer = new Syncer(config);
    const { result } = await syncer.sync(null);

    expect(result.ok).toBe(true);
    const stat = await fs.stat(newTarget);
    expect(stat.isDirectory()).toBe(true);
    expect((await readTree(newTarget)).get('x.txt')).toBe('x');
  });

  it('sourceDir / targetDir 未配置 → fatal 错误', async () => {
    const config: AppConfig = {
      sourceDir: '',
      targetDir: '',
      intervalSec: 60,
      backupCount: 3,
      autostart: false,
      fileMappings: [],
      backupDir: '',
    };
    const syncer = new Syncer(config);
    const { result } = await syncer.sync(null);

    expect(result.ok).toBe(false);
    expect(result.fatalError).toContain('未配置');
  });
});

describe('Syncer - 性能', () => {
  it('1000 文件同步耗时 < 30s', async () => {
    const sourceDir = await makeTempDir('perf-src-');
    const targetDir = await makeTempDir('perf-tgt-');
    try {
      const files: TreeFile[] = [];
      for (let i = 0; i < 1000; i++) {
        const dir = `d${i % 20}`;
        files.push({ relPath: `${dir}/f${i}.txt`, content: `content-${i}-${'x'.repeat(100)}` });
      }
      await writeTree(sourceDir, files);

      const config: AppConfig = {
        sourceDir,
        targetDir,
        intervalSec: 60,
        backupCount: 3,
        autostart: false,
        fileMappings: [],
        backupDir: '',
      };
      const syncer = new Syncer(config);
      const { result } = await syncer.sync(null);

      expect(result.ok).toBe(true);
      expect(result.added.length).toBe(1000);
      expect(result.durationMs).toBeLessThan(30_000);

      // 性能日志
      console.log(`[perf] 1000 文件同步耗时: ${result.durationMs}ms`);
    } finally {
      await rmTemp(sourceDir);
      await rmTemp(targetDir);
    }
  }, 60_000);
});
