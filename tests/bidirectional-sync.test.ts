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
    // 建立一个共同基准
    await fs.writeFile(join(sourceDir, 'base.txt'), 'common');
    await fs.writeFile(join(targetDir, 'base.txt'), 'common');
    const baseStat = await fs.stat(join(sourceDir, 'base.txt'));
    const baseIndex: FileEntry[] = [
      { relPath: 'base.txt', size: baseStat.size, mtimeMs: baseStat.mtimeMs },
    ];

    // 在目标端新增一个本地文件
    await fs.writeFile(join(targetDir, 'local-new.txt'), 'created locally on target');

    const syncer = new Syncer(makeConfig());
    const { result } = await syncer.sync(baseIndex);

    expect(result.ok).toBe(true);
    expect(result.pushedToSource).toContain('local-new.txt');

    // 验证源端已被反向写入
    const sourceContent = await fs.readFile(join(sourceDir, 'local-new.txt'), 'utf-8');
    expect(sourceContent).toBe('created locally on target');
  });

  it('propagates target modifications back to source', async () => {
    // 共同基准文件
    await fs.writeFile(join(sourceDir, 'doc.txt'), 'version 1');
    await fs.writeFile(join(targetDir, 'doc.txt'), 'version 1');
    const stat1 = await fs.stat(join(sourceDir, 'doc.txt'));
    const baseIndex: FileEntry[] = [
      { relPath: 'doc.txt', size: stat1.size, mtimeMs: stat1.mtimeMs },
    ];

    // 修改目标端文件 (让 mtime 和 size 都不同)
    await fs.writeFile(join(targetDir, 'doc.txt'), 'version 2 updated locally');

    const syncer = new Syncer(makeConfig());
    const { result } = await syncer.sync(baseIndex);

    expect(result.ok).toBe(true);
    expect(result.pushedToSource).toContain('doc.txt');

    const sourceContent = await fs.readFile(join(sourceDir, 'doc.txt'), 'utf-8');
    expect(sourceContent).toBe('version 2 updated locally');
  });

  it('handles conflicts gracefully with rename-target policy', async () => {
    // 共同基准
    await fs.writeFile(join(sourceDir, 'data.json'), '{"v": 1}');
    await fs.writeFile(join(targetDir, 'data.json'), '{"v": 1}');
    const stat1 = await fs.stat(join(sourceDir, 'data.json'));
    const baseIndex: FileEntry[] = [
      { relPath: 'data.json', size: stat1.size, mtimeMs: stat1.mtimeMs },
    ];

    // 双端同时修改
    await fs.writeFile(join(sourceDir, 'data.json'), '{"v": 2, "side": "source"}');
    await fs.writeFile(join(targetDir, 'data.json'), '{"v": 3, "modified_locally_on_target": true}');

    const syncer = new Syncer(makeConfig({ conflictPolicy: 'rename-target' }));
    const { result } = await syncer.sync(baseIndex);

    expect(result.ok).toBe(true);
    expect(result.conflicts).toContain('data.json');

    // 目标端当前应该持有源端最新版本
    const targetMain = await fs.readFile(join(targetDir, 'data.json'), 'utf-8');
    expect(targetMain).toBe('{"v": 2, "side": "source"}');

    // 并且目标端保留了冲突副本
    const targetFiles = await fs.readdir(targetDir);
    const conflictFile = targetFiles.find((f) => f.includes('data.conflict-tgt-'));
    expect(conflictFile).toBeDefined();

    const conflictContent = await fs.readFile(join(targetDir, conflictFile!), 'utf-8');
    expect(conflictContent).toBe('{"v": 3, "modified_locally_on_target": true}');
  });

  it('defaults to mirror mode and leaves target changes alone if mirror mode configured', async () => {
    await fs.writeFile(join(sourceDir, 'server.txt'), 'server only');
    await fs.writeFile(join(targetDir, 'orphan.txt'), 'orphan on target');

    const syncer = new Syncer(makeConfig({ syncMode: 'mirror' }));
    const { result } = await syncer.sync(null);

    expect(result.ok).toBe(true);
    // 镜像模式下孤儿会被删除
    expect(result.deleted).toContain('orphan.txt');
    expect(result.pushedToSource ?? []).toHaveLength(0);
  });
});
