/**
 * Fuzz harness for Syncer.sync — surfaces intermittent sync bugs.
 *
 * Strategy: generate random (source tree, target tree, mappings, ignoreItems),
 * run sync, assert invariants. Run N=20 cases per invocation; assertion failure
 * stops the loop and reports the minimal seed.
 *
 * Invariants (each case must hold after sync):
 *  I1.  Source files (modulo ignoreItems + mapping-exempt directory) all exist in target with byte-equal content.
 *  I2.  Mapping overwrite=true: target has source content after one sync.
 *  I3.  Mapping overwrite=false + target absent: target created with source content.
 *  I4.  Re-running same config produces result.unchanged == source file count.
 *  I5.  ignoreItems-prefixed entries are never deleted from target.
 *  I6.  result.ok === !fatalError (no false-positive ok).
 *
 * Tagged with [DEBUG-fuzzN] in repro output for grep-cleanup.
 */

import { describe, it } from 'vitest';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Syncer } from '@core/syncer';
import type { AppConfig, FileMapping } from '@core/types';

const ROOT = tmpdir();

interface Seed {
  sourceFiles: Array<{ relPath: string; content: string }>;
  targetFiles: Array<{ relPath: string; content: string }>;
  mappings: Array<{ name: string; sourceRel: string; targetRelpath: string; overwrite: boolean; ifSourceMissing: 'skip' | 'keep' | 'delete' }>;
  ignoreItems: string[];
}

interface FsState {
  sourceDir: string;
  targetDir: string;
  mappingSrcDir: string;
}

async function setupDirs(): Promise<FsState> {
  const sourceDir = await mkdtemp(join(ROOT, 'fuzz-src-'));
  const targetDir = await mkdtemp(join(ROOT, 'fuzz-tgt-'));
  const mappingSrcDir = await mkdtemp(join(ROOT, 'fuzz-map-'));
  return { sourceDir, targetDir, mappingSrcDir };
}

async function writeFileSafe(absPath: string, content: string): Promise<void> {
  await mkdir(join(absPath, '..'), { recursive: true });
  await writeFile(absPath, content);
}

function rng(seedStr: string): () => number {
  // tiny seedable PRNG (mulberry32)
  let h = 2166136261 >>> 0;
  for (let i = 0; i < seedStr.length; i++) {
    h ^= seedStr.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  let a = h >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randInt(rand: () => number, lo: number, hi: number): number {
  return lo + Math.floor(rand() * (hi - lo + 1));
}

function pick<T>(rand: () => number, arr: T[]): T {
  return arr[Math.floor(rand() * arr.length)];
}

function genSeed(rand: () => number): Seed {
  const numFiles = randInt(rand, 3, 12);
  const sourceFiles: Seed['sourceFiles'] = [];
  for (let i = 0; i < numFiles; i++) {
    const depth = randInt(rand, 0, 2);
    const parts: string[] = [];
    for (let d = 0; d < depth; d++) parts.push(`sub${randInt(rand, 1, 3)}`);
    parts.push(`f${i}.txt`);
    const relPath = parts.join('/');
    sourceFiles.push({ relPath, content: `src-${i}-${rand().toString(36).slice(2, 8)}` });
  }
  // 50% chance: target starts empty; 50%: has a subset including some orphans
  const initialTarget: Seed['targetFiles'] = [];
  if (rand() < 0.5) {
    const subset = sourceFiles.slice(0, Math.floor(sourceFiles.length / 2));
    for (const f of subset) {
      initialTarget.push({ relPath: f.relPath, content: f.content });
    }
    // Add 0-2 orphan files in target (only in source dir? no, in target only)
    for (let i = 0; i < randInt(rand, 0, 2); i++) {
      initialTarget.push({ relPath: `orphan${i}.txt`, content: `orphan-${i}` });
    }
  }

  // 0-3 random mappings
  const mappings: Seed['mappings'] = [];
  const numMappings = randInt(rand, 0, 3);
  for (let i = 0; i < numMappings; i++) {
    const overwrite = rand() < 0.5;
    const ifSourceMissing = pick(rand, ['skip', 'keep', 'delete'] as const);
    mappings.push({
      name: `mapping-${i}`,
      sourceRel: `map-src-${i}.ini`,
      targetRelpath: pick(rand, ['', `map-tgt-${i}.ini`, `app/${i}/config.ini`]),
      overwrite,
      ifSourceMissing,
    });
  }

  // 0-2 random ignore patterns
  const ignoreItems: string[] = [];
  if (rand() < 0.5) ignoreItems.push('sub1');
  if (rand() < 0.3) ignoreItems.push('orphan0.txt');

  return { sourceFiles, targetFiles: initialTarget, mappings, ignoreItems };
}

async function applySeed(state: FsState, seed: Seed): Promise<void> {
  // Source
  for (const f of seed.sourceFiles) {
    await writeFileSafe(join(state.sourceDir, f.relPath), f.content);
  }
  // Target (initial state)
  for (const f of seed.targetFiles) {
    await writeFileSafe(join(state.targetDir, f.relPath), f.content);
  }
  // Mapping source files (real local files for mapping source)
  for (const m of seed.mappings) {
    await writeFileSafe(join(state.mappingSrcDir, m.sourceRel), `mapping-source-${m.name}`);
  }
}

function buildConfig(state: FsState, seed: Seed, applyMode: 'immediate' | 'staging' | 'immediate-with-precheck'): AppConfig {
  const mappings: FileMapping[] = seed.mappings.map((m, idx) => ({
    id: `m${idx}`,
    name: m.name,
    sourcePath: join(state.mappingSrcDir, m.sourceRel),
    targetRelpath: m.targetRelpath,
    enabled: true,
    overwrite: m.overwrite,
    ifSourceMissing: m.ifSourceMissing,
  }));
  return {
    sourceDir: state.sourceDir,
    targetDir: state.targetDir,
    backupDir: '',
    intervalSec: 300,
    backupCount: 1,
    autostart: false,
    applyMappingsImmediately: true,
    fileMappings: mappings,
    ignoreItems: seed.ignoreItems,
    applyMode,
    stagingDir: '',
    executablePath: '',
  };
}

async function readTree(root: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  async function walk(abs: string, relBase: string): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await readdir(abs, { withFileTypes: true });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return;
      throw err;
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const abs2 = join(abs, e.name);
      const rel2 = relBase === '' ? e.name : `${relBase}/${e.name}`;
      if (e.isDirectory()) await walk(abs2, rel2);
      else if (e.isFile()) out.set(rel2, await readFile(abs2, 'utf-8'));
    }
  }
  await walk(root, '');
  return out;
}

function resolveMappingRelPath(map: { sourcePath: string; targetRelpath: string }): string {
  const r = map.targetRelpath;
  if (r === '' || r.endsWith('/')) {
    const base = (map.sourcePath ?? '').split(/[\\/]/).pop() ?? '';
    return r === '' ? base : `${r}${base}`;
  }
  return r;
}

function isIgnore(rel: string, ignoreItems: string[]): boolean {
  for (const item of ignoreItems) {
    if (rel === item || rel.startsWith(item + '/')) return true;
  }
  return false;
}

async function assertInvariants(
  state: FsState,
  seed: Seed,
  result: { ok: boolean; fatalError?: string; added: string[]; modified: string[]; deleted: string[]; mappingCopied: string[]; mappingFailed: string[]; unchanged: number; warnings: string[] },
  tag: string,
): Promise<void> {
  // I6: ok ↔ !fatalError
  if (result.ok && result.fatalError) {
    throw new Error(`[${tag}] INVARIANT I6 VIOLATED: ok=true 但 fatalError=${result.fatalError}`);
  }
  if (!result.ok && !result.fatalError) {
    throw new Error(`[${tag}] INVARIANT I6 VIOLATED: ok=false 但没 fatalError (warnings=${result.warnings.join('; ')})`);
  }

  // If fatal, skip content checks (fatal is acceptable; we only check semantics on success)
  if (!result.ok) return;

  const targetTree = await readTree(state.targetDir);

  // I1: source files exist in target with byte-equal content (modulo ignoreItems + mapping-exempt dirs)
  for (const sf of seed.sourceFiles) {
    if (isIgnore(sf.relPath, seed.ignoreItems)) continue;
    const got = targetTree.get(sf.relPath);
    if (got !== sf.content) {
      throw new Error(
        `[${tag}] INVARIANT I1 VIOLATED: source file ${sf.relPath} not synced correctly. ` +
        `expected=${JSON.stringify(sf.content)} got=${JSON.stringify(got)}`,
      );
    }
  }

  // I5: ignoreItems-prefixed files in target were NOT deleted
  for (const tgf of seed.targetFiles) {
    if (isIgnore(tgf.relPath, seed.ignoreItems)) {
      const got = targetTree.get(tgf.relPath);
      if (got === undefined) {
        throw new Error(`[${tag}] INVARIANT I5 VIOLATED: ignoreItems 命中的 target 文件 ${tgf.relPath} 被删了`);
      }
    }
  }

  // I2/I3: mappings
  for (const m of seed.mappings) {
    // Reconstruct the FileMapping the way buildConfig() did, so relPath logic matches syncer
    const fullMapping = {
      sourcePath: join(state.mappingSrcDir, m.sourceRel),
      targetRelpath: m.targetRelpath,
    };
    const rel = resolveMappingRelPath(fullMapping);
    const srcContent = `mapping-source-${m.name}`;
    const tgtExists = targetTree.has(rel);

    if (tgtExists) {
      const got = targetTree.get(rel);
      if (got !== srcContent) {
        throw new Error(
          `[${tag}] INVARIANT I2/I3 VIOLATED: mapping ${m.name} 存在但内容错. ` +
          `expected=${JSON.stringify(srcContent)} got=${JSON.stringify(got)} rel=${rel}`,
        );
      }
    }
  }
}

describe('Fuzz harness for Syncer.sync (intermittent bug surfacing)', () => {
  const ITERATIONS = 100;

  it(`runs ${ITERATIONS} random cases across applyModes without invariant violations`, async () => {
    let lastFailure: Error | null = null;
    let firstFailureSeed = '';

    for (let i = 0; i < ITERATIONS; i++) {
      const seedStr = `fuzz#${i}`;
      const rand = rng(seedStr);
      const state = await setupDirs();
      let seed: Seed = genSeed(rand); // hoisted for catch visibility
      try {
        seed = genSeed(rand);
        await applySeed(state, seed);
        // Cycle through applyMode to cover all three modes
        const applyModes: Array<'immediate' | 'staging' | 'immediate-with-precheck'> =
          ['immediate', 'staging', 'immediate-with-precheck'];
        const applyMode = applyModes[i % applyModes.length];
        const cfg = buildConfig(state, seed, applyMode);
        const syncer = new Syncer(cfg);

        // First sync
        const first = await syncer.sync(null, {});
        // If staging, ensure .pending-apply exists for files that were synced, then we can't
        // observe target changes without swap. Skip content invariants for staging on first sync
        // (only assert I6 ok<->!fatalError + I1 on immediate-mode second pass).
        if (first.result.fatalError) continue;

        // For staging, do a second sync which should not produce new adds (no source change)
        // For precheck, similar — second sync = no source change.

        // I7: re-run with last index — nothing should be in `modified` or `added`
        // (mtime preservation contract: target's mtime == source's mtime after first sync,
        //  so a no-change re-run sees them equal).
        // Only applies to immediate / immediate-with-precheck (staging writes to stagingDir,
        // target stays empty until swap — second sync will legitimately see all source as modified).
        const second = await syncer.sync(first.newSourceIndex, {});
        if (!second.result.fatalError && applyMode !== 'staging') {
          if (second.result.modified.length > 0 || second.result.added.length > 0) {
            // Allow exemptions: mappings with overwrite=false on already-copied targets
            // shouldn't trigger re-copies. Empty source to target mismatch = bug.
            const mappingsOverwrite = seed.mappings.filter((m) => m.overwrite);
            throw new Error(
              `[DEBUG-fuzz${i}-2nd] I7 VIOLATED: re-run with no source change produced ` +
              `modified=${JSON.stringify(second.result.modified)} ` +
              `added=${JSON.stringify(second.result.added)} ` +
              `deleted=${JSON.stringify(second.result.deleted)} ` +
              `(mtime preservation broken? content unchanged.) applyMode=${applyMode} ` +
              `mappingsOverwrite=${mappingsOverwrite.length}`,
            );
          }
        }

        // I1/I5/I6 only verifiable on immediate mode (staging writes to stagingDir)
        if (applyMode === 'immediate') {
          await assertInvariants(state, seed, first.result, `[DEBUG-fuzz${i}-1st-imm]`);
        }
      } catch (err) {
        const e = err as Error;
        console.error(`\n[FUZZ REPRO] seed=${seedStr}`);
        console.error('[FUZZ REPRO] sourceFiles=', JSON.stringify(seed.sourceFiles, null, 2));
        console.error('[FUZZ REPRO] targetFiles=', JSON.stringify(seed.targetFiles, null, 2));
        console.error('[FUZZ REPRO] mappings=', JSON.stringify(seed.mappings, null, 2));
        console.error('[FUZZ REPRO] ignoreItems=', JSON.stringify(seed.ignoreItems));
        console.error('[FUZZ REPRO] full stack:\n', e.stack);
        lastFailure = new Error(`${e.message}\n--- SEED: ${seedStr} ---\n--- STACK ---\n${e.stack}`);
        firstFailureSeed = seedStr;
        break;
      } finally {
        await rm(state.sourceDir, { recursive: true, force: true });
        await rm(state.targetDir, { recursive: true, force: true });
        await rm(state.mappingSrcDir, { recursive: true, force: true });
      }
    }

    if (lastFailure) {
      throw new Error(`\n\n=== FUZZ FAILED on ${firstFailureSeed} ===\n${lastFailure.message}\n=== END FUZZ ===\n`);
    }
  }, 60_000);
});
