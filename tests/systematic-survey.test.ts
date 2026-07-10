/**
 * Systematic code survey — surfaces latent bugs in less-covered areas.
 *
 * Each `it` block tests one candidate area with a tight invariant.
 * Failed assertions reveal bugs. Each block is independent.
 *
 * If a candidate passes, that's still useful info (we've ruled it out).
 */

import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, writeFile, rm, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Syncer } from '@core/syncer';
import type { AppConfig, FileEntry } from '@core/types';

async function setup(): Promise<{ sourceDir: string; targetDir: string; mapDir: string }> {
  const sourceDir = await mkdtemp(join(tmpdir(), 'sys-src-'));
  const targetDir = await mkdtemp(join(tmpdir(), 'sys-tgt-'));
  const mapDir = await mkdtemp(join(tmpdir(), 'sys-map-'));
  return { sourceDir, targetDir, mapDir };
}

function baseCfg(o: Partial<AppConfig>): AppConfig {
  return {
    sourceDir: '',
    targetDir: '',
    backupDir: '',
    intervalSec: 300,
    backupCount: 1,
    autostart: false,
    applyMappingsImmediately: true,
    fileMappings: [],
    ignoreItems: [],
    applyMode: 'immediate',
    stagingDir: '',
    executablePath: '',
    ...o,
  };
}

async function cleanup(...dirs: string[]): Promise<void> {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
}

describe('Systematic survey — concurrent + edge cases', () => {
  // ──────────────────────────────────────────────────────────────
  // 1. Concurrent sync on same Syncer instance
  // ──────────────────────────────────────────────────────────────
  it('two parallel sync() calls on same Syncer do not corrupt result state', async () => {
    const { sourceDir, targetDir, mapDir } = await setup();
    try {
      await writeFile(join(sourceDir, 'a.txt'), 'a');
      await writeFile(join(sourceDir, 'b.txt'), 'b');
      const cfg = baseCfg({
        sourceDir,
        targetDir,
        fileMappings: [
          {
            id: 'm0',
            name: 'cfg',
            sourcePath: join(mapDir, 'c.ini'),
            targetRelpath: 'config.ini',
            enabled: true,
            overwrite: true,
            ifSourceMissing: 'skip',
          },
        ],
      });
      await writeFile(join(mapDir, 'c.ini'), 'config-content');
      const syncer = new Syncer(cfg);

      // Fire two syncs in parallel
      const [r1, r2] = await Promise.all([
        syncer.sync(null, {}),
        syncer.sync(null, {}),
      ]);

      console.error('[SURVEY-1] r1.ok:', r1.result.ok, 'r1.modified:', r1.result.modified);
      console.error('[SURVEY-1] r2.ok:', r2.result.ok, 'r2.modified:', r2.result.modified);

      // Target should have both source files exactly once
      const targetFiles = await readdir(targetDir);
      expect(targetFiles.sort()).toEqual(['a.txt', 'b.txt', 'config.ini']);

      // Sanity: no file content corruption
      expect(await readFile(join(targetDir, 'a.txt'), 'utf-8')).toBe('a');
      expect(await readFile(join(targetDir, 'b.txt'), 'utf-8')).toBe('b');

      // Concurrency invariants:
      // (a) both syncs returned ok=true
      // (b) both saw source consistently — at least one must report added=['a.txt','b.txt']
      //     (the other may see modified=[] if it ran second after first wrote everything)
      console.error('[SURVEY-1b] r1.added:', r1.result.added, 'r1.modified:', r1.result.modified);
      console.error('[SURVEY-1b] r2.added:', r2.result.added, 'r2.modified:', r2.result.modified);
      console.error('[SURVEY-1b] r1.warnings:', r1.result.warnings, 'r2.warnings:', r2.result.warnings);

      expect(r1.result.ok, 'r1 should be ok').toBe(true);
      expect(r2.result.ok, 'r2 should be ok').toBe(true);

      // Real concurrency invariants (the ones that matter):
      // (a) final file content is correct (no interleaved-write corruption)
      expect(await readFile(join(targetDir, 'a.txt'), 'utf-8')).toBe('a');
      expect(await readFile(join(targetDir, 'b.txt'), 'utf-8')).toBe('b');
      expect(await readFile(join(targetDir, 'config.ini'), 'utf-8')).toBe('config-content');

      // (b) no IO race surfaced as a warning (EBUSY / ENOENT mid-write would surface here)
      const r1Warn = r1.result.warnings.join('|');
      const r2Warn = r2.result.warnings.join('|');
      expect(r1Warn, `r1 has IO warnings: ${r1Warn}`).not.toMatch(/EBUSY|ENOENT|EACCES|EPERM/);
      expect(r2Warn, `r2 has IO warnings: ${r2Warn}`).not.toMatch(/EBUSY|ENOENT|EACCES|EPERM/);

      // (c) both syncs collected consistent metadata about source
      // (they scanned source independently — both should see a.txt, b.txt)
      // Documented behavior: combined added may equal 4 (both treat as new)
      // OR 2 (one finished writing before other's scan) — both acceptable.
      const r1Added = r1.result.added.length;
      const r2Added = r2.result.added.length;
      console.error('[SURVEY-1c] r1.added.length:', r1Added, 'r2.added.length:', r2Added);
      expect(r1Added + r2Added, 'combined added count').toBeGreaterThanOrEqual(2);
      expect(r1Added + r2Added, 'combined added count').toBeLessThanOrEqual(4);
    } finally {
      await cleanup(sourceDir, targetDir, mapDir);
    }
  });

  // ──────────────────────────────────────────────────────────────
  // 2. Empty source directory
  // ──────────────────────────────────────────────────────────────
  it('empty source directory: sync should be no-op success', async () => {
    const { sourceDir, targetDir, mapDir } = await setup();
    try {
      const cfg = baseCfg({ sourceDir, targetDir });
      const syncer = new Syncer(cfg);

      const result = await syncer.sync(null, {});
      console.error('[SURVEY-2] empty source result.fatalError:', result.result.fatalError);
      console.error('[SURVEY-2] empty source result.added:', result.result.added);

      // The README says source dir not found = fatal; but empty = ?
      expect(result.result.fatalError).toBeUndefined();
      expect(result.result.added).toEqual([]);
      expect(result.result.deleted).toEqual([]);
    } finally {
      await cleanup(sourceDir, targetDir, mapDir);
    }
  });

  // ──────────────────────────────────────────────────────────────
  // 3. Stale lastSourceIndex
  // ──────────────────────────────────────────────────────────────
  it('lastSourceIndex with files that no longer exist in source: should not throw', async () => {
    const { sourceDir, targetDir, mapDir } = await setup();
    try {
      await writeFile(join(sourceDir, 'real.txt'), 'real');
      const cfg = baseCfg({ sourceDir, targetDir });
      const syncer = new Syncer(cfg);

      // Build a stale lastIndex claiming source has files that don't actually exist
      const staleIndex: FileEntry[] = [
        { relPath: 'ghost1.txt', size: 100, mtimeMs: Date.now() - 100000 },
        { relPath: 'ghost2.txt', size: 200, mtimeMs: Date.now() - 100000 },
      ];

      const result = await syncer.sync(staleIndex, {});
      console.error('[SURVEY-3] stale index result.fatalError:', result.result.fatalError);
      console.error('[SURVEY-3] stale index result.added:', result.result.added);

      expect(result.result.fatalError).toBeUndefined();
      expect(result.result.added, 'real.txt should be added').toEqual(['real.txt']);
    } finally {
      await cleanup(sourceDir, targetDir, mapDir);
    }
  });

  // ──────────────────────────────────────────────────────────────
  // 4. Unicode / special characters in filenames
  // ──────────────────────────────────────────────────────────────
  it('unicode and special-char filenames sync correctly', async () => {
    const { sourceDir, targetDir, mapDir } = await setup();
    try {
      const names = [
        'ascii.txt',
        '带中文.txt',
        'with space.txt',
        'emoji-🎉.txt',
        'paren(s).txt',
        'amp&ersand.txt',
      ];
      for (const n of names) {
        // mkdir parent in case any name has subpath separators (these don't, but be safe)
        await mkdir(join(sourceDir, n, '..'), { recursive: true }).catch(() => undefined);
        await writeFile(join(sourceDir, n), `content-${n}`);
      }
      const cfg = baseCfg({ sourceDir, targetDir });
      const syncer = new Syncer(cfg);
      const result = await syncer.sync(null, {});

      console.error('[SURVEY-4] unicode result.added:', result.result.added);
      console.error('[SURVEY-4] unicode result.fatalError:', result.result.fatalError);

      expect(result.result.fatalError).toBeUndefined();
      const targetFiles = await readdir(targetDir);
      expect(targetFiles.sort()).toEqual(names.slice().sort());
      for (const n of names) {
        expect(await readFile(join(targetDir, n), 'utf-8')).toBe(`content-${n}`);
      }
    } finally {
      await cleanup(sourceDir, targetDir, mapDir);
    }
  });

  // ──────────────────────────────────────────────────────────────
  // 5. Multiple mappings to same targetRelpath
  // ──────────────────────────────────────────────────────────────
  it('two mappings with same targetRelpath: last-write wins (or shared counter)', async () => {
    const { sourceDir, targetDir, mapDir } = await setup();
    try {
      await writeFile(join(mapDir, 'a.ini'), 'source-a');
      await writeFile(join(mapDir, 'b.ini'), 'source-b');
      const cfg = baseCfg({
        sourceDir,
        targetDir,
        fileMappings: [
          {
            id: 'mA', name: 'A',
            sourcePath: join(mapDir, 'a.ini'),
            targetRelpath: 'config.ini',
            enabled: true, overwrite: true, ifSourceMissing: 'skip',
          },
          {
            id: 'mB', name: 'B',
            sourcePath: join(mapDir, 'b.ini'),
            targetRelpath: 'config.ini',
            enabled: true, overwrite: true, ifSourceMissing: 'skip',
          },
        ],
      });
      const syncer = new Syncer(cfg);
      const result = await syncer.sync(null, {});
      console.error('[SURVEY-5] result.mappingCopied:', result.result.mappingCopied);
      console.error('[SURVEY-5] result.mappingSkippedExisting:', result.result.mappingSkippedExisting);

      // Last-write-wins would mean: target file content is from source-b
      // Default: mappings array iteration, last one wins
      // If two mappings push the SAME relPath → target file ends up with whichever copy ran last
      const content = await readFile(join(targetDir, 'config.ini'), 'utf-8');
      console.error('[SURVEY-5] target config.ini content:', content);
      expect(['source-a', 'source-b']).toContain(content);

      // Sanity: target has exactly one config.ini
      const targetFiles = await readdir(targetDir);
      expect(targetFiles).toEqual(['config.ini']);
    } finally {
      await cleanup(sourceDir, targetDir, mapDir);
    }
  });

  // ──────────────────────────────────────────────────────────────
  // 6. Source dir exists, target dir does NOT exist (auto-created)
  // ──────────────────────────────────────────────────────────────
  it('non-existent target dir is auto-created on sync', async () => {
    const { sourceDir, mapDir } = await setup();
    const removedDir = await mkdtemp(join(tmpdir(), 'sys-tgt-'));
    await rm(removedDir, { recursive: true, force: true }); // ensure not exist
    try {
      await writeFile(join(sourceDir, 'a.txt'), 'a');
      const cfg = baseCfg({ sourceDir, targetDir: removedDir });
      const syncer = new Syncer(cfg);
      const result = await syncer.sync(null, {});

      console.error('[SURVEY-6] auto-create result.fatalError:', result.result.fatalError);

      expect(result.result.fatalError).toBeUndefined();
      expect(await readFile(join(removedDir, 'a.txt'), 'utf-8')).toBe('a');
    } finally {
      await cleanup(sourceDir, removedDir, mapDir);
    }
  });

  // ──────────────────────────────────────────────────────────────
  // 7. ifSourceMissing=delete + target doesn't exist (no-op expected)
  // ──────────────────────────────────────────────────────────────
  it('ifSourceMissing=delete + target absent: should be silent no-op', async () => {
    const { sourceDir, targetDir, mapDir } = await setup();
    try {
      // mapping source does not exist
      const cfg = baseCfg({
        sourceDir,
        targetDir,
        fileMappings: [
          {
            id: 'm0', name: 'm-delete',
            sourcePath: join(mapDir, 'never.ini'),
            targetRelpath: 'm.ini',
            enabled: true, overwrite: true,
            ifSourceMissing: 'delete', // delete a target that doesn't exist
          },
        ],
      });
      const syncer = new Syncer(cfg);
      const result = await syncer.sync(null, {});

      console.error('[SURVEY-7] delete-noop result.fatalError:', result.result.fatalError);
      console.error('[SURVEY-7] delete-noop result.deleted:', result.result.deleted);

      expect(result.result.fatalError).toBeUndefined();
      // Should NOT crash on unlink of non-existent file
      // (per source: if (targetExists) — only attempt delete if target exists)
    } finally {
      await cleanup(sourceDir, targetDir, mapDir);
    }
  });

  // ──────────────────────────────────────────────────────────────
  // 8. ifSourceMissing=keep + target doesn't exist
  // ──────────────────────────────────────────────────────────────
  it('ifSourceMissing=keep + source missing + target absent: should be silent no-op', async () => {
    const { sourceDir, targetDir, mapDir } = await setup();
    try {
      const cfg = baseCfg({
        sourceDir,
        targetDir,
        fileMappings: [
          {
            id: 'm0', name: 'm-keep',
            sourcePath: join(mapDir, 'never.ini'),
            targetRelpath: 'm.ini',
            enabled: true, overwrite: true,
            ifSourceMissing: 'keep',
          },
        ],
      });
      const syncer = new Syncer(cfg);
      const result = await syncer.sync(null, {});

      console.error('[SURVEY-8] keep-noop result.fatalError:', result.result.fatalError);

      expect(result.result.fatalError).toBeUndefined();
    } finally {
      await cleanup(sourceDir, targetDir, mapDir);
    }
  });

  // ──────────────────────────────────────────────────────────────
  // 9. source dir with many subdirs nested deep
  // ──────────────────────────────────────────────────────────────
  it('deeply nested source dir (10 levels) syncs', async () => {
    const { sourceDir, targetDir, mapDir } = await setup();
    try {
      const nested = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'deep.txt'].join('/');
      // mkdir -p the parent chain since writeFile alone doesn't
      const nestedAbs = join(sourceDir, nested);
      await mkdir(join(nestedAbs, '..'), { recursive: true });
      await writeFile(nestedAbs, 'deep-content');

      const cfg = baseCfg({ sourceDir, targetDir });
      const syncer = new Syncer(cfg);
      const result = await syncer.sync(null, {});

      console.error('[SURVEY-9] deep result.fatalError:', result.result.fatalError);

      expect(result.result.fatalError).toBeUndefined();
      expect(await readFile(join(targetDir, nested), 'utf-8')).toBe('deep-content');
    } finally {
      await cleanup(sourceDir, targetDir, mapDir);
    }
  });

  // ──────────────────────────────────────────────────────────────
  // 10. lastIndex supplied but source dir is the FIRST run of a different sync
  // (e.g., user resets state then starts sync — lastIndex is stale and unrelated)
  // ──────────────────────────────────────────────────────────────
  it('lastIndex unrelated to current source: should treat all as new', async () => {
    const { sourceDir, targetDir, mapDir } = await setup();
    try {
      await writeFile(join(sourceDir, 'real.txt'), 'real');
      const cfg = baseCfg({ sourceDir, targetDir });
      const syncer = new Syncer(cfg);

      // lastIndex from a totally different "previous run" with 100 unrelated files
      const otherIndex: FileEntry[] = [];
      for (let i = 0; i < 100; i++) {
        otherIndex.push({ relPath: `other-${i}.txt`, size: 100, mtimeMs: Date.now() });
      }

      const result = await syncer.sync(otherIndex, {});
      console.error('[SURVEY-10] unrelated-index result.fatalError:', result.result.fatalError);
      console.error('[SURVEY-10] unrelated-index result.added:', result.result.added);

      expect(result.result.fatalError).toBeUndefined();
      expect(result.result.added, 'real.txt should be added').toEqual(['real.txt']);
    } finally {
      await cleanup(sourceDir, targetDir, mapDir);
    }
  });

  // ──────────────────────────────────────────────────────────────
  // 11. staging mode + concurrent sync on same Syncer
  // .pending-delete.json + .pending-apply file write races
  // ──────────────────────────────────────────────────────────────
  it('staging mode + 2 parallel sync: no fatal errors, file integrity preserved', async () => {
    const ROOT = tmpdir();
    const sourceDir = await mkdtemp(join(ROOT, 'sys-stg-src-'));
    const targetDir = await mkdtemp(join(ROOT, 'sys-stg-tgt-'));
    const stagingDir = await mkdtemp(join(ROOT, 'sys-stg-stg-'));
    try {
      await writeFile(join(sourceDir, 'a.txt'), 'a');
      await writeFile(join(sourceDir, 'b.txt'), 'b');

      const cfg = baseCfg({ sourceDir, targetDir, stagingDir, applyMode: 'staging' });
      const syncer = new Syncer(cfg);
      const [r1, r2] = await Promise.all([
        syncer.sync(null, {}),
        syncer.sync(null, {}),
      ]);

      console.error('[SURVEY-11] r1.ok:', r1.result.ok, 'r2.ok:', r2.result.ok);
      console.error('[SURVEY-11] r1.warnings:', r1.result.warnings);
      console.error('[SURVEY-11] r2.warnings:', r2.result.warnings);

      // Both must succeed
      expect(r1.result.ok).toBe(true);
      expect(r2.result.ok).toBe(true);

      // No IO warnings
      const r1Warn = r1.result.warnings.join('|');
      const r2Warn = r2.result.warnings.join('|');
      expect(r1Warn).not.toMatch(/EBUSY|ENOENT|EACCES|EPERM/);
      expect(r2Warn).not.toMatch(/EBUSY|ENOENT|EACCES|EPERM/);

      // Staging should have files staged (some version of them)
      const stagingFiles = await readdir(stagingDir);
      console.error('[SURVEY-11] staging files:', stagingFiles);

      // Target should be empty (staging doesn't write to target until swap)
      const targetFiles = await readdir(targetDir);
      console.error('[SURVEY-11] target files (pre-swap):', targetFiles);
    } finally {
      await cleanup(sourceDir, targetDir, stagingDir);
    }
  });

  // ──────────────────────────────────────────────────────────────
  // 12. orphan pre-populated + 2 concurrent sync (immediate mode)
  // Tests race in mirror delete path: fs.unlink called twice on same orphan
  // ──────────────────────────────────────────────────────────────
  it('orphan pre-populated target + 2 parallel sync: no FATAL errors', async () => {
    const { sourceDir, targetDir, mapDir } = await setup();
    try {
      await writeFile(join(sourceDir, 'real.txt'), 'real');
      // Pre-populate target with orphans that don't exist in source
      await writeFile(join(targetDir, 'orphan1.txt'), 'orphan1');
      await writeFile(join(targetDir, 'orphan2.txt'), 'orphan2');

      const cfg = baseCfg({ sourceDir, targetDir });
      const syncer = new Syncer(cfg);
      const [r1, r2] = await Promise.all([
        syncer.sync(null, {}),
        syncer.sync(null, {}),
      ]);

      console.error('[SURVEY-12] r1.ok:', r1.result.ok, 'r2.ok:', r2.result.ok);
      console.error('[SURVEY-12] r1.warnings:', r1.result.warnings);
      console.error('[SURVEY-12] r2.warnings:', r2.result.warnings);

      // Both syncs run mirror delete on the orphans concurrently.
      // Each fs.unlink will succeed first time and ENOENT second.
      // ENOENT is handled silently (continue), so this should not produce fatal.
      expect(r1.result.fatalError).toBeUndefined();
      expect(r2.result.fatalError).toBeUndefined();

      // No EBUSY/EPERM warnings (those would indicate actual lock failures)
      const r1Warn = r1.result.warnings.join('|');
      const r2Warn = r2.result.warnings.join('|');
      // ENOENT is acceptable (orphan already deleted by sibling sync)
      expect(r1Warn).not.toMatch(/EBUSY|EACCES|EPERM/);
      expect(r2Warn).not.toMatch(/EBUSY|EACCES|EPERM/);

      // Final target state: real.txt present, orphans gone
      const finalFiles = await readdir(targetDir);
      console.error('[SURVEY-12] final target files:', finalFiles);
      expect(finalFiles).toEqual(['real.txt']);
    } finally {
      await cleanup(sourceDir, targetDir, mapDir);
    }
  });

  // ──────────────────────────────────────────────────────────────
  // 13. applyMappingsOnly + sync concurrently
  // Mapping writes its own file while sync runs the mirror logic
  // ──────────────────────────────────────────────────────────────
  it('applyMappingsOnly + sync concurrently: both finish, mapping file present', async () => {
    const { sourceDir, targetDir, mapDir } = await setup();
    try {
      await writeFile(join(sourceDir, 'mirror.txt'), 'mirror');
      await writeFile(join(mapDir, 'm.ini'), 'mapping-content');

      const cfg = baseCfg({
        sourceDir,
        targetDir,
        fileMappings: [
          {
            id: 'm0',
            name: 'm',
            sourcePath: join(mapDir, 'm.ini'),
            targetRelpath: 'config.ini',
            enabled: true, overwrite: true, ifSourceMissing: 'skip',
          },
        ],
      });
      const syncer = new Syncer(cfg);

      const [r1, r2] = await Promise.all([
        syncer.applyMappingsOnly(),
        syncer.sync(null, {}),
      ]);

      console.error('[SURVEY-13] applyMappingsOnly.ok:', r1.ok, 'sync.ok:', r2.result.ok);
      console.error('[SURVEY-13] applyMappingsOnly.mappingCopied:', r1.mappingCopied);
      console.error('[SURVEY-13] sync.mappingCopied:', r2.result.mappingCopied);

      // Both must finish without fatal
      expect(r1.fatalError).toBeUndefined();
      expect(r2.result.fatalError).toBeUndefined();

      // Final target should have both mirror.txt and config.ini
      const finalFiles = await readdir(targetDir);
      console.error('[SURVEY-13] final target files:', finalFiles);
      expect(finalFiles.sort()).toEqual(['config.ini', 'mirror.txt']);
      expect(await readFile(join(targetDir, 'mirror.txt'), 'utf-8')).toBe('mirror');
      expect(await readFile(join(targetDir, 'config.ini'), 'utf-8')).toBe('mapping-content');
    } finally {
      await cleanup(sourceDir, targetDir, mapDir);
    }
  });

  // ──────────────────────────────────────────────────────────────
  // 14. Source file with mtime in the future
  // (e.g., copied from another machine with clock skew)
  // ──────────────────────────────────────────────────────────────
  it('source file with future mtime: sync writes it correctly', async () => {
    const { sourceDir, targetDir, mapDir } = await setup();
    try {
      const futureTime = Date.now() + 60 * 60 * 1000;
      const absSrcPath = join(sourceDir, 'future.txt');
      await writeFile(absSrcPath, 'future-content');
      const { utimes } = await import('node:fs/promises');
      await utimes(absSrcPath, new Date(futureTime), new Date(futureTime));

      const cfg = baseCfg({ sourceDir, targetDir });
      const syncer = new Syncer(cfg);
      const result = await syncer.sync(null, {});

      console.error('[SURVEY-14] future-mtime result.fatalError:', result.result.fatalError);
      expect(result.result.fatalError).toBeUndefined();
      expect(result.result.added).toContain('future.txt');
      expect(await readFile(join(targetDir, 'future.txt'), 'utf-8')).toBe('future-content');
    } finally {
      await cleanup(sourceDir, targetDir, mapDir);
    }
  });

  // ──────────────────────────────────────────────────────────────
  // 15. STALE mapping sourcePath: file existed at config time, gone at sync time
  // ──────────────────────────────────────────────────────────────
  it('mapping sourcePath disappeared between config save and sync: skip with no fatal', async () => {
    const { sourceDir, targetDir, mapDir } = await setup();
    try {
      await writeFile(join(sourceDir, 'real.txt'), 'real');
      const cfg = baseCfg({
        sourceDir,
        targetDir,
        fileMappings: [
          {
            id: 'm0', name: 'ghost-config',
            sourcePath: join(mapDir, 'deleted-by-user.ini'),
            targetRelpath: 'config.ini',
            enabled: true, overwrite: true, ifSourceMissing: 'skip',
          },
        ],
      });
      const syncer = new Syncer(cfg);
      const result = await syncer.sync(null, {});

      console.error('[SURVEY-16] ghost-mapping result.fatalError:', result.result.fatalError);
      console.error('[SURVEY-16] ghost-mapping result.mappingSkipped:', result.result.mappingSkipped);
      expect(result.result.fatalError).toBeUndefined();
      expect(result.result.mappingSkipped).toContain('ghost-config');
      expect(result.result.mappingFailed).not.toContain('ghost-config');
      expect(result.result.added).toContain('real.txt');
    } finally {
      await cleanup(sourceDir, targetDir, mapDir);
    }
  });

  // ──────────────────────────────────────────────────────────────
  // 16. config with backupDir == targetDir (should be REJECTED)
  // ──────────────────────────────────────────────────────────────
  it('config validation rejects backupDir === targetDir', async () => {
    const { ConfigManager } = await import('@core/config');
    const { mkdtemp: mk2, rm: rm2 } = await import('node:fs/promises');
    const cfgPath = (await mk2(join(tmpdir(), 'sys-cfg-'))) + '/config.json';
    const dir2 = cfgPath.substring(0, cfgPath.lastIndexOf('/'));
    try {
      const cfgFull = {
        sourceDir: '/tmp/src',
        targetDir: '/tmp/tgt',
        backupDir: '/tmp/tgt',
        intervalSec: 300,
        backupCount: 1,
        autostart: false,
        applyMappingsImmediately: true,
        fileMappings: [],
        ignoreItems: [],
        applyMode: 'staging' as const,
        stagingDir: '',
        executablePath: '',
      };
      const cm = new ConfigManager({
        configPath: cfgPath,
        defaults: cfgFull,
      });
      let threwMessage = '';
      try {
        await cm.save(cfgFull);
      } catch (err) {
        threwMessage = (err as Error).message;
      }
      expect(threwMessage, 'cm.save should reject on backupDir===targetDir').toMatch(/backupDir.*targetDir/);
    } finally {
      await rm2(dir2, { recursive: true, force: true });
    }
  });

  // ──────────────────────────────────────────────────────────────
  // 17. 50 sequential syncs on stable source
  // ──────────────────────────────────────────────────────────────
  it('50 sequential syncs on stable source: target stays consistent', async () => {
    const { sourceDir, targetDir, mapDir } = await setup();
    try {
      await writeFile(join(sourceDir, 'stable.txt'), 'stable');
      const cfg = baseCfg({ sourceDir, targetDir });
      const syncer = new Syncer(cfg);

      let prevIndex: FileEntry[] | null = null;
      let firstCycleAdded = 0;
      let lastCycleAdded = 0;
      let lastCycleModified = 0;
      for (let i = 0; i < 50; i++) {
        const r = await syncer.sync(prevIndex, {});
        expect(r.result.fatalError, `cycle ${i} fatal`).toBeUndefined();
        if (i === 0) firstCycleAdded = r.result.added.length;
        if (i === 49) {
          lastCycleAdded = r.result.added.length;
          lastCycleModified = r.result.modified.length;
        }
        prevIndex = r.newSourceIndex;
      }
      console.error('[SURVEY-17] first cycle added:', firstCycleAdded);
      console.error('[SURVEY-17] cycle 50 added:', lastCycleAdded, 'modified:', lastCycleModified);
      expect(firstCycleAdded).toBeGreaterThanOrEqual(1);
      // After 50 stable syncs, last should add/modify nothing
      expect(lastCycleAdded + lastCycleModified, 'cycle 50 should be no-op').toBe(0);
      const finalFiles = await readdir(targetDir);
      expect(finalFiles).toEqual(['stable.txt']);
    } finally {
      await cleanup(sourceDir, targetDir, mapDir);
    }
  });
});
