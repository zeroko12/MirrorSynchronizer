/**
 * H3: applyMappingsOnly 不接 lastSourceIndex,可能与镜像 delete 集合不一致
 *
 * 具体场景:
 * - 已有映射规则从 source 写 target
 * - 调 applyMappingsOnly(用户保存映射规则时)→ 写 target
 * - 但 sync 的镜像逻辑独立于 applyMappingsOnly,可能因 ignoringItems / mappedTargetPaths
 *   未刷新而误判
 *
 * 测试矩阵:
 * (a) immediate 模式 + applyMappingsOnly → target 立即出现 file ✓ (设计预期)
 * (b) staging 模式 + applyMappingsOnly → 写 staging,target 不动 ⚠ (用户期望"立即")
 * (c) staging + applyMappingsOnly + 后续 sync 不 swap → target 仍没有 ⚠
 * (d) immediate + 同名文件被映射规则 overwrite → 与镜像冲突?
 *
 * (b)(c) 可能是用户报告的"UI 上看没同步"的真正来源
 */

import { describe, it } from 'vitest';
import { mkdtemp, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Syncer } from '@core/syncer';
import type { AppConfig } from '@core/types';

describe('H3: applyMappingsOnly 写入位置 vs 用户期望', () => {
  it('(b)(c) staging 模式下 applyMappingsOnly 写到 stagingDir,targetDir 上不出现', async () => {
    const ROOT = tmpdir();
    const sourceDir = await mkdtemp(join(ROOT, 'h3-src-'));
    const targetDir = await mkdtemp(join(ROOT, 'h3-tgt-'));
    const stagingDir = await mkdtemp(join(ROOT, 'h3-stg-'));
    const mapDir = await mkdtemp(join(ROOT, 'h3-map-'));

    try {
      await writeFile(join(sourceDir, 'data.txt'), 'data'); // a normal source file
      await writeFile(join(mapDir, 'config.ini'), 'config-content'); // mapping source

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
            id: 'm1',
            name: 'my-mapping',
            sourcePath: join(mapDir, 'config.ini'),
            targetRelpath: 'config/app.ini',
            enabled: true,
            overwrite: true,
            ifSourceMissing: 'skip',
          },
        ],
        ignoreItems: [],
        applyMode: 'staging',
        stagingDir,
        executablePath: '',
      };

      const syncer = new Syncer(cfg);

      // 调 applyMappingsOnly — 用户在 UI 点"立即应用"映射规则
      const applyResult = await syncer.applyMappingsOnly();
      console.error('[H3-b] applyMappingsOnly result.fatalError:', applyResult.fatalError);
      console.error('[H3-b] applyMappingsOnly result.mappingCopied:', applyResult.mappingCopied);
      console.error('[H3-b] applyMappingsOnly result.pendingApplyCount:', applyResult.pendingApplyCount);

      const targetEntries = await readdir(targetDir);
      const stagingEntries = await readdir(stagingDir);
      console.error('[H3-b] target entries:', targetEntries);
      console.error('[H3-b] staging entries:', stagingEntries);

      const targetHasConfig = targetEntries.includes('config');
      const stagingHasConfig = stagingEntries.includes('config');

      // ★ Question: 在 staging 模式下,用户点"立即应用"按钮 → 文件应在哪里?
      // 如果 applyMode=staging + 走 applyMappingsOnly → 写到 stagingDir(target 看不到)
      // User confusion: "我点了立即应用,为什么 target 还没出现?"

      // We document this as expected-by-design vs expected-by-user.
      // If expected-by-user (target 应有 config/),this is a UX bug.

      // For now, simply log the behavior so we can discuss with the user.
      void targetHasConfig;
      void stagingHasConfig;

      // (d) Now run actual sync — should sync data.txt AND trigger swap due to pendingApplyCount > 0
      const syncResult = await syncer.sync(null, {});
      console.error('[H3-c] sync.modified:', syncResult.result.modified);
      console.error('[H3-c] sync.added:', syncResult.result.added);

      const targetEntriesAfterSync = await readdir(targetDir);
      console.error('[H3-c] target entries after sync:', targetEntriesAfterSync);

      // (d) Immediate mode equivalent
      const targetDir2 = await mkdtemp(join(ROOT, 'h3-tgt-imm-'));
      const stagingDir2 = await mkdtemp(join(ROOT, 'h3-stg-imm-'));
      const cfg2 = { ...cfg, targetDir: targetDir2, stagingDir: stagingDir2, applyMode: 'immediate' as const };
      try {
        const syncer2 = new Syncer(cfg2);
        const applyResult2 = await syncer2.applyMappingsOnly();
        const targetEntries2 = await readdir(targetDir2);
        console.error('[H3-d] IMMEDIATE mode applyMappingsOnly target entries:', targetEntries2);
        console.error('[H3-d] IMMEDIATE mode applyMappingsOnly mappingCopied:', applyResult2.mappingCopied);

        if (!targetEntries2.includes('config')) {
          throw new Error(
            'H3-d: immediate 模式 applyMappingsOnly 没在 target 创建 config/',
          );
        }
      } finally {
        await rm(targetDir2, { recursive: true, force: true });
        await rm(stagingDir2, { recursive: true, force: true });
      }

      // (b)(c) explicit assertion: in staging mode without swap, target should NOT have the file.
      // This is by design but should be acknowledged by user — log only.
      console.error('[H3-b] SUMMARY: staging + applyMappingsOnly + 无 swap = target 不出现(设计)');
      console.error('[H3-b] SUMMARY: 但 UX 上如果用户期望立即,这就是 confusing 源');
    } finally {
      await rm(sourceDir, { recursive: true, force: true });
      await rm(targetDir, { recursive: true, force: true });
      await rm(stagingDir, { recursive: true, force: true });
      await rm(mapDir, { recursive: true, force: true });
    }
  }, 30_000);
});
