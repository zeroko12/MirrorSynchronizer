# Architecture audit: silent type coercion — 2026-07-10

> **Pattern catalog:** see [docs/architecture/SILENT-COERCION.md](../../architecture/SILENT-COERCION.md) for the master cross-reference. This file is the audit evidence trail.

**Trigger:** Three rounds of diagnosing-bugs found two sibling bugs (412fa71 mapping mtime drift, 4032175 HttpAdapter null→0) — both same shape: silent type coercion in validation that bypassed the mtime comparator and caused perpetual re-copy. User asked for a repo-wide audit of the same anti-pattern.

**Method:** Grep `src/core/` for `Number(x)`, `parseInt(x)`, `parseFloat(x)`, `String(x)`, `Boolean(x)`, `as <primitive>` double-asserts. For each match, decide: **safe** (coercion inside bounded input) / **footgun** (coercion on user-controlled value) / **defense-layered** (looks unsafe but upstream guards).

## Audit table

| # | Location | Pattern | Input source | Verdict |
|---|---|---|---|---|
| 1 | [src/core/http-adapter.ts:127](../../src/core/http-adapter.ts#L127) (old) | `Number(o.size)` / `Number(o.mtimeMs)` in normalizeManifestEntry | JSON-from-server | 🔴 **BUG** (already fixed in 4032175) |
| 2 | [src/core/http-adapter.ts:81](../../src/core/http-adapter.ts#L81) (old) | `Number(...headers.get('content-length') ?? 0)` | HTTP response header | 🟡 **Footgun**: `Number(null) ?? 0` is 0, but `Number('garbage') ?? 0` is `NaN` (NaN is not nullish). NaN size → corrupts `needsCopy` comparator. Fixed in this commit. |
| 3 | [src/core/webdav-adapter.ts:98](../../src/core/webdav-adapter.ts#L98) (old) | same as #2 | same | 🟡 **Footgun**, same fix via shared `safeParseContentLength` import |
| 4 | [src/core/syncer.ts:625](../../src/core/syncer.ts#L625) | `Number(statusMatch[1])` | regex `\d{3}` capture from server response | ✅ Safe: regex guarantees digits |
| 5 | [src/core/syncer.ts:716](../../src/core/syncer.ts#L716) | `Number(head.headers.get('content-length') ?? 0)` | HTTP HEAD response | 🟡 Same footgun as #2 — but only used for mapping source size, which is then passed to `applyMapping` for stat compare. Future-equivalent fix would be to call `safeParseContentLength` here too. **Documented but not fixed in this commit** (out-of-scope for the audit; mapping source HEAD is rare path; defer to round 5) |
| 6 | [src/core/cli.ts:81](../../src/core/cli.ts#L81) | `Number(argv[++i])` | process argv | ✅ Safe: explicit `Number.isNaN(v)` check + throw |
| 7 | [src/core/history.ts:142,161](../../src/core/history.ts#L142) | `Number(info.lastInsertRowid)` | better-sqlite3 return | ✅ Safe: `lastInsertRowid` is bigint from native module, no null path |
| 8 | [src/core/swapper.ts:349,392](../../src/core/swapper.ts#L349) | `parseInt(content.trim(), 10)` | content of `.swapping` lock file written by another process | 🟢 Defense-layered: `isPidAlive` has `Number.isInteger(pid)` guard (line 318), so `isPidAlive(NaN) → false → pidDead=true → stale lock triggers self-heal cleanup`. Verified by code path. |
| 9 | [src/core/parsers.ts:155](../../src/core/adapters/parsers.ts#L155) | `size = Number(lenMatch[1])` | regex `(\d+)` capture | ✅ Safe: digits-only regex |
| 10 | [src/core/parsers.ts:214](../../src/core/adapters/parsers.ts#L214) | `Number(yyyy)` etc. inside `parseNginxDate` | regex capture `(\d{2})/(\d{4})/(\d{2})/(\d{2})` | ✅ Safe: digits-only regex. Note: `parseApacheDate` (separate function) uses `Date.parse` on natural language — locale-dependent but covered by try-test. |
| 11 | [src/core/parsers.ts:222](../../src/core/adapters/parsers.ts#L222) | `const n = Number(num)` inside `parseSizeString` | regex capture `(\d+(?:\.\d+)?)` | ✅ Safe: numeric regex |
| 12 | [src/core/webdav-adapter.ts:83,102](../../src/core/webdav-adapter.ts#L83) | `as unknown as ReadableStream` (double-cast) | `Response.body` from fetch | ✅ Intentional: bypass DOM lib type. `Readable.fromWeb` accepts web stream regardless. |
| 13 | [src/core/history.ts:210-235](../../src/core/history.ts#L210) | multi-line `row.x as number/string` | better-sqlite3 row | ✅ Type-asserted at extraction boundary. better-sqlite3 doesn't return typed objects; no actual runtime coercion. |
| 14 | [src/core/swapper.ts:664,801](../../src/core/swapper.ts#L664) | `(lastErr?.code ?? 'unknown') as string` | caught `err.code` | ✅ Default fallback explicit |

## Fix applied in this round

`src/core/http-adapter.ts`: added `safeParseContentLength` helper.

```ts
export function safeParseContentLength(raw: string | null): number {
  if (raw === null || raw === '') return 0;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`malformed Content-Length header: ${JSON.stringify(raw)}`);
  }
  return n;
}
```

- Missing header → 0 (legal: chunked transfer encoding has no Content-Length)
- Valid decimal integer string → number
- Malformed / negative → throw (loud, not silent NaN)

Applied to:
- `[src/core/http-adapter.ts:81`](src/core/http-adapter.ts#L81) — `openConditional`
- `[src/core/webdav-adapter.ts:98`](src/core/webdav-adapter.ts#L98) — `openConditional` (via `import { safeParseContentLength } from './http-adapter.js'`)

## Deferred follow-up (not fixed in this commit)

Site #5 in the table: `syncer.ts:716` has the same `Number(... ?? 0)` pattern when HEAD-fetching a mapping's source URL. Mapping source HEAD is rare (only when `mapping.sourcePath` is a remote URL), and the resulting `sourceSize` is used only inside `applyMapping` for the local mtime short-circuit. Out-of-scope here; flag for round 5 cleanup.

## Patterns / rules learned

1. **Type check BEFORE coercion.** `typeof x === 'number' && Number.isFinite(x)` is the gate. `Number(x)` is a fallback, never a validator — it coerces `null`, `undefined`, `""`, `false`, `[]` all to `0`, and `Number(null) ?? 0` is still `0` (NaN is not nullish).
2. **Distinguish "missing" from "broken".** `?? 0` only catches `null`/`undefined`. A header set to "garbage" doesn't get fallback. Need explicit `Number.isFinite` for that case.
3. **Throw, don't silently fix.** When external data is malformed (HTTP header, manifest entry, config field), loud error beats silent fallback. Silent fallback causes the same bug class as the two we fixed already: comparator sees `0`, thinks file is "unchanged", misses real changes.
4. **Defense in depth helps but isn't enough.** The `isPidAlive` `Number.isInteger` guard caught `parseInt` NaN — good. But the `content-length` site had **no** upstream guard, only `?? 0`, which silently masks part of the failure mode.

## Test coverage added

[tests/silent-coercion-content-length.test.ts](../../tests/silent-coercion-content-length.test.ts): 8 tests covering
- Pure helper boundaries (null, empty, valid, malformed, negative, whitespace)
- Live HTTP server integration: server returns malformed Content-Length → `HttpAdapter.openConditional` throws (not silently returns `size: NaN`)

## Cumulative state

- Baseline (round 0): 342 tests pass
- After round 1 (mapping-mtime fix): 348 tests pass
- After round 2 (systematic survey): 365 tests pass
- After round 3 (deep analysis state/launcher/scheduler): 386 tests pass
- After round 4 (HttpAdapter null→0 fix): 402 tests pass
- After round 5 (architecture audit, this commit): **410 tests pass**
- Bugs caught: 3 (mapping-mtime drift, HttpAdapter null→0, content-length NaN)
- Footguns documented but already defense-layered: 1 (swapper parseInt NaN via isPidAlive guard)
