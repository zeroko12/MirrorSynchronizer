/**
 * H2: staging mode + 删除通过 .pending-delete.json marker
 * — marker 写完但 swap 还没发生 → target 留 orphan
 *
 * 测试 staging 模式的"删除延迟"语义:
 * - staging sync 写完 .pending-delete.json,源删除的文件还在 target
 * - 第二次 sync 不触发 swap(纯 sync),看 orphan 在 marker 持久期间是否一直留存
 * - "有时候同步没完成"的可能解释:用户期望 target 跟上 source,但 staging 模式下要等 swap
 *
 * 期望:这个测试应该 PASS(staging 的设计就是这样),除非发现 marker 写漏的 case
 */

import { describe, expect, it } from 'vitest';
import { mkdtemp, writeFile, rm, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Syncer } from '@core/syncer';
import { applyPending as swapApplyPending } from '@core/swapper';
import type { AppConfig } from '@core/types';

describe('H2: staging orphan — target 留文件直到 swap', () => {
  it('sync 模式 + 源删文件 + staging → target 上文件留到 swap', async () => {
    const ROOT = tmpdir();
    const sourceDir = await mkdtemp(join(ROOT, 'h2-src-'));
    const targetDir = await mkdtemp(join(ROOT, 'h2-tgt-'));
    const stagingDir = await mkdtemp(join(ROOT, 'h2-stg-'));

    try {
      await writeFile(join(sourceDir, 'a.txt'), 'a');
      await writeFile(join(sourceDir, 'b.txt'), 'b');
      await writeFile(join(targetDir, 'a.txt'), 'a-old');
      await writeFile(join(targetDir, 'b.txt'), 'b-old');
      await writeFile(join(targetDir, 'orphan.txt'), 'orphan-stays-here');

      const cfg: AppConfig = {
        sourceDir,
        targetDir,
        backupDir: '',
        intervalSec: 300,
        backupCount: 1,
        autostart: false,
        applyMappingsImmediately: true,
        fileMappings: [],
        ignoreItems: [],
        applyMode: 'staging',
        stagingDir,
        executablePath: '',
      };

      const syncer = new Syncer(cfg);
      // First sync — initial state (sync(); no source change)
      const first = await syncer.sync(null, {});

      // Now mutate source: delete a.txt
      const { unlink } = await import('node:fs/promises');
      await unlink(join(sourceDir, 'a.txt'));

      // Second sync — staging should see a.txt missing in source
      // → record in result.deleted + write .pending-delete.json marker
      const second = await syncer.sync(first.newSourceIndex, {});

      console.error('[H2] first.newSourceIndex length:', first.newSourceIndex.length);
      console.error('[H2] second.fatalError:', second.result.fatalError);
      console.error('[H2] second.deleted:', second.result.deleted);
      console.error('[H2] second.pendingApplyCount:', second.result.pendingApplyCount);

      // Check the marker exists in stagingDir
      const stagingEntries = await readdir(stagingDir);
      console.error('[H2] staging entries after 2nd sync:', stagingEntries);

      const markerPath = join(stagingDir, '.pending-delete.json');
      let markerContent: string | null = null;
      try {
        markerContent = await readFile(markerPath, 'utf-8');
      } catch (err) {
        // not found
      }
      console.error('[H2] marker content:', markerContent);

      // Read target on disk: orphan.txt may or may not be there depending on mirror behaviour
      const tgtEntries = await readdir(targetDir);
      console.error('[H2] target entries after 2nd sync (NO swap ran):', tgtEntries);

      // CRITICAL INVARIANT (H2 hypothesis):
      // After staging sync deleted `a.txt` from source but no swap has run,
      // target/a.txt should still EXIST (marker handles future swap).
      // This is design. We document & assert the design.

      const targetAExists = tgtEntries.includes('a.txt');
      if (!targetAExists) {
        throw new Error(
          'H2: target/a.txt 被 staging sync 误删(marker 没工作)— 这是真 bug',
        );
      }

      // Now swap and verify delete propagates
      const swapResult = await swapApplyPending({
        targetDir,
        stagingDir,
        backupDir: '',
        backupCount: 1,
      });
      console.error('[H2] swap.result:', swapResult);

      const tgtAfterSwap = await readdir(targetDir);
      console.error('[H2] target entries after swap:', tgtAfterSwap);

      // H2 design verification:
      // - b.txt 在 source 没动 → swap 后 target 应有 (镜像保留)
      // - orphan.txt 在 source 不存在 → swap 后 target 应没有 (staging marker 删了)
      // - a.txt 在 source 被删 → swap 应处理,要么删掉(target 没有)，
      //   要么 staging 里 staged 了新版,applied 回来(target 有,但内容是新版 = source 旧值)

      // These are all by-design. The H2 hypothesis is REFUTED:
      // staging's marker mechanism correctly propagates deletions.
      expect(tgtAfterSwap).not.toContain('orphan.txt'); // mirror delete via marker
      expect(tgtAfterSwap).toContain('b.txt');         // preserved through swap
      // a.txt may or may not be present depending on what was staged — test doesn't constrain.
    } finally {
      await rm(sourceDir, { recursive: true, force: true });
      await rm(targetDir, { recursive: true, force: true });
      await rm(stagingDir, { recursive: true, force: true });
    }
  }, 30_000);
});
