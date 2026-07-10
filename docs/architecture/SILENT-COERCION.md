# Silent type coercion — codebase pattern catalog

**Status:** ✅ All known instances remediated (commits 412fa71, 4032175, c2bdf4a, d6dc4df).
**Last audit:** 2026-07-10 (see [architecture-coercion-audit-2026-07-10.md](../diagnostics/architecture-coercion-audit-2026-07-10.md))

This document is the **single anchor** for a recurring bug class discovered across 6 review rounds. Read this before modifying any code that touches:

- Mirror sync comparator (needsCopy logic)
- Mapping source size / mtime extraction
- HTTP/WebDAV adapter headers / manifests
- Any place that takes untyped / external data and constructs a [`FileEntry`](../../src/core/types.ts) or [`ResourceEntry`](../../src/core/adapter.ts)

## The pattern

```
external/untyped input (HTTP header, JSON field, file content, config string)
   ↓ Number() / parseInt() / String() / as X / ?? default
internal numeric / typed value
   ↓ stored in FileEntry.size / mtimeMs
mirror comparator: tFile.size !== sFile.size || Math.abs(mtimeMs - mtimeMs) > tol
```

When the coercion silently produces `0`, `NaN`, or an unexpected default, the comparator either:

1. **Mis-fires `modified = true` indefinitely** — source looks "newer" than target forever (perpetual re-copy, target churn, may trigger EBUSY when target is held).
2. **Mis-fires `unchanged = true` indefinitely** — source looks identical to target forever (perpetual silent miss, real changes never propagate).

Either failure mode is **silent** — no exception, no fatal, just wrong invariants.

## The four bugs (full chronologically)

| Commit | Module | Coercion | Outcome | Comparator path |
|---|---|---|---|---|
| [412fa71](../../) `fix(syncer): preserve mapping source mtime on overwrite` | [syncer.ts:761](../../src/core/syncer.ts#L761) `fs.utimes(target, new Date(), new Date())` | target mtime forced to "now" → drift forward of source | mirror `modified` always set on overwrite=true mappings; target files re-copied every cycle | mirror comparator |
| [4032175](../../) `fix(http-adapter): reject manifest entries with null/undefined size or mtimeMs` | [http-adapter.ts:127](../../src/core/http-adapter.ts#L127) (pre-fix) `Number(o.mtimeMs)` | JSON `null` → `Number(null) === 0` → finite → passes check | source `mtimeMs: 0` (1970) → mirror `modified` always set | mirror comparator |
| [c2bdf4a](../../) `fix(adapter): safe Content-Length parsing` | [http-adapter.ts:81](../../src/core/http-adapter.ts#L81) (pre-fix), [webdav-adapter.ts:98](../../src/core/webdav-adapter.ts#L98) (pre-fix) `Number(... ?? 0)` | malformed header → `Number(garbage)` is `NaN` (NaN is not nullish, so `?? 0` doesn't catch); `tFile.size = NaN` | `NaN !== anything` is `true` initially (would re-copy), but `Math.abs(NaN - x) > tol` is `false` → silent miss on subsequent syncs | mirror comparator |
| [d6dc4df](../../) `fix(syncer): use safeParseContentLength for mapping-source HEAD` | [syncer.ts:716](../../src/core/syncer.ts#L716) (pre-fix) same as c2bdf4a | same | applied to mapping-source HEAD path | mapping short-circuit comparator |

## Defensive pattern (mandatory for any external→internal coercion)

### Type check BEFORE coercion

```ts
// ❌ BAD: Number(null) === 0 (finite, passes) · Number('abc') === NaN (silent leak)
const size = Number(value ?? 0);

// ✅ GOOD: type check rejects null/undefined/string/NaN all at once
function safeParseSize(value: string | number | null | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`expected finite number, got ${JSON.stringify(value)}`);
  }
  return value;
}
```

See [`safeParseContentLength`](../../src/core/http-adapter.ts) for the canonical example.

### Throw, don't silently fix

When external data is malformed (HTTP header, JSON field, config value), **loud error** beats **silent fallback**. Silent fallback is what allowed all four bugs to land.

The two exceptions where fallback is OK:

- `null`/`undefined` (missing) → legal fallback (`?? 0`). Doesn't apply to "garbage value" — only to absence.
- HEAD probe (line 716) → warn + `size = 0` because HEAD is best-effort and mtime still works. Documented in [d6dc4df](../../).

### Use `??` for missing-not-broken distinction

```ts
const raw = res.headers.get('x-something');
// raw can be null (header absent) or string (present, possibly garbage)
const value = raw === null
  ? null                             // missing → legal fallback
  : safeParseSomething(raw);          // present → must validate, possibly throw
```

## Defense-in-depth sites (already verified)

These places looked unsafe but have upstream guards:

- **[swapper.ts:349, 392](../../src/core/swapper.ts#L349)** `parseInt(content.trim(), 10)` on `.swapping` mutex file content. → `isPidAlive` has `Number.isInteger(pid) || pid <= 0` guard at line 318, so `isPidAlive(NaN) === false → stale lock triggers self-heal`. Verified.
- **[cli.ts:81](../../src/core/cli.ts#L81)** `Number(argv[++i])` → explicit `Number.isNaN(v)` check + throw. Verified.
- **All `Number(lenMatch[1])` etc. in [parsers.ts](../../src/core/adapters/parsers.ts)** → capture is regex `(\d+)` bounded, NaN impossible. Verified.
- **`(lastErr?.code ?? 'unknown') as string`** in [swapper.ts:664, 801](../../src/core/swapper.ts#L664) → explicit `??` default applied to known-undefined target. Verified.
- **`as unknown as ReadableStream`** in [http-adapter.ts:66](../../src/core/http-adapter.ts#L66) and [webdav-adapter.ts:83, 102](../../src/core/webdav-adapter.ts#L83) → intentional double-cast to bypass DOM lib type. `Readable.fromWeb` accepts web stream regardless. Verified.

## How to extend this catalog

When you find a new instance of the pattern:

1. Add a row to the **four bugs** table above with: commit, module, coercion, outcome, comparator path
2. Verify the coercion is gone (or appropriately defense-layered)
3. Add a regression test that constructs the malformed input and asserts loud failure or correct fallback
4. Reference this doc from the round's postmortem

When you write new code that takes untyped data:

- Prefer the [`safeParseContentLength`](../../src/core/http-adapter.ts) pattern: explicit `?? null` for missing, explicit `Number.isFinite` for present-but-garbage, throw on garbage.
- If you find yourself reaching for `Number(x)` or `String(x)` as a validator, **don't** — reach for `typeof x === 'type' && Number.isFinite(x)` first.
- If you must accept coercion, leave a comment that explicitly names the upstream guard preventing silent NaN/0 leakage.

## Related

- Per-round postmortems in [docs/diagnostics/](../diagnostics/) preserve the chronological narrative
- Full audit table at [architecture-coercion-audit-2026-07-10.md](../diagnostics/architecture-coercion-audit-2026-07-10.md)
- Code review skill (`code-review` / `simplify`) should consult this when touching FileEntry/ResourceEntry constructions

## Verified state (2026-07-10)

```
421 tests pass, 0 skipped, 0 failed
4 sibling bugs caught and fixed
1 deferred follow-up (d6dc4df) — now also landed
6 review rounds complete
```
