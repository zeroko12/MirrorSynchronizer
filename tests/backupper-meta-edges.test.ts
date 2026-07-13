/**
 * Backupper audit: readMeta/rollback behavior on malformed .meta.json
 *
 * Goal: verify no silent-coercion footgun in the backupper surface.
 *   - .meta.json ignored if corrupted
 *   - readMeta returns null
 *   - rollback still functional via fallbackIgnoreItems
 *   - if ignoreItems is non-array (string, null, etc.), code does not crash
 *     silently with bad data
 */

import { describe, expect, it } from 'vitest';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Backupper } from '@core/backupper';

describe('Backupper.readMeta: malformed .meta.json surfaces gracefully', () => {
  it('readMeta returns null when .meta.json is corrupt (truncated JSON)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bup-meta-'));
    const snap = join(dir, 'snap');
    await mkdir(snap, { recursive: true });
    try {
      await writeFile(join(snap, '.meta.json'), '{ truncated json');
      const bu = new Backupper();
      const meta = await bu.readMeta(snap);
      expect(meta).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('readMeta returns null when .meta.json missing entirely', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bup-meta-'));
    try {
      const bu = new Backupper();
      const meta = await bu.readMeta(join(dir, 'no-snap'));
      expect(meta).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('readMeta returns null when .meta.json is valid JSON but wrong shape', async () => {
    // JSON parses to a non-object (array)
    const dir = await mkdtemp(join(tmpdir(), 'bup-meta-'));
    const snap = join(dir, 'snap');
    await mkdir(snap, { recursive: true });
    try {
      await writeFile(join(snap, '.meta.json'), '["not", "an", "object"]');
      const bu = new Backupper();
      const meta = await bu.readMeta(snap);
      // The cast `as SnapshotMeta` lies, but `.targetDir` and `.ignoreItems` on an array
      // would return undefined — which would then propagate. The current code does NOT
      // validate the parsed shape. Document observed behavior: returns the array as-is,
      // type assertion is a lie but doesn't crash.
      console.error('[BUP] meta when .meta.json is array:', meta);
      // Either: validated (returns null) OR tolerated (returns array) — both acceptable
      // as long as it doesn't crash downstream.
      // Currently it tolerates — meta is the array. Document and assert shape.
      expect(meta).not.toBeNull(); // current code: tolerated
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('Backupper.rollback: meta.ignoreItems is non-array — does it crash?', () => {
  it('rollback with .meta.json containing ignoreItems as a string: gracefully uses fallback or empty', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bup-rb-'));
    const snap = join(dir, 'snap');
    const target = join(dir, 'target');
    await mkdir(snap, { recursive: true });
    await mkdir(target, { recursive: true });
    try {
      // Snapshot has one file "kept.txt"
      await writeFile(join(snap, 'kept.txt'), 'kept-from-snap');

      // Target has different file "extra.txt"
      await writeFile(join(target, 'extra.txt'), 'extra-in-target');

      // .meta.json with ignoreItems as STRING (simulates old-version or hand-edit)
      await writeFile(join(snap, '.meta.json'), JSON.stringify({
        createdAt: Date.now(),
        ignoreItems: 'this-is-a-string-not-an-array',
        targetDir: 'C:/some/path',
      }));

      const bu = new Backupper();
      // Document behavior: current code casts `as SnapshotMeta`, but ??  fallback
      // does NOT kick in (string is not nullish). Then `isInIgnoredItem(rel, 'a-string')`
      // iterates chars of string — won't match anything. So this should be benign in
      // practice, but the type assertion is a lie.
      //
      // If it throws, that's a real bug. We assert: does NOT throw.
      let threw = false;
      try {
        await bu.rollback(snap, target);
      } catch (err) {
        threw = true;
        console.error('[BUP] rollback threw:', (err as Error).message);
      }
      expect(threw, 'rollback must not throw on malformed meta.ignoreItems').toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rollback with .meta.json missing ignoreItems: uses fallbackIgnoreItems to preserve target user-private content', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bup-rb-'));
    const snap = join(dir, 'snap');
    const target = join(dir, 'target');
    await mkdir(snap, { recursive: true });
    await mkdir(target, { recursive: true });
    try {
      // Snap has 'kept.txt' (will be restored)
      await writeFile(join(snap, 'kept.txt'), 'kept-from-snap');
      // Target has stale 'kept.txt' (will be overwritten) + user-private 'private.log'
      // (must NOT be deleted even though it's not in snap — it's a user-owned file
      //  that the rollback should leave alone because fallbackIgnoreItems protects it)
      await writeFile(join(target, 'kept.txt'), 'old-kept');
      await writeFile(join(target, 'private.log'), 'user-private');

      // .meta.json WITHOUT ignoreItems (older format)
      await writeFile(join(snap, '.meta.json'), JSON.stringify({
        createdAt: Date.now(),
        targetDir: 'C:/old/path',
      }));

      const bu = new Backupper();
      await bu.rollback(snap, target, { fallbackIgnoreItems: ['private.log'] });

      const { readFile: rf } = await import('node:fs/promises');
      const keptContent = await rf(join(target, 'kept.txt'), 'utf-8').catch(() => null);
      const privateContent = await rf(join(target, 'private.log'), 'utf-8').catch(() => null);

      // Documented semantic per backupper.ts:200-247:
      //   - snap 有 + 不在 ignoreItems → 拷到 target    → kept.txt restored with snap content
      //   - target 有 + 在 ignoreItems → 保留(不删!)     → private.log preserved
      //   - target 有 + 不在 ignoreItems + snap 没 → 删
      expect(keptContent, 'kept.txt restored from snap').toBe('kept-from-snap');
      expect(privateContent, 'private.log preserved via fallbackIgnoreItems').toBe('user-private');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('Backupper.createSnapshot: ignoreItems with sub-paths', () => {
  it('createSnapshot with ignoreItems containing nested path — that subtree is skipped', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bup-create-'));
    const target = join(dir, 'target');
    const backupDir = join(dir, 'backups');
    await mkdir(target, { recursive: true });
    await mkdir(join(target, 'cache'), { recursive: true });
    await mkdir(join(target, 'logs'), { recursive: true });
    try {
      await writeFile(join(target, 'data.bin'), 'data');
      await writeFile(join(target, 'cache', 'temp.tmp'), 'cache');
      await writeFile(join(target, 'logs', 'app.log'), 'log');

      const bu = new Backupper();
      const snap = await bu.createSnapshot(target, backupDir, {
        ignoreItems: ['cache'],
      });

      expect(snap.fileCount).toBe(2); // data.bin + logs/app.log, NOT cache/temp.tmp

      const { readdir } = await import('node:fs/promises');
      const snapFiles = await readdir(join(snap.path), { recursive: true });
      // cache directory pruned → not in snapshot
      const hasCache = snapFiles.some((f) => f.includes('cache'));
      expect(hasCache, 'cache subtree should be pruned from snapshot').toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});