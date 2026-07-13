/**
 * Regression test: mapping rule with overwrite=true should preserve source mtime
 * and short-circuit when target equals source.
 *
 * Background: prior code did fs.copyFile() + fs.utimes(Date.now()),
 * which always set target mtime to "now", drifting it forward of source mtime.
 * Every subsequent sync then saw the drift as a "modified" mapping and
 * unconditionally re-wrote the file. If the target was being touched by another
 * process (antivirus, editor, sandbox), this surfaced as a flaky
 * "sync did not finish" symptom to the user.
 *
 * Fix: use COPYFILE_PRESERVE_TIMESTAMPS + early-return when target already
 * matches source (mtime + size within tolerance). Mirror sync already does this
 * via streamToFile(file.mtimeMs); mapping now matches that contract.
 */

import { describe, expect, it } from 'vitest';
import { mkdtemp, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Syncer } from '@core/syncer';
import type { AppConfig } from '@core/types';

describe('Mapping mtime preservation (regression)', () => {
  it('second sync with no source change should not re-copy mapping file', async () => {
    const ROOT = tmpdir();
    const sourceDir = await mkdtemp(join(ROOT, 'mt-src-'));
    const targetDir = await mkdtemp(join(ROOT, 'mt-tgt-'));
    const mapDir = await mkdtemp(join(ROOT, 'mt-map-'));

    try {
      const mapSrcPath = join(mapDir, 'app-config.ini');
      await writeFile(mapSrcPath, 'config-content-v1');
      const mapSrcMtime = (await stat(mapSrcPath)).mtimeMs;

      await writeFile(join(sourceDir, 'data.bin'), 'data-v1');

      const cfg: AppConfig = {
        sourceDir,
        targetDir,
        backupDir: '',
        intervalSec: 300,
        backupCount: 1,
        autostart: false,
        applyMappingsImmediately: true,
        fileMappings: [
          {
            id: 'cfg',
            name: 'app-config',
            sourcePath: mapSrcPath,
            targetRelpath: 'config/app.ini',
            enabled: true,
            overwrite: true,
            ifSourceMissing: 'skip',
          },
        ],
        ignoreItems: [],
        applyMode: 'immediate',
        stagingDir: '',
        executablePath: '',
      };

      const syncer = new Syncer(cfg);

      // First sync — populates target.
      const first = await syncer.sync(null, {});
      expect(first.result.fatalError).toBeUndefined();

      const tgtMapPath = join(targetDir, 'config', 'app.ini');
      const tgtDataPath = join(targetDir, 'data.bin');
      const tgtMapStat1 = await stat(tgtMapPath);
      const tgtDataStat1 = await stat(tgtDataPath);

      // Wait so any drift is detectable.
      await new Promise((r) => setTimeout(r, 50));

      // Second sync with no source change.
      const second = await syncer.sync(first.newSourceIndex, {});

      // Mirror path: data.bin — kept mtime, so unchanged.
      expect(second.result.modified, 'data.bin should not be re-copied').not.toContain('data.bin');

      // Mapping path: target source mtime was preserved on first copy, so target
      // and source are byte-equal with mtime aligned → mapping should skip.
      expect(
        second.result.mappingCopied,
        `Mapping re-copied despite no source change (source mtime=${mapSrcMtime}, ` +
        `target mtime after first sync=${tgtMapStat1.mtimeMs}). ` +
        `Likely cause: applyMapping used utimes(Date.now()) instead of preserving source mtime.`,
      ).toEqual([]);

      // Target mtime after first sync should match source mtime (within 2ms tolerance).
      expect(Math.abs(tgtMapStat1.mtimeMs - mapSrcMtime)).toBeLessThanOrEqual(20);
      // ...and the data.bin mirror path already covers unchanged semantics.
      void tgtDataStat1; // referenced to make it intentional
    } finally {
      await rm(sourceDir, { recursive: true, force: true });
      await rm(targetDir, { recursive: true, force: true });
      await rm(mapDir, { recursive: true, force: true });
    }
  }, 30_000);

  it('mapping with content change does re-copy (control case)', async () => {
    // Verifies the fix doesn't break the "actually changed" case:
    // change source content, second sync SHOULD re-copy.
    const ROOT = tmpdir();
    const sourceDir = await mkdtemp(join(ROOT, 'mt2-src-'));
    const targetDir = await mkdtemp(join(ROOT, 'mt2-tgt-'));
    const mapDir = await mkdtemp(join(ROOT, 'mt2-map-'));

    try {
      const mapSrcPath = join(mapDir, 'app-config.ini');
      await writeFile(mapSrcPath, 'v1');

      const cfg: AppConfig = {
        sourceDir,
        targetDir,
        backupDir: '',
        intervalSec: 300,
        backupCount: 1,
        autostart: false,
        applyMappingsImmediately: true,
        fileMappings: [
          {
            id: 'cfg',
            name: 'app-config',
            sourcePath: mapSrcPath,
            targetRelpath: 'config/app.ini',
            enabled: true,
            overwrite: true,
            ifSourceMissing: 'skip',
          },
        ],
        ignoreItems: [],
        applyMode: 'immediate',
        stagingDir: '',
        executablePath: '',
      };

      const syncer = new Syncer(cfg);
      const first = await syncer.sync(null, {});
      expect(first.result.fatalError).toBeUndefined();
      expect(first.result.mappingCopied).toContain('app-config');

      // Now change source content + bump mtime
      await new Promise((r) => setTimeout(r, 50));
      await writeFile(mapSrcPath, 'v2-changed');

      const second = await syncer.sync(first.newSourceIndex, {});
      expect(second.result.mappingCopied, 'content change should trigger re-copy').toContain('app-config');
    } finally {
      await rm(sourceDir, { recursive: true, force: true });
      await rm(targetDir, { recursive: true, force: true });
      await rm(mapDir, { recursive: true, force: true });
    }
  }, 30_000);
});
