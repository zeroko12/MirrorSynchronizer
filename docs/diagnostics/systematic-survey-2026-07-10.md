# Systematic code survey — 2026-07-10

> **Pattern family:** [Silent type coercion](../architecture/SILENT-COERCION.md). This round found 0 new bugs at the public surface; later rounds (deep analysis round 3, architecture audit) caught 3 sibling bugs from the same family. See master doc for the consolidated picture.

**Trigger:** after fixing the sync-mtime drift bug ([commit 412fa71](./sync-mtime-drift.md)), user asked to keep digging — verify the rest of the codebase doesn't hide similar latent issues.

**Method:** build a survey harness that constructs 17 candidate edge cases against the public `Syncer.sync` / `Syncer.applyMappingsOnly` / `ConfigManager.save` surfaces. Run, look for reds.

**Result:** 0 latent bugs found. **365 tests pass** (baseline 348 + 17 survey cases).

## Candidate matrix

| # | Area | Pre-judgement | Verdict |
|---|---|---|---|
| 1 | 2 parallel `sync()` on same `Syncer` instance | likely race condition | ✅ No FATAL, no IO warnings, no file corruption. Throughput inefficiency (both redo work) expected; scheduler already prevents this in normal use |
| 2 | Empty source dir | ambiguous | ✅ Treated as no-op success (no added/deleted) |
| 3 | Stale `lastIndex` (files in index that don't exist in source) | could throw or count them as added | ✅ Silently skipped; only real files go in `result.added` |
| 4 | Unicode + special-char filenames (`带中文.txt`, `with space.txt`, `emoji-🎉.txt`, `paren(s).txt`, `amp&ersand.txt`) | encoding issues likely on Windows | ✅ All sync to byte-equal content |
| 5 | Two mappings → same `targetRelpath` | conflict / counter drift | ✅ Last-write-wins (B's content = target). `mappingCopied` records both, by design |
| 6 | Non-existent target dir | must error or auto-create | ✅ Auto-creates target, no FATAL |
| 7 | `ifSourceMissing=delete` + target absent | could throw ENOENT on unlink | ✅ Silent no-op (existing code checks `targetExists` before unlink) |
| 8 | `ifSourceMissing=keep` + target absent | could crash | ✅ Silent no-op |
| 9 | Deeply nested source (10 levels) | path normalization | ✅ Works |
| 10 | `lastIndex` totally unrelated to current source (100 ghost files) | could mis-classify as added | ✅ Ghost files ignored; only real files go in `added` |
| 11 | Staging + 2 parallel sync | `.pending-delete.json`/`.pending-apply` write races | ✅ Both finish ok, no warnings; staging files written |
| 12 | Orphan pre-populated target + 2 parallel sync | concurrent `fs.unlink` on same orphan | ✅ Both finish ok; one gets ENOENT (silently skipped), the other succeeds |
| 13 | `applyMappingsOnly` + `sync` concurrently | mapping file write race | ✅ Both finish ok; both write `config.ini`, last one wins |
| 14 | Source file with future mtime (clock skew) | could confuse mirror comparison | ✅ Writes correctly |
| 15 | Mapping sourcePath disappeared between config save and sync | could FATAL | ✅ Goes to `mappingSkipped` (not `mappingFailed`), no FATAL |
| 16 | `config.validate` rejects `backupDir === targetDir` | should throw | ✅ Throws `配置校验失败: backupDir 不能等于 targetDir(...)` |
| 17 | 50 sequential syncs on stable source | non-idempotent code path? | ✅ Cycle 50: `added=0 modified=0` — full idempotency |

## Verdict per area

**Concurrency (1, 11, 12, 13):** The codebase relies on the scheduler for in-flight serialisation. Direct calls to `Syncer.sync` from multiple callers do not crash, but they do redundant work. This is by design (the [scheduler](../../src/core/scheduler.ts) test covers the production path with `runNow({force:true})` waiting for in-flight completion). No need to add per-instance mutex — the existing scheduler contract is correct.

**Edge case mappings (5, 7, 8, 15):** Existing `applyMapping` handles "ifSourceMissing" correctly with the three documented paths (skip/keep/delete). When `targetExists` is false, the `delete` branch is correctly no-op (the code explicitly checks `if (targetExists)` before `unlink`). When source is missing, all three strategies behave correctly per the README contract.

**Index staleness (3, 10):** `lastIndexMap` is treated as a soft hint — `isNew = !lastIndexMap.has(rel)` only affects whether files are flagged as "added" in result metadata. Real sync logic uses `sourceMap` (current scan) vs `targetMap` (current scan), not `lastIndex`. So stale index doesn't corrupt the diff.

**Persistence / capacity (16, 17):** config validation catches `backupDir === targetDir` before any sync runs. 50 cycles on stable source produce zero added/modified at cycle 50 — full idempotency.

## What I deliberately did NOT test in this survey

These are intentionally outside scope (would need different infra or have their own existing coverage):

- **HTTP adapter edge cases** — covered in [tests/http-adapter.test.ts](../../tests/http-adapter.test.ts), [tests/syncer-http.test.ts](../../tests/syncer-http.test.ts), [tests/mappings-remote.test.ts](../../tests/mappings-remote.test.ts)
- **Backup / swapper behaviour** — covered in [tests/backupper.test.ts](../../tests/backupper.test.ts), [tests/swapper.test.ts](../../tests/swapper.test.ts) (already exhaustive)
- **history.test.ts** — better-sqlite3 native module NODE_MODULE_VERSION mismatch is unrelated to sync logic; documented as a known infra issue in commit `b517bb2 ci: lock Node 22.12.0`
- **Pre-existing performance test (`1000 文件同步耗时 < 30s`)** — covered in [tests/syncer.test.ts](../../tests/syncer.test.ts) line containing "性能"
- **Error classification** — exhaustively covered in [tests/errors.test.ts](../../tests/errors.test.ts)

## Candidates worth a follow-up (lower priority)

These were *not* red in this survey but the code paths are interesting enough to flag for an architecture review:

- **Symlink/junction handling** — `Indexer.scan` uses `fs.stat` (follows symlinks). If source dir has a symlink cycle, behaviour is unverified. Not exercised here because setup helpers can't easily manufacture symlinks under tempdir without elevated privileges on Windows. Future test would need elevated context.
- **Cross-filesystem copy** (e.g., source on ext4, target on SMB) — current code does `fs.copyFile` directly, which works but doesn't pre-check cross-volume. If source/target are on different volumes, `fs.copyFile` re-reads+re-writes instead of renaming. Performance concern, not correctness. Out of scope for this survey.

## Hand-off: nothing to fix

This survey closed with no new fixes required. The 17 cases added to [tests/systematic-survey.test.ts](../../tests/systematic-survey.test.ts) are kept as regression protection — any future change that breaks one of these invariants will be caught at test time, before it can ship.

Confidence level on "no latent bugs in the surveyed areas": moderate-to-high. The 17 candidates were chosen from code-reading prior, not from a deep static analysis. A more thorough audit would cover the [scheduler](../../src/core/scheduler.ts), [detector](../../src/core/detector.ts), and [state](../../src/core/state.ts) modules under load — these have unit tests but were not part of this round.
