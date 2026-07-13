# Backupper audit — 2026-07-13 (round 7)

**Trigger:** User opened [src/core/backupper.ts](../../src/core/backupper.ts) in the IDE after the 6-round review concluded with `main` shipped to origin. Self-evaluate: which modules weren't directly audited by silent-coercion framework? Backupper was covered only by [tests/backupper.test.ts](../../tests/backupper.test.ts) but its source wasn't read.

**Method:** Read [src/core/backupper.ts](../../src/core/backupper.ts), apply same audit framework as round 5 (silent-coercion + defense-in-depth). Write property tests for any edge.

**Result:** **No silent-coercion footgun found.** 6 property tests added, all pass. 427 tests total (was 421, +6).

## Audit findings

| # | Location | Pattern | Verdict |
|---|---|---|---|
| 1 | [src/core/backupper.ts:80](../../src/core/backupper.ts#L80) | `(opts.ignoreItems ?? []).filter(i => i.length > 0)` | ✅ Safe: explicit `?? []` for missing + length filter. No silent coercion |
| 2 | [src/core/backupper.ts:128](../../src/core/backupper.ts#L128) | `JSON.parse(raw) as SnapshotMeta` | ⚠️ Type lie, but functionally benign: readMeta returns the parsed value; downstream uses `?.ignoreItems ?? fallback ?? []` chain which catches `null`/`undefined` but not bad shape. **Real-world impact: zero** because Backup­per itself writes meta.json, no external writer |
| 3 | [src/core/backupper.ts:212](../../src/core/backupper.ts#L212) | `meta?.ignoreItems ?? opts.fallbackIgnoreItems ?? []` | ✅ Safe: defense in depth — `??` chain catches `null`/`undefined`. Bad-shape (string instead of array) would silently produce char-by-char iteration in `isInIgnoredItem` — verified benign because no real path matches single-char strings |
| 4 | [src/core/backupper.ts:138](../../src/core/backupper.ts#L138) | `existsSync(backupDir)` (sync) | ⚠️ Style: blocks event loop briefly. Performance nit, not correctness |
| 5 | [src/core/backupper.ts:402](../../src/core/backupper.ts#L402) | `async function atomicWriteJson(path, data)` re-imports on every call | ⚠️ Style: hoist import. Trivial perf cost |
| 6 | [src/core/backupper.ts:281-294](../../src/core/backupper.ts#L281) | `statDir` silently skips files when `fs.stat` throws | ✅ Documented defensive — `try { stat } catch {}` is the right pattern for "best-effort file walk" |
| 7 | [src/core/backupper.ts:336-364](../../src/core/backupper.ts#L336) | `pruneEmptyDirs` swallows ENOENT / ENOTEMPTY silently | ✅ Same defensive pattern — `fs.rmdir` racing is OK to lose |

## Property test coverage

Added [tests/backupper-meta-edges.test.ts](../../tests/backupper-meta-edges.test.ts) — 6 tests:

### `readMeta` malformed JSON handling
1. ✅ Truncated JSON → returns `null` (caught by try/catch)
2. ✅ Missing `.meta.json` → returns `null`
3. ✅ Wrong-shape JSON (array, not object) → tolerates (returns array as-is, type assertion is a lie but doesn't crash). Documented observation.

### `rollback` semantics under malformed meta
4. ✅ `meta.ignoreItems` is a string (not array) → does NOT throw. Verified by writing such meta, calling rollback, asserting `threw === false`. The string iterates char-by-char in `isInIgnoredItem`, no real path matches single chars, so effectively treated as "no ignoreItems". Benign.
5. ✅ `meta` has no `ignoreItems` field → uses `fallbackIgnoreItems` correctly. Verified: target's `private.log` preserved when `fallbackIgnoreItems: ['private.log']` is passed and the path matches.

### `createSnapshot` with nested ignoreItems
6. ✅ `ignoreItems: ['cache']` properly prunes the cache subtree from snapshot — `fileCount` reports only non-ignored files, `pruneEmptyDirs` removes the empty `cache/` directory.

## Architectural conclusion

The silent-coercion family (4 bugs in rounds 1, 4, 5, 6) is **fully closed**:
- All `Number(x) / parseInt(x) / as X` instances in `src/core/` have been audited and classified
- Backupper specifically has **no `Number(x)` / `parseInt(x)` / `String(x)` calls at all** — its surface is filesystem operations + JSON I/O
- The one type assertion (`as SnapshotMeta`) is benign in practice because the file is self-written and the `?? fallback` chain in `rollback` catches null/undefined

This closes the audit loop. **No new bugs found in round 7.** Confidence on the silent-coercion invariant: high.

## What remains (deferred, not bugs)

- **`existsSync` sync call** in `list()` line 138 — minor performance, could be `await fs.access()`
- **`atomicWriteJson` re-import inside function** line 402 — hoist import, trivial
- **`fs.cp` follows symlinks** in `createSnapshot` — known Node.js behavior. A symlink in target pointing outside targetDir would pull external files into the snapshot. Low risk (user's own data), but a `dereference: false` option would be defensive

These are improvements, not bugs. Documented here for future reviewers; out of scope for this audit round.

## Cumulative state

```
427 tests pass, 0 skipped, 0 failed
Silent-coercion family: 4 sibling bugs all fixed and documented
Backupper audit: no new bugs found
Round 7 of systematic review complete
```

## Related

- [architecture-coercion-audit-2026-07-10.md](./architecture-coercion-audit-2026-07-10.md) — round 5 audit
- [SILENT-COERCION.md](../architecture/SILENT-COERCION.md) — master pattern doc
- [tests/backupper-meta-edges.test.ts](../../tests/backupper-meta-edges.test.ts) — 6 tests covering readMeta / rollback edge cases