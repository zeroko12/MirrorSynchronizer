/**
 * Focused repro: HttpAdapter.normalizeManifestEntry silently maps
 * JSON null → 0 because Number(null) === 0 (finite, passes Number.isFinite check).
 *
 * Source: a manifest entry like { relPath: "x.txt", size: 100, mtimeMs: null }
 * (e.g. server omitted timestamp)
 * Client receives → mtimeMs = 0 → entry is "valid"
 *   → file appears to have 1970-01-01 mtime
 *   → every sync: target mtime != 0, source = 0 → needsCopy = true
 *   → 永远 modified → re-copy 永远
 */

import { describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HttpAdapter } from '@core/http-adapter';

describe('REPRO: HttpAdapter normalizeManifestEntry null bug', () => {
  it('JSON null on mtimeMs becomes 0 (NOT null, NOT skipped)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mf-null-'));
    try {
      // Simulate what a server would send over the wire if it omits timestamp.
      // JSON.stringify({ mtimeMs: null }) → '{"mtimeMs":null}'
      // Client parses back to { mtimeMs: null }, then Number(null) = 0.
      const manifest = [
        { relPath: 'good.txt', size: 100, mtimeMs: 1700000000000 },
        { relPath: 'null-mtime.txt', size: 100, mtimeMs: null },
        { relPath: 'null-size.txt', size: null, mtimeMs: 1700000000000 },
      ];

      const server = createServer((req, res) => {
        if (req.url === '/.manifest.json') {
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(manifest));
        } else {
          res.statusCode = 404;
          res.end();
        }
      });
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      const port = (server.address() as { port: number }).port;

      const adapter = new HttpAdapter(`http://127.0.0.1:${port}/`);
      const entries = await adapter.scan();
      server.close();

      // Only good.txt should pass; null-* should be dropped.
      // Currently 3 entries return — null-* leaked through with bad mtime=0 / size=0.
      console.error('[REPRO] entries count:', entries.length);
      for (const e of entries) {
        console.error('[REPRO] entry:', e);
      }

      // Document the bug — entries count is 3, but should be 1.
      // The leaked entries have mtimeMs=0 and size=0 which would cause
      // perpetual re-copy (source mtime 0 != any target mtime).
      const leakNullMtime = entries.find((e) => e.relPath === 'null-mtime.txt');
      const leakNullSize = entries.find((e) => e.relPath === 'null-size.txt');

      console.error('[REPRO] null-mtime leaked?', leakNullMtime);
      console.error('[REPRO] null-size leaked?', leakNullSize);

      if (leakNullMtime || leakNullSize) {
        // Document the bug — observed behaviour
        expect(leakNullMtime, 'BUG: null mtimeMs not rejected').toBeUndefined();
        expect(leakNullSize, 'BUG: null size not rejected').toBeUndefined();
      } else {
        // Properly rejected
        expect(entries.length).toBe(1);
      }
      // Properly rejected: only good.txt passes.
      expect(entries.length, 'only good.txt should pass').toBe(1);
      expect(entries[0].relPath).toBe('good.txt');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
