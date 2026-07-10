# Deep analysis round 3 — 2026-07-10 (HTTP / WebDAV / parsers)

> **Pattern family:** [Silent type coercion](../architecture/SILENT-COERCION.md). Bug found here (HttpAdapter normalizeManifestEntry null→0) is one of 4 sibling bugs consolidated in the master pattern doc.

**Trigger:** Round 2 found 0 bugs in state/launcher/scheduler. User asked to keep digging into HTTP / WebDAV adapters and the parser chain.

**Method:** Round 3 reads [src/core/http-adapter.ts](../../src/core/http-adapter.ts), [src/core/webdav-adapter.ts](../../src/core/webdav-adapter.ts), and [src/core/adapters/parsers.ts](../../src/core/adapters/parsers.ts), then constructs property tests against pure-function boundaries + an HTTP-server-backed integration test for the manifest normalization path.

**Result:** **1 real bug found and fixed.** 16 property tests now pass. 402 tests total (was 386).

## Bug found: HttpAdapter.normalizeManifestEntry silently maps `null` → `0`

### Symptom (manifestation in production)

Server returns a manifest entry like `{ relPath: "x.txt", size: 100, mtimeMs: null }` (e.g. server couldn't determine timestamp, or indexer omitted the field).

After `JSON.parse`, `mtimeMs` is `null`. The old code coerced via `Number(o.mtimeMs)`:

```ts
const mtimeMs = typeof o.mtimeMs === 'number'
  ? o.mtimeMs
  : Number(o.mtimeMs);  // Number(null) === 0 (finite!)
if (!relPath || !Number.isFinite(size) || !Number.isFinite(mtimeMs)) return null;
```

`Number(null)` is **0** (not `NaN`), and `0` is finite, so the check passed. The entry was admitted to the manifest cache as `{ relPath: "x.txt", size: 100, mtimeMs: 0 }`.

Once that entry lived in `manifestCache`, every subsequent sync treated `x.txt` as having 1970-01-01 mtime. Any real target file's mtime would be ≠ 0 → `needsCopy = true` → re-copied on **every** sync cycle.

User-visible counterpart to the mapping-mtime drift fix (412fa71): same "用户保存新映射后每次同步都被无意义重写" pattern, this time from remote sources with sloppy metadata.

### Fix

Replace `Number()` coercion with strict type guards:

```ts
if (typeof o.size !== 'number' || !Number.isFinite(o.size)) return null;
if (typeof o.mtimeMs !== 'number' || !Number.isFinite(o.mtimeMs)) return null;
```

Now `null` (typeof `object`), string `"not a number"` (typeof `string`), and `NaN` (typeof `number` but finite-fails) are all rejected. Only proper finite numbers pass.

### Why the bug existed

The original code was trying to be flexible: `Number("100")` → 100, `Number("abc")` → NaN, `Number(null)` → 0. The author probably considered that an "OK-ish" coercion. But the side effect on file mtime was not noticed because:
- Tests used only "happy path" entries
- `Number(null) === 0` is finite — passes the validation guard

### Lessons for similar code

- **Don't use `Number(x)` as a validator.** It silently coerces `null`, `undefined`, `""`, `false`, `[]` → all return `0`. The intent of "validating" is lost.
- **Type check BEFORE coercion.** `typeof x === 'number' && Number.isFinite(x)` is the minimum bar for any user-controlled numeric input.
- **Test pure functions with boundary inputs that survive JSON.** JSON.stringify(`NaN`) becomes `null`, JSON.stringify(`undefined`) drops the field, JSON.stringify(`Infinity`) becomes `null`. Test boundaries must include these.

## Property test results

Pure function tests in [tests/deep-analysis-round3.test.ts](../../tests/deep-analysis-round3.test.ts):

- ✅ `parseApacheDate`: 02-May-2026 12:34 → parses to correct components
- ✅ `parseNginxDate`: DD-Mon-YYYY HH:MM format
- ✅ `parseSizeString`: K/M/G unit handling, case-insensitive, garbage → 0
- ✅ `parseDirectoryListing`: parser priority chain, no match → empty + parserName=null
- ✅ `parseWebdavPropfind`: collection skip, multi-propstat with status 200 only, empty body, subdir path handling
- ✅ `HttpAdapter.scan` against live local HTTP server: mixed valid + bad entries → only valid passes, bad entries logged with specific reason

Integration test in [tests/http-adapter-null-mtime.test.ts](../../tests/http-adapter-null-mtime.test.ts):

- ✅ Server returns 3 entries: `good.txt` (valid), `null-mtime.txt` (mtimeMs=null), `null-size.txt` (size=null)
- After fix: only `good.txt` returns; `null-*` are skipped with `[http-adapter] manifest entry #N invalid (mtimeMs/size), skip`

## Other (already-correct) behavior verified

- `HttpAdapter.manifestCache` is per-instance, so two HttpAdapter instances pointing at the same source have independent caches
- `fetchAndParseListing` falls back to HTML parsers when no manifest found
- `WEBDAV_PROPSTAT` regex resets via `WEBDAV_RESPONSE_RE.lastIndex = 0` and a fresh regex per response body
- `parseHttpDate` uses `Date.parse` — works for RFC 7231 standard format; unparseable returns null

## What I did NOT cover in round 3

- **HTTP redirects**: node-fetch follows 3xx automatically. If a PROPFIND GET is redirected to a different host, the request still goes through, but auth headers may not. Not tested.
- **Server-side timeouts**: no test for slow HTTP responses or partial body reads. Server in tests responds synchronously with full body.
- **WebDAV XML namespace variants**: only one namespace (`xmlns:D="DAV:"`) tested. Some servers use `xmlns:` without prefix.
- **Manifest > 1000 entries**: large manifests parsed in single read. No streaming validation.

## Confidence level

**High** for the bug fixed: `null → 0` is a well-tested boundary, regression test serves both pre-fix repro and post-fix invariant.

**Medium** for the rest: pure functions checked with one or two boundary inputs each. A round 4 with property-based fuzzing (e.g., fast-check) on `parseApacheDate` / `parseNginxDate` with random strings would surface more locale-dependent issues — those are deferred.
