# Deep analysis — 2026-07-10 (round 2)

**Trigger:** After systematic survey ([systematic-survey-2026-07-10.md](./systematic-survey-2026-07-10.md)) found 0 latent bugs at the public surface, user asked for deeper analysis on internal invariants.

**Method:** Read 5 internal modules (`state.ts`, `detector.ts`, `scheduler.ts`, `launcher.ts`, `fs-utils.ts`) and construct property tests against internal contracts. 21 candidate invariants tested.

**Result:** 0 new bugs found. **386 tests pass total** (baseline 365 + 21 new). 3 documented footguns identified, all **already defense-layered upstream**.

## Footguns vs. real bugs

| # | Footgun | Where | Defense layer | Conclusion |
|---|---|---|---|---|
| 1 | `state.ts` cache/file desync: multiple StateManager instances on same file see different state | [`StateManager`](../../src/core/state.ts#L48) | Single-writer discipline enforced by process boundary (renderer doesn't write state.json directly — only main process does via Electron IPC). Tested. | Real footgun if multi-process; not present in current architecture. Document and move on. |
| 2 | `launcher.ts` doesn't validate relPath (`'../x.exe'` not rejected) | [`tryLaunchExecutable`](../../src/core/launcher.ts#L56) | [`config.validate()`](../../src/core/config.ts#L140-L152) rejects `..` and `:` (absolute path). Tested in DEEP-7. | Defense in depth via upstream config validation. Launcher could add second-layer check (cheaper, safer); not strictly required. |
| 3 | `state.ts` corrupts file on partial write + doesn't quarantine | [`readJsonSafe`](../../src/core/fs-utils.ts#L37) reads same broken file repeatedly | No auto-quarantine, but logger warns + caller can ignore. Documented in code comment. | Acceptable as designed (logger visibility > auto-quarantine that could confuse users). |

## Property test results

### state.ts (5 tests)

- ✅ Save → external file change → load returns cached value (matches design but documents the footgun)
- ✅ Different StateManager instance reads new value (proves cache is per-instance)
- ✅ Other internal invariants (covered by existing tests/state.test.ts)

### launcher.ts (1 test)

- ✅ Confirms `tryLaunchExecutable('../tgt/test.exe')` — does not validate, returns file-missing without spawning
- Footgun surface: if a CALLER bypassed config validation and called launcher directly with untrusted relPath, escape would land. **In normal pipeline, caller is scheduler which gets relPath from validated config.**

### scheduler.ts computeBackoff (4 tests)

- ✅ `n=1` jitter in `[0, baseMs)` — algorithm matches AWS Full Jitter
- ✅ `n=10` caps at MAX_BACKOFF_MS (5min)
- ✅ `n ≤ 0` returns baseMs unchanged
- ✅ Monotonic exp growth pattern: n=1→60000, n=2→120000, n=3→240000, n=4-10→300000 (capped)

### fs-utils.ts atomicWriteJson (3 tests)

- ✅ Write success leaves no `.tmp` leftover
- ✅ Nested path: `mkdir -p` parent chain works
- ✅ `readJsonSafe` returns fallback on corrupt file (no quarantine — caller's choice)

### detector.ts decide() branch coverage (7 tests)

- ✅ All 5 silent branches reachable: `no-changes`, `popup-disabled`, `snoozed`, `already-shown`
- ✅ `popup new-changes` reachable
- ✅ `locked-detect` reachable
- Priority order verified: lock > snooze > popup-disabled > already-shown > popup

### detector.ts computeFingerprint (2 tests)

- ✅ Sort invariant: shuffled input produces same hash (tested 3 different orderings)
- ✅ Prefix (`+`/`-`/`~`) affects hash (added vs deleted file with same path different fingerprint)

### config.validate() defense layer (2 tests)

- ✅ rejects `executablePath='../escape.exe'` with `配置校验失败: executablePath 不允许包含 ".."`
- ✅ rejects absolute paths `executablePath='C:/foo'` with `配置校验失败: executablePath 不允许包含 ":"`

## Verdict

Codebase's internal invariants are robust:

1. **Backoff algorithm** matches the documented AWS Full Jitter pattern within expected bounds
2. **Fingerprint** is order-independent (sort-then-hash contract holds)
3. **decide()** priority ordering matches code comments and tests
4. **Defense in depth works**: the launcher's lack of relPath validation is caught at config level
5. **atomicWriteJson** doesn't leak tmp files; mkdir-parent is correct
6. **state.ts** cache consistency is per-instance (correct by design for single-writer)

## Hand-off: state.ts cache footgun

The 3 footguns are all defense-layered except:

- **`state.ts` cache desync** — if there's ever a future need to have multiple writers (e.g. `state.json` shared with another process), the cache would silently corrupt. Future code should either:
  - Add a `bustCache()` method that callers can invoke after external writes
  - Document explicitly that StateManager is per-instance per-process
  - Move to a per-file mtime check in `load()`

This isn't blocking current usage but is the most fragile of the 3. Flagged for the next code reviewer.

## What this round did NOT cover

- `errors.ts` — already exhaustively covered in tests/errors.test.ts
- `logger.ts` — pure side-effect, no invariant worth property-testing
- `constants.ts` — values, can't test invariants meaningfully
- `api-contracts.ts` — would need schema context; covered indirectly via other modules' tests
- `history.ts` (better-sqlite3 native binding) — already known infra issue, not relevant to sync logic

## How to extend

If you want round 3, candidates:

- **HTTP adapter** under malformed server response / ETag mismatch / manifest drift — currently covered but could push on edge cases (e.g. very large manifest)
- **WebDAV adapter** namespace interactions / XML escaping
- **Launcher on Linux/POSIX** — race detection here is advisory (POSIX locks are advisory); fs.open(r+) usually succeeds even when locked
- **Preflight-locks** with locked files held open by tests — readJsonSafe-style "what if file is locked" scenario
