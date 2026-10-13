import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Syncer } from '../src/core/syncer';
import type { AppConfig, FileEntry } from '../src/core/types';

describe('Syncer - Bidirectional Sync', () => {
  let sourceDir: string;
  let targetDir: string;
  let backupDir: string;

  beforeEach(async () => {
    const runId = Math.random().toString(36).slice(2, 8);
    sourceDir = join(tmpdir(), `test-bidi-src-${runId}`);
    targetDir = join(tmpdir(), `test-bidi-tgt-${runId}`);
    backupDir = join(tmpdir(), `test-bidi-bak-${runId}`);

    await fs.mkdir(sourceDir, { recursive: true });
    await fs.mkdir(targetDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(sourceDir, { recursive: true, force: true }).catch(() => undefined);
    await fs.rm(targetDir, { recursive: true, force: true }).catch(() => undefined);
    await fs.rm(backupDir, { recursive: true, force: true }).catch(() => undefined);
  });

  function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
    return {
      sourceDir,
      targetDir,
      backupDir,
      intervalSec: 300,
      backupCount: 3,
      autostart: false,
      fileMappings: [],
      ignoreItems: [],
      applyMode: 'immediate',
      stagingDir: '',
      executablePath: '',
      syncMode: 'bidirectional',
      conflictPolicy: 'rename-target',
      ...overrides,
    };
  }

  it('propagates source additions to target', async () => {
    await fs.writeFile(join(sourceDir, 'file1.txt'), 'hello from source');

    const syncer = new Syncer(makeConfig());
    const { result } = await syncer.sync(null);

    expect(result.ok).toBe(true);
    expect(result.added).toContain('file1.txt');

    const targetContent = await fs.readFile(join(targetDir, 'file1.txt'), 'utf-8');
    expect(targetContent).toBe('hello from source');
  });

  it('propagates target additions back to source', async () => {
    await fs.writeFile(join(sourceDir, 'base.txt'), 'common');
    await fs.writeFile(join(targetDir, 'base.txt'), 'common');
    const baseStat = await fs.stat(join(sourceDir, 'base.txt'));
    const baseIndex: FileEntry[] = [
      { relPath: 'base.txt', size: baseStat.size, mtimeMs: baseStat.mtimeMs },
    ];

    await fs.writeFile(join(targetDir, 'local-new.txt'), 'created locally on target');

    const syncer = new Syncer(makeConfig());
    const { result } = await syncer.sync(baseIndex);

    expect(result.ok).toBe(true);
    expect(result.pushedToSource).toContain('local-new.txt');

    const sourceContent = await fs.readFile(join(sourceDir, 'local-new.txt'), 'utf-8');
    expect(sourceContent).toBe('created locally on target');
  });

  it('propagates target modifications back to source', async () => {
    await fs.writeFile(join(sourceDir, 'doc.txt'), 'version 1');
    await fs.writeFile(join(targetDir, 'doc.txt'), 'version 1');
    const stat1 = await fs.stat(join(sourceDir, 'doc.txt'));
    const baseIndex: FileEntry[] = [
      { relPath: 'doc.txt', size: stat1.size, mtimeMs: stat1.mtimeMs },
    ];

    await fs.writeFile(join(targetDir, 'doc.txt'), 'version 2 updated locally');

    const syncer = new Syncer(makeConfig());
    const { result } = await syncer.sync(baseIndex);

    expect(result.ok).toBe(true);
    expect(result.pushedToSource).toContain('doc.txt');

    const sourceContent = await fs.readFile(join(sourceDir, 'doc.txt'), 'utf-8');
    expect(sourceContent).toBe('version 2 updated locally');
  });

  it('handles conflicts gracefully with rename-target policy', async () => {
    await fs.writeFile(join(sourceDir, 'data.json'), '{"v": 1}');
    await fs.writeFile(join(targetDir, 'data.json'), '{"v": 1}');
    const stat1 = await fs.stat(join(sourceDir, 'data.json'));
    const baseIndex: FileEntry[] = [
      { relPath: 'data.json', size: stat1.size, mtimeMs: stat1.mtimeMs },
    ];

    await fs.writeFile(join(sourceDir, 'data.json'), '{"v": 2, "side": "source"}');
    await fs.writeFile(join(targetDir, 'data.json'), '{"v": 3, "modified_locally_on_target": true}');

    const syncer = new Syncer(makeConfig({ conflictPolicy: 'rename-target' }));
    const { result } = await syncer.sync(baseIndex);

    expect(result.ok).toBe(true);
    expect(result.conflicts).toContain('data.json');

    const targetMain = await fs.readFile(join(targetDir, 'data.json'), 'utf-8');
    expect(targetMain).toBe('{"v": 2, "side": "source"}');

    const targetFiles = await fs.readdir(targetDir);
    const conflictFile = targetFiles.find((f) => f.includes('data.conflict-tgt-'));
    expect(conflictFile).toBeDefined();

    const conflictContent = await fs.readFile(join(targetDir, conflictFile!), 'utf-8');
    expect(conflictContent).toBe('{"v": 3, "modified_locally_on_target": true}');
  });

  it('respects ignoreItems in bidirectional mode (never copied or pushed back)', async () => {
    // 准备被忽略的文件
    await fs.writeFile(join(sourceDir, 'source-ignored.log'), 'source log');
    await fs.writeFile(join(targetDir, 'target-ignored.log'), 'target log');
    await fs.writeFile(join(sourceDir, 'normal.txt'), 'normal content');

    const syncer = new Syncer(makeConfig({
      ignoreItems: ['*.log', 'target-ignored.log', 'source-ignored.log'],
    }));
    const { result } = await syncer.sync(null);

    expect(result.ok).toBe(true);
    // normal.txt 应同步
    expect(result.added).toContain('normal.txt');

    // 排除项绝不应被拷贝到对端, 也不应被记录在 pushedToSource
    const targetFiles = await fs.readdir(targetDir);
    expect(targetFiles).not.toContain('source-ignored.log');

    const sourceFiles = await fs.readdir(sourceDir);
    expect(sourceFiles).not.toContain('target-ignored.log');
    expect(result.pushedToSource ?? []).not.toContain('target-ignored.log');
  });

  it('respects fileMappings exemptions in bidirectional mode (mappings never pushed back to source)', async () => {
    const mapDir = join(tmpdir(), `test-map-src-${Math.random().toString(36).slice(2, 8)}`);
    await fs.mkdir(mapDir, { recursive: true });
    await fs.writeFile(join(mapDir, 'user-custom.ini'), 'local custom user config');

    const syncer = new Syncer(makeConfig({
      fileMappings: [
        {
          id: 'map-1',
          name: '本地配置文件',
          sourcePath: join(mapDir, 'user-custom.ini'),
          targetRelpath: 'config/user-custom.ini',
          enabled: true,
          overwrite: false,
          ifSourceMissing: 'skip',
        },
      ],
    }));

    const { result } = await syncer.sync(null);
    expect(result.ok).toBe(true);
    expect(result.mappingCopied).toContain('本地配置文件');

    // 第二轮同步: 映射文件已在目标端, 绝不应被双向同步反向推送到源端
    const { result: round2 } = await syncer.sync(null);
    expect(round2.ok).toBe(true);
    expect(round2.pushedToSource ?? []).not.toContain('config/user-custom.ini');

    const sourceFiles = await fs.readdir(sourceDir);
    expect(sourceFiles).not.toContain('config');

    await fs.rm(mapDir, { recursive: true, force: true }).catch(() => undefined);
  });

  it('works with staging mode in bidirectional sync', async () => {
    const stagingDir = join(tmpdir(), `test-bidi-stg-${Math.random().toString(36).slice(2, 8)}`);
    await fs.writeFile(join(sourceDir, 'app.bin'), 'binary v1');

    const syncer = new Syncer(makeConfig({
      applyMode: 'staging',
      stagingDir,
    }));

    const { result } = await syncer.sync(null);
    expect(result.ok).toBe(true);
    expect(result.pendingApplyCount).toBe(1);

    // stagingDir 下应生成 .pending-apply 和暂存文件
    const stgFiles = await fs.readdir(stagingDir);
    expect(stgFiles).toContain('app.bin');
    expect(stgFiles).toContain('.pending-apply');

    await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
  });
});
