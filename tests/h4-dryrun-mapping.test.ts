/**
 * H4: sync(dryRun=true) 是否会让映射规则真实写盘?
 *
 * 看 src/core/syncer.ts L580-582:
 *   for (const mapping of fileMappings) {
 *     if (!mapping.enabled) continue;
 *     await this.applyMapping(mapping, targetMap, result, false, writeDir);
 *   }
 *   // 第四个参数是 dryRun=false,统一实写
 *
 * 设计意图(注释):映射不参与 dryRun,因为映射是"用户主动配的,始终保持",
 * 即便弹窗模式开启,映射也应该立即生效。
 *
 * 测试:确认这个行为是否符合预期
 * - dryRun sync → 映射规则真实写盘(target 文件出现)
 * - 用户可能没意识到:弹窗"应用?/忽略?/暂休?"决策中,如果他们点"暂休",
 *   镜像不写盘,但映射规则偷偷写了 — 行为不一致
 */

import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, writeFile, rm, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Syncer } from '@core/syncer';
import type { AppConfig } from '@core/types';

describe('H4: dryRun sync 中映射规则的写盘行为', () => {
  it('dryRun sync 也会真实写 mapping(target 上出现)', async () => {
    const ROOT = tmpdir();
    const sourceDir = await mkdtemp(join(ROOT, 'h4-src-'));
    const targetDir = await mkdtemp(join(ROOT, 'h4-tgt-'));
    const mapDir = await mkdtemp(join(ROOT, 'h4-map-'));

    try {
      await writeFile(join(sourceDir, 'data.txt'), 'data');
      await writeFile(join(mapDir, 'config.ini'), 'config-content');

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
        applyMode: 'immediate',
        stagingDir: '',
        executablePath: '',
      };

      const syncer = new Syncer(cfg);

      const dryrunResult = await syncer.sync(null, { dryRun: true });
      console.error('[H4] dryRun.mappingCopied:', dryrunResult.result.mappingCopied);
      console.error('[H4] dryRun.added (镜像):', dryrunResult.result.added);
      console.error('[H4] dryRun.fatalError:', dryrunResult.result.fatalError);

      const targetEntries = await readdir(targetDir);
      console.error('[H4] target entries after dryRun sync:', targetEntries);

      // Document the actual behavior. The code intentionally writes mapping even in dryRun.
      // This means: if UI uses dryRun to "preview" changes, mapping rules are silently applied.
      const targetHasConfig = targetEntries.includes('config');

      // Note: dryRun=true still wrote mapping → content was applied
      if (targetHasConfig) {
        const cfgPath = join(targetDir, 'config', 'app.ini');
        const writtenContent = await readFile(cfgPath, 'utf-8');
        console.error('[H4] dryRun sync 实际写盘 content:', writtenContent);

        if (writtenContent === 'config-content') {
          console.error('[H4] CONFIRMED: dryRun sync 让 mapping 真实写盘(target 上有 config/app.ini)');
          console.error('[H4] 这是设计(syncer.ts L578-579 注释明说),但如果 UI 用 dryRun 做"预览"会让用户困惑');
        }
      }

      // No assertion here — just documenting observed behavior.
    } finally {
      await rm(sourceDir, { recursive: true, force: true });
      await rm(targetDir, { recursive: true, force: true });
      await rm(mapDir, { recursive: true, force: true });
    }
  }, 30_000);
});
