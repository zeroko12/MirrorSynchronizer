/**
 * Regression tests for safeParseContentLength helper.
 *
 * Background: previous `Number(res.headers.get('content-length') ?? 0)`
 * silently leaked NaN into FileEntry.size when a buggy/misconfigured server
 * sent a malformed Content-Length header. NaN size would corrupt the
 * needsCopy comparator in syncer (NaN - anything = NaN, which fails the
 * > tolerance comparison → 'unchanged' → perpetual silent miss).
 *
 * Regression points:
 * 1. Missing header → 0 (legal: chunked transfer)
 * 2. Valid integer string → number
 * 3. Malformed string ("abc", "100abc", "12.5.6") → throw, don't silently 0
 * 4. Negative string → throw (server broken)
 * 5. Server integration: a real HTTP server with bad Content-Length causes
 *    openConditional to throw, propagates up to scan consumers as a fatal
 */

import { describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { safeParseContentLength } from '@core/http-adapter';
import { HttpAdapter } from '@core/http-adapter';
import { WebDAVAdapter } from '@core/webdav-adapter';

describe('safeParseContentLength: boundary cases', () => {
  it('null → 0 (chunked transfer)', () => {
    expect(safeParseContentLength(null)).toBe(0);
  });
  it('empty string → 0', () => {
    expect(safeParseContentLength('')).toBe(0);
  });
  it('valid decimal integer', () => {
    expect(safeParseContentLength('12345')).toBe(12345);
  });
  it('valid 0', () => {
    expect(safeParseContentLength('0')).toBe(0);
  });
  it('malformed string → throw', () => {
    expect(() => safeParseContentLength('abc')).toThrow();
    expect(() => safeParseContentLength('100abc')).toThrow();
    expect(() => safeParseContentLength('12.5.6')).toThrow();
  });
  it('negative → throw', () => {
    expect(() => safeParseContentLength('-1')).toThrow();
  });
  it('whitespace-only → 0', () => {
    // Whitespace stringified is `Number('')` which is 0, but our policy treats
    // any non-empty string as a server claim — number 0 is fine.
    // Actually whitespace string is not null/empty, so it goes to Number('   ') = 0 (parseable as 0).
    // That's surprising but consistent: a missing-but-server-set empty header → 0.
    expect(safeParseContentLength('  ')).toBe(0);
  });
});

describe('HttpAdapter integration: malformed Content-Length causes fatal, not silent 0', () => {
  it('openConditional throws when server sends bad Content-Length (does NOT silently set size=NaN)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cl-bad-'));
    try {
      const server = createServer((req, res) => {
        if (req.url === '/.manifest.json') {
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify([
            { relPath: 'file.txt', size: 100, mtimeMs: 1700000000000 },
          ]));
        } else {
          res.statusCode = 200;
          // deliberately malformed Content-Length: not a number
          res.setHeader('Content-Length', 'definitely-not-a-number');
          res.setHeader('Last-Modified', 'Sun, 06 Nov 1994 08:49:37 GMT');
          res.setHeader('ETag', '"v1"');
          res.end('hello');
        }
      });
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      const port = (server.address() as { port: number }).port;

      const adapter = new HttpAdapter(`http://127.0.0.1:${port}/`);

      // scan should succeed (manifest mode)
      const entries = await adapter.scan();
      expect(entries.length).toBe(1);

      // openConditional should throw instead of returning size=NaN
      let threw = false;
      try {
        await adapter.openConditional('file.txt', '"stale"');
      } catch (err) {
        threw = true;
        console.error('[REGRESSION] thrown as expected:', (err as Error).message);
      }
      expect(threw, 'openConditional must throw on malformed Content-Length, not return NaN size').toBe(true);

      server.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
