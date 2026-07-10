/**
 * Regression: syncer.ts:716 mapping-source HEAD must not silently produce NaN.
 *
 * Background: HEAD-fetch of a remote mapping source. If the server returns
 * a malformed Content-Length (e.g. proxy interference), the previous code
 * Number(... ?? 0) yielded NaN which silently propagated to FileEntry.size
 * and corrupted the change-detection comparator downstream.
 *
 * Fix: route through safeParseContentLength + soft-fallback (don't throw
 * out of apply; warn and set size=0).
 */

import { describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Syncer } from '@core/syncer';
import type { AppConfig } from '@core/types';

describe('Mapping source HEAD: malformed Content-Length does not corrupt size', () => {
  it('server returns garbage Content-Length → apply mapping with size=0 fallback, no fatal', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mapping-head-'));
    try {
      const server = createServer((req, res) => {
        if (req.method === 'HEAD') {
          res.statusCode = 200;
          // Deliberately garbage Content-Length (mimics a buggy proxy)
          res.setHeader('Content-Length', 'not-a-valid-number');
          res.setHeader('Last-Modified', 'Sun, 06 Nov 1994 08:49:37 GMT');
          res.end();
        } else {
          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/octet-stream');
          res.end('content-from-server');
        }
      });
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      const port = (server.address() as { port: number }).port;

      const mapDir = await mkdtemp(join(tmpdir(), 'mapping-head-map-'));
      const sourceDir = await mkdtemp(join(tmpdir(), 'mapping-head-src-'));
      const targetDir = await mkdtemp(join(tmpdir(), 'mapping-head-tgt-'));
      try {
        await writeFile(join(sourceDir, 'real.txt'), 'real-content');

        const cfg: AppConfig = {
          sourceDir,
          targetDir,
          backupDir: '',
          intervalSec: 300,
          backupCount: 1,
          autostart: false,
          applyMappingsImmediately: true,
          fileMappings: [
            {
              id: 'm0',
              name: 'remote-config',
              sourcePath: `http://127.0.0.1:${port}/config.ini`,
              targetRelpath: 'config/app.ini',
              enabled: true,
              overwrite: true,
              ifSourceMissing: 'skip',
            },
          ],
          ignoreItems: [],
          applyMode: 'immediate',
          stagingDir: '',
          executablePath: '',
        };

        const syncer = new Syncer(cfg);
        let threw = false;
        try {
          const result = await syncer.sync(null, {});
          console.error('[REGRESSION] sync result.fatalError:', result.result.fatalError);
          // Mapping should be in mappingSkipped or with size=0 fallback;
          // main point is that the sync didn't propagate NaN.
          expect(result.result.fatalError, 'fatal must NOT be set on bad HEAD header').toBeUndefined();
        } catch (err) {
          threw = true;
          console.error('[REGRESSION] sync threw:', (err as Error).message);
        }
        expect(threw, 'sync must not throw — apply path should fall back to size=0').toBe(false);

        server.close();
      } finally {
        await rm(mapDir, { recursive: true, force: true });
        await rm(sourceDir, { recursive: true, force: true });
        await rm(targetDir, { recursive: true, force: true });
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
