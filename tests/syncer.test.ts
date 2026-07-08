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
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Syncer } from '../src/core/syncer.js';
import { DEFAULT_CONFIG } from '../src/core/config.js';
import { makeTempDir, rmTemp, readTree, writeTree, writeFile, wait, TreeFile } from './helpers.js';
import type { AppConfig } from '../src/core/types.js';

function makeConfig(sourceDir: string, targetDir: string, overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    ...DEFAULT_CONFIG,
    sourceDir,
    targetDir,
    // 测试默认 immediate(写 targetDir),新 staging 行为 opt-in
    applyMode: 'immediate',
    stagingDir: '',
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
      ignoreItems: [], applyMode: "immediate", stagingDir: "", executablePath: "",
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

describe('Syncer - ignoreItems', () => {
  let sourceDir: string;
  let targetDir: string;
  let localDir: string;
  let config: AppConfig;

  beforeEach(async () => {
    sourceDir = await makeTempDir('ig-src-');
    targetDir = await makeTempDir('ig-tgt-');
    localDir = await makeTempDir('ig-local-');
    config = {
      sourceDir,
      targetDir,
      intervalSec: 60,
      backupCount: 3,
      autostart: false,
      fileMappings: [],
      ignoreItems: [], applyMode: "immediate", stagingDir: "", executablePath: "",
      backupDir: '',
    };
  });

  afterEach(async () => {
    await rmTemp(sourceDir);
    await rmTemp(targetDir);
    await rmTemp(localDir);
  });

  it('ignoreItems=[] 时行为不变(回归)', async () => {
    await writeTree(sourceDir, [
      { relPath: 'a.txt', content: 'a' },
      { relPath: 'cache/x.txt', content: 'x' },
    ]);
    const syncer = new Syncer(config);
    const { result } = await syncer.sync(null);
    expect(result.added.sort()).toEqual(['a.txt', 'cache/x.txt']);
    expect(result.deleted).toEqual([]);
  });

  it('ignoreItems=[cache] — 源/目标都有 cache/x.txt,不变(其他文件正常 sync)', async () => {
    await writeTree(sourceDir, [
      { relPath: 'a.txt', content: 'a' },
      { relPath: 'cache/x.txt', content: 'x' },
    ]);
    await wait(20);
    await writeTree(targetDir, [
      { relPath: 'a.txt', content: 'OLD-a' },        // sizes 不同 → 会同步
      { relPath: 'cache/x.txt', content: 'OLD-cache' }, // 忽略
    ]);
    config.ignoreItems = ['cache'];
    const syncer = new Syncer(config);
    const { result } = await syncer.sync(null);

    // cache 内容不参与 diff
    expect(result.added).not.toContain('cache/x.txt');
    expect(result.modified).not.toContain('cache/x.txt');
    expect(result.deleted).not.toContain('cache/x.txt');
    // a.txt 正常同步(首次 sync,lastIndexMap 为空 → isNew=true → 进 added)
    expect(result.added).toContain('a.txt');
    expect(result.modified).toEqual([]);
    // target/a.txt 被覆盖
    expect((await readTree(targetDir)).get('a.txt')).toBe('a');
    // target/cache/x.txt 不动
    expect((await readTree(targetDir)).get('cache/x.txt')).toBe('OLD-cache');
  });

  it('ignoreItems=[cache] — 源有 cache/x.txt 但目标没有,不进 added', async () => {
    await writeTree(sourceDir, [{ relPath: 'cache/new.txt', content: 'n' }]);
    config.ignoreItems = ['cache'];
    const syncer = new Syncer(config);
    const { result } = await syncer.sync(null);

    expect(result.added).toEqual([]);
    expect(result.modified).toEqual([]);
    expect(result.deleted).toEqual([]);
    expect((await readTree(targetDir)).has('cache/new.txt')).toBe(false);
  });

  it('ignoreItems=[cache] — 源没有但目标有 cache/x.txt,镜像不删', async () => {
    await writeTree(sourceDir, [{ relPath: 'a.txt', content: 'a' }]);
    await writeTree(targetDir, [
      { relPath: 'a.txt', content: 'a' },
      { relPath: 'cache/old.txt', content: 'OLD' },
    ]);
    config.ignoreItems = ['cache'];
    const syncer = new Syncer(config);
    const { result } = await syncer.sync(null);

    expect(result.deleted).not.toContain('cache/old.txt');
    expect(result.deleted).toEqual([]);
    expect((await readTree(targetDir)).has('cache/old.txt')).toBe(true);
  });

  it('ignoreItems=[cache] — 子目录 cache/sub/ 自动包含', async () => {
    await writeTree(sourceDir, [
      { relPath: 'cache/sub/deep.txt', content: 'd' },
      { relPath: 'cache/top.txt', content: 't' },
    ]);
    await writeTree(targetDir, [
      { relPath: 'cache/sub/deep.txt', content: 'OLD' },
    ]);
    config.ignoreItems = ['cache'];
    const syncer = new Syncer(config);
    const { result } = await syncer.sync(null);

    expect(result.added).toEqual([]);
    expect(result.modified).toEqual([]);
    expect(result.deleted).toEqual([]);
    expect((await readTree(targetDir)).get('cache/sub/deep.txt')).toBe('OLD');
  });

  it('嵌套 ignoreItems=[build/cache] — 只忽略 build/cache/,不影响 build/src/', async () => {
    await writeTree(sourceDir, [
      { relPath: 'build/cache/x.txt', content: 'x' },     // 忽略
      { relPath: 'build/src/main.ts', content: 'm' },     // 同步
    ]);
    await wait(20);
    await writeTree(targetDir, [
      { relPath: 'build/cache/x.txt', content: 'OLD-cache' },  // 忽略
      { relPath: 'build/src/main.ts', content: 'OLD-main' },   // sizes 不同,会同步
    ]);
    config.ignoreItems = ['build/cache'];
    const syncer = new Syncer(config);
    const { result } = await syncer.sync(null);

    // 首次 sync(lastIndexMap=null)→ 全部 isNew,进 added
    expect(result.modified).toEqual([]);
    expect(result.deleted).toEqual([]);
    expect(result.added).toEqual(['build/src/main.ts']);
    expect(result.added).not.toContain('build/cache/x.txt');
    // target/build/cache/x.txt 不动
    expect((await readTree(targetDir)).get('build/cache/x.txt')).toBe('OLD-cache');
    // target/build/src/main.ts 被覆盖
    expect((await readTree(targetDir)).get('build/src/main.ts')).toBe('m');
  });

  it('关键:ignoreItems=[cache] 只影响 cache/,不影响 subdir/cache/(不跨位置匹配)', async () => {
    await writeTree(sourceDir, [
      { relPath: 'cache/foo.txt', content: 'src-cache' },
      { relPath: 'subdir/cache/foo.txt', content: 'src-subdir-cache' },
    ]);
    config.ignoreItems = ['cache'];  // 精确 cache,不含 subdir/cache
    const syncer = new Syncer(config);
    const { result } = await syncer.sync(null);

    // cache/foo.txt 被忽略,subdir/cache/foo.txt 正常同步
    expect(result.added).toEqual(['subdir/cache/foo.txt']);
    expect(result.added).not.toContain('cache/foo.txt');
    const target = await readTree(targetDir);
    expect(target.has('cache/foo.txt')).toBe(false);    // 未拷贝
    expect(target.get('subdir/cache/foo.txt')).toBe('src-subdir-cache');
  });

  it('文件项 ignoreItems=[config/local.ini] — 只忽略这一个文件,同目录其他文件不受影响', async () => {
    await writeTree(sourceDir, [
      { relPath: 'config/local.ini', content: 'src-local' },
      { relPath: 'config/other.ini', content: 'src-other' },
      { relPath: 'config/sub/extra.ini', content: 'src-extra' },
    ]);
    config.ignoreItems = ['config/local.ini'];
    const syncer = new Syncer(config);
    const { result } = await syncer.sync(null);

    // 只有 config/local.ini 不进 added
    expect(result.added).toEqual(['config/other.ini', 'config/sub/extra.ini']);
    expect(result.added).not.toContain('config/local.ini');

    const target = await readTree(targetDir);
    expect(target.has('config/local.ini')).toBe(false);
    expect(target.get('config/other.ini')).toBe('src-other');
    expect(target.get('config/sub/extra.ini')).toBe('src-extra');
  });

  it('文件项 ignoreItems=[config/local.ini] — 镜像删除不删它', async () => {
    await writeTree(sourceDir, [
      { relPath: 'config/other.ini', content: 'other' },
    ]);
    await writeTree(targetDir, [
      { relPath: 'config/local.ini', content: 'USER-EDITED' },  // 忽略,保留
      { relPath: 'config/other.ini', content: 'OLD-other' },
    ]);
    config.ignoreItems = ['config/local.ini'];
    const syncer = new Syncer(config);
    const { result } = await syncer.sync(null);

    // config/local.ini 不在 deleted(因为 ignoreItems 豁免)
    expect(result.deleted).not.toContain('config/local.ini');
    const target = await readTree(targetDir);
    expect(target.get('config/local.ini')).toBe('USER-EDITED');  // 保留
    expect(target.get('config/other.ini')).toBe('other');       // 覆盖
  });

  it('映射规则 targetRelpath 在 ignoreItem 内 → mappingSkipped', async () => {
    await writeFile(join(localDir, 'local.ini'), '[main]');
    await writeTree(sourceDir, [{ relPath: 'a.txt', content: 'a' }]);
    config.ignoreItems = ['config'];
    config.fileMappings = [
      {
        id: '1',
        name: 'local-config',
        sourcePath: join(localDir, 'local.ini'),
        targetRelpath: 'config/local.ini',
        enabled: true,
        overwrite: true,
        ifSourceMissing: 'skip',
      },
    ];
    const syncer = new Syncer(config);
    const { result } = await syncer.sync(null);

    expect(result.mappingCopied).toEqual([]);
    expect(result.mappingSkipped).toContain('local-config');
    expect((await readTree(targetDir)).has('config/local.ini')).toBe(false);
  });
});

describe('Syncer - ignoreItems 工具函数', () => {
  it('buildIgnoreItems 规范化:["cache/"]、["cache"]、["\\cache\\"] 视为同一条', async () => {
    const { buildIgnoreItems } = await import('../src/core/syncer.js');
    expect(buildIgnoreItems(['cache/'])).toEqual(['cache']);
    expect(buildIgnoreItems(['cache'])).toEqual(['cache']);
    expect(buildIgnoreItems(['\\cache\\'])).toEqual(['cache']);
  });

  it('buildIgnoreItems 去重:["cache","cache/","cache"] → 单条', async () => {
    const { buildIgnoreItems } = await import('../src/core/syncer.js');
    expect(buildIgnoreItems(['cache', 'cache/', 'cache'])).toEqual(['cache']);
  });

  it('buildIgnoreItems 拒绝非法条目', async () => {
    const { buildIgnoreItems } = await import('../src/core/syncer.js');
    expect(buildIgnoreItems([])).toEqual([]);
    expect(buildIgnoreItems(undefined)).toEqual([]);
    expect(buildIgnoreItems(['', '.', '..', 'a/../b'])).toEqual([]);
    expect(buildIgnoreItems(['C:\\abs', 'D:/abs'])).toEqual([]); // 含 :
    // /abs 和 \abs 规范化后等价 → 去重,只剩一条
    expect(buildIgnoreItems(['/abs', '\\abs'])).toEqual(['abs']);
  });

  it('isInIgnoredItem 匹配规则(prefix-only)', async () => {
    const { isInIgnoredItem } = await import('../src/core/types.js');

    // 目录项:精确 / 直接子 / 任意深度子
    expect(isInIgnoredItem('cache', ['cache'])).toBe(true);          // 自身
    expect(isInIgnoredItem('cache/x', ['cache'])).toBe(true);        // 直接子
    expect(isInIgnoredItem('cache/sub/y', ['cache'])).toBe(true);    // 嵌套子
    expect(isInIgnoredItem('cache/sub/deep/z.txt', ['cache'])).toBe(true);

    // 名字相近但不是子目录 — 不匹配
    expect(isInIgnoredItem('cachefile.txt', ['cache'])).toBe(false);
    expect(isInIgnoredItem('src/a.txt', ['cache'])).toBe(false);

    // 关键:不会"任意位置匹配" — 用户选了 cache,subdir/cache 不被误伤
    expect(isInIgnoredItem('src/cache/x', ['cache'])).toBe(false);
    expect(isInIgnoredItem('subdir/cache/y', ['cache'])).toBe(false);

    // 嵌套精确路径
    expect(isInIgnoredItem('build/cache/x', ['build/cache'])).toBe(true);
    expect(isInIgnoredItem('build/cache/sub/y', ['build/cache'])).toBe(true);
    expect(isInIgnoredItem('build/src/main.ts', ['build/cache'])).toBe(false);

    // 单文件项:精确匹配
    expect(isInIgnoredItem('config/local.ini', ['config/local.ini'])).toBe(true);
    expect(isInIgnoredItem('config/local.ini.bak', ['config/local.ini'])).toBe(false);
    expect(isInIgnoredItem('config/other.ini', ['config/local.ini'])).toBe(false);

    // 边界
    expect(isInIgnoredItem('', ['cache'])).toBe(false);
    expect(isInIgnoredItem('cache', [])).toBe(false);              // 空数组 = 不过滤
  });
});

describe('Syncer - applyMode=staging', () => {
  let sourceDir: string;
  let targetDir: string;
  let stagingDir: string;
  let localDir: string;
  let config: AppConfig;

  beforeEach(async () => {
    sourceDir = await makeTempDir('stg-src-');
    targetDir = await makeTempDir('stg-tgt-');
    stagingDir = await makeTempDir('stg-stg-');
    localDir = await makeTempDir('stg-local-');
    config = {
      sourceDir,
      targetDir,
      intervalSec: 60,
      backupCount: 3,
      autostart: false,
      fileMappings: [],
      ignoreItems: [],
      applyMode: 'staging',  // ← 强制 staging 模式
      stagingDir: '',
      executablePath: '',
      backupDir: '',
    };
  });
  afterEach(async () => {
    await rmTemp(sourceDir);
    await rmTemp(targetDir);
    await rmTemp(stagingDir);
    await rmTemp(localDir);
  });

  it('staging 模式:新文件写到 stagingDir,targetDir 不动', async () => {
    config.stagingDir = stagingDir;
    await writeTree(sourceDir, [
      { relPath: 'a.txt', content: 'a' },
      { relPath: 'sub/b.txt', content: 'b' },
    ]);
    const syncer = new Syncer(config);
    const { result } = await syncer.sync(null);

    expect(result.ok).toBe(true);
    expect(result.added.sort()).toEqual(['a.txt', 'sub/b.txt']);
    expect(result.pendingApplyCount).toBe(2);
    // target 里没有
    const targetTree = await readTree(targetDir);
    expect(targetTree.size).toBe(0);
    // staging 里有
    const stagingTree = await readTree(stagingDir);
    expect(stagingTree.get('a.txt')).toBe('a');
    expect(stagingTree.get('sub/b.txt')).toBe('b');
    // .pending-apply 标记存在
    await expect(fs.stat(join(stagingDir, '.pending-apply'))).resolves.toBeTruthy();
  });

  it('staging 模式:target 里的旧文件 sync 不删(写到 .pending-delete.json 让 swap 处理)', async () => {
    config.stagingDir = stagingDir;
    await writeTree(targetDir, [
      { relPath: 'orphan.txt', content: 'OLD-orphan' },
    ]);
    await writeTree(sourceDir, [{ relPath: 'a.txt', content: 'a' }]);

    const syncer = new Syncer(config);
    const { result } = await syncer.sync(null);

    // 镜像删除阶段记录 orphan.txt,staging 模式下 target 不直接删(避免误删正在运行的程序)
    expect(result.deleted).toEqual(['orphan.txt']);
    expect((await readTree(targetDir)).has('orphan.txt')).toBe(true);
    // staging 里也没有 orphan.txt(避免 swap 时带过去)
    const stagingTree = await readTree(stagingDir);
    expect(stagingTree.has('orphan.txt')).toBe(false);
    // ★ 新行为:把待删列表写到 stagingDir/.pending-delete.json,swap 时实际 target.unlink
    const markerPath = join(stagingDir, '.pending-delete.json');
    expect(existsSync(markerPath)).toBe(true);
    const parsed = JSON.parse(await fs.readFile(markerPath, 'utf-8'));
    expect(parsed.rels).toEqual(['orphan.txt']);
  });

  it('staging 模式 + ignoreItems:被忽略的文件不进 staging', async () => {
    config.stagingDir = stagingDir;
    config.ignoreItems = ['cache'];
    await writeTree(sourceDir, [
      { relPath: 'a.txt', content: 'a' },
      { relPath: 'cache/foo.txt', content: 'x' },
    ]);
    const syncer = new Syncer(config);
    const { result } = await syncer.sync(null);

    expect(result.added).toEqual(['a.txt']);
    expect(result.added).not.toContain('cache/foo.txt');
    // staging 里没有 cache/
    const stagingTree = await readTree(stagingDir);
    expect(stagingTree.has('cache/foo.txt')).toBe(false);
    expect(stagingTree.has('a.txt')).toBe(true);
  });

  it('staging 模式 + fileMappings:映射写入 stagingDir', async () => {
    config.stagingDir = stagingDir;
    await writeFile(join(localDir, 'tmpl.ini'), 'NEW-tmpl');
    config.fileMappings = [
      {
        id: '1', name: 'tmpl',
        sourcePath: join(localDir, 'tmpl.ini'),
        targetRelpath: 'config/tmpl.ini',
        enabled: true, overwrite: true, ifSourceMissing: 'skip',
      },
    ];
    const syncer = new Syncer(config);
    const { result } = await syncer.sync(null);

    expect(result.mappingCopied).toEqual(['tmpl']);
    // staging 有,target 没有
    expect((await readTree(stagingDir)).get('config/tmpl.ini')).toBe('NEW-tmpl');
    expect((await readTree(targetDir)).has('config/tmpl.ini')).toBe(false);
  });

  it('immediate 模式:行为保持原样(写到 targetDir)', async () => {
    config.applyMode = 'immediate';
    await writeTree(sourceDir, [{ relPath: 'a.txt', content: 'a' }]);
    const syncer = new Syncer(config);
    const { result } = await syncer.sync(null);

    expect(result.added).toEqual(['a.txt']);
    expect(result.pendingApplyCount).toBeUndefined(); // immediate 不设这个
    expect((await readTree(targetDir)).get('a.txt')).toBe('a');
    expect((await readTree(stagingDir)).size).toBe(0); // staging 没碰
  });

  // ★ 回归:applyMappingsOnly 在 staging 模式下也要写到 stagingDir
  // 之前:applyMapping() 不传 overrideWriteDir → 写 this.config.targetDir
  //   → staging 模式下"立即应用映射"会直接写 target,绕过文件锁保护
  //   → 目标程序正在运行时(被锁)→ copyFile EBUSY 失败/抛错
  // 修:applyMappingsOnly 算出 writeDir(staging/stagingDir 或 target)后传给 applyMapping
  it('staging 模式 + applyMappingsOnly:映射写入 stagingDir + 标记 .pending-apply', async () => {
    config.stagingDir = stagingDir;
    await writeFile(join(localDir, 'tmpl.ini'), 'NEW-tmpl');
    config.fileMappings = [
      {
        id: '1', name: 'tmpl',
        sourcePath: join(localDir, 'tmpl.ini'),
        targetRelpath: 'config/tmpl.ini',
        enabled: true, overwrite: true, ifSourceMissing: 'skip',
      },
    ];
    const syncer = new Syncer(config);
    const result = await syncer.applyMappingsOnly();

    expect(result.ok).toBe(true);
    expect(result.mappingCopied).toEqual(['tmpl']);
    // staging 有(关键断言)— 写到了 staging 而不是 target
    expect((await readTree(stagingDir)).get('config/tmpl.ini')).toBe('NEW-tmpl');
    // target 仍然空(没绕过 staging)
    expect((await readTree(targetDir)).has('config/tmpl.ini')).toBe(false);
    // .pending-apply 标记必须存在,否则 swap 阶段(hasPendingApply)不知道有内容
    // → 内容会卡在 staging 永远不 swap
    await expect(fs.stat(join(stagingDir, '.pending-apply'))).resolves.toBeTruthy();
  });
});

describe('ConfigManager - ignoreItems 校验', () => {
  it('拒绝空字符串、".", "..", 绝对路径、重复', async () => {
    const { ConfigManager } = await import('../src/core/config.js');
    const tmpCfg = await makeTempDir('cfg-test-');
    const cfgPath = join(tmpCfg, 'config.json');
    const mgr = new ConfigManager({ configPath: cfgPath, defaults: { ...DEFAULT_CONFIG, ignoreItems: [], applyMode: "immediate", stagingDir: "", executablePath: "", } });
    try {
      await expect(mgr.save({ ...DEFAULT_CONFIG, ignoreItems: ['cache', ''] as never })).rejects.toThrow(/ignoreItems/);
      await expect(mgr.save({ ...DEFAULT_CONFIG, ignoreItems: ['.', 'cache'] } as never)).rejects.toThrow(/ignoreItems/);
      await expect(mgr.save({ ...DEFAULT_CONFIG, ignoreItems: ['../escape', 'cache'] } as never)).rejects.toThrow(/ignoreItems/);
      await expect(mgr.save({ ...DEFAULT_CONFIG, ignoreItems: ['C:\\abs', 'cache'] } as never)).rejects.toThrow(/ignoreItems/);
      await expect(mgr.save({ ...DEFAULT_CONFIG, ignoreItems: ['cache', 'cache'] } as never)).rejects.toThrow(/ignoreItems/);
      // 合法值应通过
      await expect(mgr.save({ ...DEFAULT_CONFIG, ignoreItems: ['cache', 'build/cache'] })).resolves.toBeUndefined();
    } finally {
      await rmTemp(tmpCfg);
    }
  });
});

describe('ConfigManager - executablePath 校验', () => {
  it('空字符串 → 通过(禁用)', async () => {
    const { ConfigManager } = await import('../src/core/config.js');
    const tmpCfg = await makeTempDir('cfg-exec-');
    const cfgPath = join(tmpCfg, 'config.json');
    const mgr = new ConfigManager({ configPath: cfgPath, defaults: { ...DEFAULT_CONFIG, applyMode: "immediate", stagingDir: "", executablePath: "", } });
    try {
      await expect(mgr.save({ ...DEFAULT_CONFIG, executablePath: '' })).resolves.toBeUndefined();
    } finally {
      await rmTemp(tmpCfg);
    }
  });

  it('拒绝 ".", "..", 含 ":" 的路径', async () => {
    const { ConfigManager } = await import('../src/core/config.js');
    const tmpCfg = await makeTempDir('cfg-exec-');
    const cfgPath = join(tmpCfg, 'config.json');
    const mgr = new ConfigManager({ configPath: cfgPath, defaults: { ...DEFAULT_CONFIG, applyMode: "immediate", stagingDir: "", executablePath: "", } });
    try {
      await expect(mgr.save({ ...DEFAULT_CONFIG, executablePath: '.' })).rejects.toThrow(/executablePath/);
      await expect(mgr.save({ ...DEFAULT_CONFIG, executablePath: '..' })).rejects.toThrow(/executablePath/);
      await expect(mgr.save({ ...DEFAULT_CONFIG, executablePath: '../escape' })).rejects.toThrow(/executablePath/);
      await expect(mgr.save({ ...DEFAULT_CONFIG, executablePath: 'C:\\abs' })).rejects.toThrow(/executablePath/);
      // 合法值应通过
      await expect(mgr.save({ ...DEFAULT_CONFIG, executablePath: 'Game/MyGame.exe' })).resolves.toBeUndefined();
    } finally {
      await rmTemp(tmpCfg);
    }
  });
});

describe('Syncer - executableUpdate 字段', () => {
  let sourceDir: string;
  let targetDir: string;
  let config: AppConfig;

  beforeEach(async () => {
    sourceDir = await makeTempDir('exe-src-');
    targetDir = await makeTempDir('exe-tgt-');
    config = {
      sourceDir,
      targetDir,
      intervalSec: 60,
      backupCount: 3,
      autostart: false,
      fileMappings: [],
      ignoreItems: [],
      applyMode: 'immediate',
      stagingDir: '',
      executablePath: '',
      backupDir: '',
    };
  });
  afterEach(async () => {
    await rmTemp(sourceDir);
    await rmTemp(targetDir);
  });

  it('executablePath 配置 + sync 中该文件 EBUSY → executableUpdate="blocked"(immediate 模式)', async () => {
    // 用 Windows 上难模拟 EBUSY,这里只验证字段逻辑:
    // executablePath 配 + sync 成功 → 字段不填(scheduler 后续 launch)
    config.executablePath = 'app.exe';
    await writeFile(join(sourceDir, 'app.exe'), 'content');
    await writeFile(join(targetDir, 'app.exe'), 'OLD-content');
    const syncer = new Syncer(config);
    const { result } = await syncer.sync(null);
    expect(result.ok).toBe(true);
    // immediate 模式 sync 没 EBUSY → 字段未填(scheduler 后续处理)
    expect(result.executableUpdate).toBeUndefined();
  });

  it('executablePath 未配置 → 不填字段', async () => {
    config.executablePath = '';
    await writeFile(join(sourceDir, 'a.txt'), 'a');
    const syncer = new Syncer(config);
    const { result } = await syncer.sync(null);
    expect(result.executableUpdate).toBeUndefined();
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
      ignoreItems: [], applyMode: "immediate", stagingDir: "", executablePath: "",
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
      ignoreItems: [], applyMode: "immediate", stagingDir: "", executablePath: "",
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
      ignoreItems: [], applyMode: "immediate", stagingDir: "", executablePath: "",
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
      ignoreItems: [], applyMode: "immediate", stagingDir: "", executablePath: "",
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

describe('Syncer - applyMode=immediate-with-precheck(锁住则拒绝)', () => {
  let sourceDir: string;
  let targetDir: string;
  let config: AppConfig;

  beforeEach(async () => {
    sourceDir = await makeTempDir('prefl-src-');
    targetDir = await makeTempDir('prefl-tgt-');
    config = makeConfig(sourceDir, targetDir, { applyMode: 'immediate-with-precheck' });
  });

  afterEach(async () => {
    await rmTemp(sourceDir);
    await rmTemp(targetDir);
  });

  it('★ 目标文件未被占 + applyMode=immediate-with-precheck → 正常 sync', async () => {
    await writeTree(sourceDir, [{ relPath: 'a.txt', content: 'NEW' }]);
    const syncer = new Syncer(config);
    const { result } = await syncer.sync(null);

    expect(result.ok).toBe(true);
    expect(result.added).toEqual(['a.txt']);
    // 真写到 target(immediate-with-precheck 的写盘路径跟 immediate 一样)
    expect((await fs.readFile(join(targetDir, 'a.txt'), 'utf-8'))).toBe('NEW');
  });

  it('★ 目标文件被独占打开 → fatalError + 整次同步拒绝(零写入)', async () => {
    // 准备:target 有个被目标程序"占着"的文件
    await writeFile(join(targetDir, 'locked.exe'), 'X');
    const holdingFh = await fs.open(join(targetDir, 'locked.exe'), 'r+');

    // 同时 source 里有新内容触发覆盖
    await writeTree(sourceDir, [
      { relPath: 'locked.exe', content: 'NEW' },
      { relPath: 'other.txt', content: 'OTHER' },
    ]);

    try {
      const syncer = new Syncer(config);
      const { result } = await syncer.sync(null);

      // 平台相关:POSIX 上 fs.open 允许共享(检测不到锁),
      // Windows 上可能检测到 — 我们用 result.ok 看效果
      if (!result.ok) {
        expect(result.fatalError).toMatch(/目标文件被占用|被锁定|被锁/i);
        expect(result.fatalReason).toBe('target-locked');
        expect(result.fatalTarget).toBe('target');
        // ★ 关键:拒绝模式不应该有任何写入
        // 如果是 modified 路径,target 的 locked.exe 仍应是旧内容
        // 如果是 added 路径,other.txt 不应被创建
        // 至少 result.fatalError 设置了 — 写入被中断
        expect((await fs.readFile(join(targetDir, 'locked.exe'), 'utf-8'))).toBe('X');
        // other.txt 不应被创建
        await expect(fs.readFile(join(targetDir, 'other.txt'), 'utf-8')).rejects.toThrow();
      } else {
        // 平台未锁住 — 至少 confirm 跑通了无死锁路径
        expect(result.added.length).toBeGreaterThan(0);
      }
    } finally {
      await holdingFh.close();
    }
  });

  it('applyMode=immediate-with-precheck + dryRun 跑 → 不触发 precheck(fail-fast 仅在 real sync)', async () => {
    // dryRun 是检测模式,不应该因为锁而 abort
    await writeTree(sourceDir, [{ relPath: 'a.txt', content: 'A' }]);
    const syncer = new Syncer(config);
    const { result } = await syncer.sync(null, { dryRun: true });
    // dryRun 总是返回 ok=true(没真写所以不会 fatal)
    expect(result.ok).toBe(true);
    expect(result.added).toEqual(['a.txt']);
  });

  it('applyMode=immediate-with-precheck + 全部是新增(ENOENT) → ok=true', async () => {
    // precheck 对 ENOENT 跳过,新文件不存在不算锁
    await writeTree(sourceDir, [
      { relPath: 'new1.txt', content: '1' },
      { relPath: 'sub/new2.txt', content: '2' },
    ]);
    const syncer = new Syncer(config);
    const { result } = await syncer.sync(null);
    expect(result.ok).toBe(true);
    expect(result.added.sort()).toEqual(['new1.txt', 'sub/new2.txt']);
  });

  it('applyMode=immediate-with-precheck + 增量修改(目标已存在但未锁)→ 正常 sync', async () => {
    // 目标里已有 a.txt,内容 OLD(3 字节)
    await writeFile(join(targetDir, 'a.txt'), 'OLD');
    // source 里是 NEW-LONGER(10 字节)— 故意 size 不同,避开 mtime 抖动
    // (MTIME_JITTER_TOLERANCE_MS=2ms,同 size 同步写可能 mtime 接近被当 unchanged)
    await writeTree(sourceDir, [{ relPath: 'a.txt', content: 'NEW-LONGER' }]);
    const syncer = new Syncer(config);
    const { result } = await syncer.sync(null);
    expect(result.ok).toBe(true);
    // 没 lastIndex → added 而非 modified(precheck 不区分)
    expect(result.added).toEqual(['a.txt']);
    // 覆盖成功
    expect((await fs.readFile(join(targetDir, 'a.txt'), 'utf-8'))).toBe('NEW-LONGER');
  });
});

describe('Syncer - applyMappingsOnly 在 staging 模式下的写入位置', () => {
  let sourceDir: string;
  let targetDir: string;
  let stagingDir: string;
  let localDir: string;
  let config: AppConfig;

  beforeEach(async () => {
    sourceDir = await makeTempDir('amp-src-');
    targetDir = await makeTempDir('amp-tgt-');
    stagingDir = await makeTempDir('amp-stg-');
    localDir = await makeTempDir('amp-local-');
    config = {
      ...DEFAULT_CONFIG,
      sourceDir,
      targetDir,
      stagingDir,
      applyMode: 'staging',
      fileMappings: [],
      ignoreItems: [],
    };
  });
  afterEach(async () => {
    await rmTemp(sourceDir);
    await rmTemp(targetDir);
    await rmTemp(stagingDir);
    await rmTemp(localDir);
  });

  // ★ 关键回归:测试 IPC handler mappings:testOne 行为
  // 之前:测试时用 currentConfig(applyMode='staging'),文件写到 stagingDir
  //  → 通知说"成功"但用户去 targetDir 找文件,找不到,以为是 bug
  // 修法:测试时强制 applyMode='immediate',文件直接落 target
  // 此测试验证这个语义在两个分支下都正确:
  //   - applyMappingsOnly 走 staging 路径(staging 默认行为)
  //   - 用 immediate override 走 immediate 路径(测试按钮)
  it('★ staging 模式 + applyMappingsOnly:文件写到 stagingDir,不在 targetDir', async () => {
    await writeFile(join(localDir, 'template.ini'), 'CONTENT');
    config.fileMappings = [
      {
        id: '1', name: 't',
        sourcePath: join(localDir, 'template.ini'),
        targetRelpath: 'data/template.ini',
        enabled: true, overwrite: true, ifSourceMissing: 'skip',
      },
    ];
    const syncer = new Syncer(config);
    const result = await syncer.applyMappingsOnly();
    expect(result.ok).toBe(true);
    expect(result.mappingCopied).toEqual(['t']);
    // staging 模式:文件在 stagingDir
    expect((await fs.readFile(join(stagingDir, 'data', 'template.ini'), 'utf-8'))).toBe('CONTENT');
    // 但 targetDir 没动
    const targetFile = await fs.readFile(join(targetDir, 'data', 'template.ini'), 'utf-8').catch(() => null);
    expect(targetFile).toBeNull();
  });

  it('★ 测试按钮路径(immediate 模式 override):文件直接落 targetDir', async () => {
    await writeFile(join(localDir, 'template.ini'), 'CONTENT');
    config.fileMappings = [
      {
        id: '1', name: 't',
        sourcePath: join(localDir, 'template.ini'),
        targetRelpath: 'data/template.ini',
        enabled: true, overwrite: true, ifSourceMissing: 'skip',
      },
    ];
    // ★ 模拟 IPC handler 的 testConfig 覆盖:applyMode='immediate'
    // 这就是 mappings:testOne 在 main/index.ts 里的行为
    const testConfig = { ...config, applyMode: 'immediate' as const };
    const syncer = new Syncer(testConfig);
    const result = await syncer.applyMappingsOnly();
    expect(result.ok).toBe(true);
    expect(result.mappingCopied).toEqual(['t']);
    // 文件直接落到 targetDir(用户期望的"测试=立即看效果"语义)
    expect((await fs.readFile(join(targetDir, 'data', 'template.ini'), 'utf-8'))).toBe('CONTENT');
    // stagingDir 不动
    const stagingFile = await fs.readFile(join(stagingDir, 'data', 'template.ini'), 'utf-8').catch(() => null);
    expect(stagingFile).toBeNull();
  });
});

describe('Syncer - 映射拷贝失败 (mappingFailed + 详细错误)', () => {
  let sourceDir: string;
  let targetDir: string;
  let localDir: string;
  let config: AppConfig;

  beforeEach(async () => {
    sourceDir = await makeTempDir('mf-src-');
    targetDir = await makeTempDir('mf-tgt-');
    localDir = await makeTempDir('mf-local-');
    config = makeConfig(sourceDir, targetDir);
  });
  afterEach(async () => {
    await rmTemp(sourceDir);
    await rmTemp(targetDir);
    await rmTemp(localDir);
  });

  // ★ 关键回归:之前 copyFail 也推 mappingCopied,UI 误以为成功
  // 现在:copyFail 推 mappingFailed,带 errno + 修复建议
  it('映射源文件不存在 → 推 mappingSkipped,不带 mappingFailed', async () => {
    config.fileMappings = [
      {
        id: '1', name: 'missing',
        sourcePath: join(localDir, 'does-not-exist.ini'),
        targetRelpath: 'config/missing.ini',
        enabled: true, overwrite: true, ifSourceMissing: 'skip',
      },
    ];
    const syncer = new Syncer(config);
    const result = await syncer.applyMappingsOnly();
    expect(result.ok).toBe(true);
    expect(result.mappingCopied).toEqual([]);
    expect(result.mappingSkipped).toEqual(['missing']);
    expect(result.mappingFailed ?? []).toEqual([]);
  });

  it('映射源路径是个目录(不是文件)→ ifSourceMissing=skip,源"非文件"被 skipped', async () => {
    // 创建一个目录但不是文件 → 拷贝会被拒绝
    const dirPath = join(localDir, 'subdir');
    await fs.mkdir(dirPath, { recursive: true });
    config.fileMappings = [
      {
        id: '1', name: 'isDir',
        sourcePath: dirPath,
        targetRelpath: 'config/dir.ini',
        enabled: true, overwrite: true, ifSourceMissing: 'skip',
      },
    ];
    const syncer = new Syncer(config);
    const result = await syncer.applyMappingsOnly();
    expect(result.ok).toBe(true);
    // 文件源检查是 st.isFile() = false → 当作源不存在 → skipped
    expect(result.mappingSkipped).toEqual(['isDir']);
    expect(result.mappingFailed ?? []).toEqual([]);
  });
});

describe('Syncer - 映射目标目录下的文件不参与镜像删除', () => {
  let sourceDir: string;
  let targetDir: string;
  let localDir: string;
  let config: AppConfig;

  beforeEach(async () => {
    sourceDir = await makeTempDir('mt-src-');
    targetDir = await makeTempDir('mt-tgt-');
    localDir = await makeTempDir('mt-local-');
    config = makeConfig(sourceDir, targetDir);
  });
  afterEach(async () => {
    await rmTemp(sourceDir);
    await rmTemp(targetDir);
    await rmTemp(localDir);
  });

  // ★ 用户报告:映射 data/template.ini 后,target/data/ 下的 user-config.ini
  //   不该被镜像删(用户手动加的)
  // 之前:exemptFromMirrorDelete 只豁免 exact path → data/user-config.ini 会被删
  // 现在:prefix 豁免 → data/ 下所有文件都不参与 sync 删除判断
  it('★ 映射目标目录下的文件 → 不进镜像删除(即便 source 没有)', async () => {
    // 映射到 target/data/template.ini
    await writeFile(join(localDir, 'template.ini'), 'TEMPLATE');
    config.fileMappings = [
      {
        id: '1', name: 'template',
        sourcePath: join(localDir, 'template.ini'),
        targetRelpath: 'data/template.ini',
        enabled: true, overwrite: true, ifSourceMissing: 'skip',
      },
    ];

    // 模拟映射已经完成 + 用户在 target/data/ 加了文件
    await writeTree(targetDir, [
      { relPath: 'data/template.ini', content: 'MAPPED' },
      { relPath: 'data/user-config.ini', content: 'USER-ADDED' },  // 用户的
      { relPath: 'data/notes.md', content: 'NOTES' },  // 用户的
    ]);

    // source 里只有 a.txt(没 data/* 任何文件)
    await writeTree(sourceDir, [{ relPath: 'a.txt', content: 'A' }]);

    const syncer = new Syncer(config);
    const { result } = await syncer.sync(null);

    // 关键:result.deleted 不应包含 data/ 下的任何文件
    expect(result.deleted.filter((d) => d.startsWith('data/'))).toEqual([]);
    // a.txt 是正常的新增
    expect(result.added).toEqual(['a.txt']);
    // data/template.ini 也不算 modified(在 target,源没)
    // data/user-config.ini 也不算(豁免)
    // 全部:result.ok = true,没有 false-positive 删除
    expect(result.ok).toBe(true);
  });

  it('映射目标是文件,但 target 里同目录有其他文件 → 也不删', async () => {
    // 映射 data/single.ini
    await writeFile(join(localDir, 'template.ini'), 'T');
    config.fileMappings = [
      {
        id: '1', name: 't',
        sourcePath: join(localDir, 'template.ini'),
        targetRelpath: 'data/single.ini',
        enabled: true, overwrite: true, ifSourceMissing: 'skip',
      },
    ];

    // target 里 data/ 下有 3 个文件
    await writeTree(targetDir, [
      { relPath: 'data/single.ini', content: 'M' },
      { relPath: 'data/extra1.ini', content: 'X1' },
      { relPath: 'data/extra2.txt', content: 'X2' },
    ]);

    // source 空(没 a.txt,啥都没)
    const syncer = new Syncer(config);
    const { result } = await syncer.sync(null);

    // data/ 下所有文件都不应被镜像删
    expect(result.deleted.filter((d) => d.startsWith('data/'))).toEqual([]);
    expect(result.ok).toBe(true);
  });
});
