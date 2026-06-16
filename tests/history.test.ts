/**
 * HistoryDB 测试
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { HistoryDB, defaultHistoryDbPath } from '../src/core/history.js';
import { makeTempDir, rmTemp } from './helpers.js';

// better-sqlite3 是 native binding,vitest 用系统 Node 跑,Electron 用自己的 Node
// 两边 NODE_MODULE_VERSION 可能不一样,加载失败时这套测试整组 skip
let nativeOk = true;
try {
  const tmp = await makeTempDir('hist-probe-');
  const probe = new HistoryDB(join(tmp, 'probe.db'));
  probe.close();
  await rmTemp(tmp);
} catch (e) {
  nativeOk = false;
  console.warn(`[skip] HistoryDB 测试跳过 — better-sqlite3 加载失败: ${(e as Error).message}`);
}

const runIf = nativeOk ? it : it.skip;

describe('HistoryDB', () => {
  let dir: string;
  let db: HistoryDB;

  beforeEach(async () => {
    dir = await makeTempDir('hist-');
    db = new HistoryDB(join(dir, 'test.db'));
  });

  afterEach(async () => {
    db.close();
    await rmTemp(dir);
  });

  runIf('init: 表已创建', () => {
    // 不抛错 = 成功
    const syncs = db.listSyncs();
    const backups = db.listBackups();
    expect(syncs).toEqual([]);
    expect(backups).toEqual([]);
  });

  runIf('recordSync + listSyncs', () => {
    const id = db.recordSync({
      startedAt: Date.now(),
      durationMs: 10,
      sourceDir: '/src',
      targetDir: '/tgt',
      addedCount: 1,
      modifiedCount: 2,
      deletedCount: 0,
      unchangedCount: 5,
      mappingCopiedCount: 0,
      mappingSkippedExistingCount: 0,
      mappingSkippedCount: 0,
      fatalError: null,
      backupId: null,
    });
    expect(id).toBeGreaterThan(0);

    const list = db.listSyncs();
    expect(list.length).toBe(1);
    expect(list[0].id).toBe(id);
    expect(list[0].sourceDir).toBe('/src');
    expect(list[0].addedCount).toBe(1);
    expect(list[0].modifiedCount).toBe(2);
  });

  runIf('listSyncs: 按 started_at 降序', () => {
    const t = Date.now();
    db.recordSync({
      startedAt: t - 1000,
      durationMs: 1,
      sourceDir: 'a',
      targetDir: 'a',
      addedCount: 0, modifiedCount: 0, deletedCount: 0, unchangedCount: 0,
      mappingCopiedCount: 0, mappingSkippedExistingCount: 0, mappingSkippedCount: 0,
      fatalError: null, backupId: null,
    });
    db.recordSync({
      startedAt: t,
      durationMs: 1,
      sourceDir: 'b',
      targetDir: 'b',
      addedCount: 0, modifiedCount: 0, deletedCount: 0, unchangedCount: 0,
      mappingCopiedCount: 0, mappingSkippedExistingCount: 0, mappingSkippedCount: 0,
      fatalError: null, backupId: null,
    });
    const list = db.listSyncs();
    expect(list[0].sourceDir).toBe('b');
    expect(list[1].sourceDir).toBe('a');
  });

  runIf('listSyncs: 分页', () => {
    for (let i = 0; i < 10; i++) {
      db.recordSync({
        startedAt: Date.now() - i * 1000,
        durationMs: 1,
        sourceDir: `s${i}`, targetDir: 't',
        addedCount: 0, modifiedCount: 0, deletedCount: 0, unchangedCount: 0,
        mappingCopiedCount: 0, mappingSkippedExistingCount: 0, mappingSkippedCount: 0,
        fatalError: null, backupId: null,
      });
    }
    expect(db.listSyncs(3, 0).length).toBe(3);
    expect(db.listSyncs(3, 0)[0].sourceDir).toBe('s0');
    expect(db.listSyncs(3, 3).length).toBe(3);
    expect(db.listSyncs(3, 3)[0].sourceDir).toBe('s3');
  });

  runIf('countSyncs', () => {
    expect(db.countSyncs()).toBe(0);
    db.recordSync({
      startedAt: Date.now(), durationMs: 1, sourceDir: 'a', targetDir: 'a',
      addedCount: 0, modifiedCount: 0, deletedCount: 0, unchangedCount: 0,
      mappingCopiedCount: 0, mappingSkippedExistingCount: 0, mappingSkippedCount: 0,
      fatalError: null, backupId: null,
    });
    expect(db.countSyncs()).toBe(1);
  });

  runIf('getSync: 根据 id 获取', () => {
    const id = db.recordSync({
      startedAt: Date.now(), durationMs: 1, sourceDir: 'x', targetDir: 'y',
      addedCount: 1, modifiedCount: 0, deletedCount: 0, unchangedCount: 0,
      mappingCopiedCount: 0, mappingSkippedExistingCount: 0, mappingSkippedCount: 0,
      fatalError: null, backupId: null,
    });
    const s = db.getSync(id);
    expect(s).not.toBeNull();
    expect(s!.addedCount).toBe(1);
    expect(db.getSync(999)).toBeNull();
  });

  runIf('recordBackup + listBackups', () => {
    const id = db.recordBackup({
      createdAt: Date.now(),
      sourceDir: '/src',
      targetDir: '/tgt',
      snapshotPath: '/backup/2026-06-12',
      fileCount: 5,
      sizeBytes: 1024,
    });
    expect(id).toBeGreaterThan(0);
    const list = db.listBackups();
    expect(list.length).toBe(1);
    expect(list[0].fileCount).toBe(5);
    expect(list[0].sizeBytes).toBe(1024);
  });

  runIf('recordSync 关联 backupId', () => {
    const bkId = db.recordBackup({
      createdAt: Date.now(), sourceDir: 's', targetDir: 't',
      snapshotPath: '/snap', fileCount: 0, sizeBytes: 0,
    });
    const syncId = db.recordSync({
      startedAt: Date.now(), durationMs: 1, sourceDir: 's', targetDir: 't',
      addedCount: 0, modifiedCount: 1, deletedCount: 0, unchangedCount: 0,
      mappingCopiedCount: 0, mappingSkippedExistingCount: 0, mappingSkippedCount: 0,
      fatalError: null, backupId: bkId,
    });
    const s = db.getSync(syncId);
    expect(s!.backupId).toBe(bkId);
  });

  runIf('deleteSync / deleteBackup', () => {
    const sId = db.recordSync({
      startedAt: Date.now(), durationMs: 1, sourceDir: 's', targetDir: 't',
      addedCount: 0, modifiedCount: 0, deletedCount: 0, unchangedCount: 0,
      mappingCopiedCount: 0, mappingSkippedExistingCount: 0, mappingSkippedCount: 0,
      fatalError: null, backupId: null,
    });
    db.deleteSync(sId);
    expect(db.getSync(sId)).toBeNull();

    const bId = db.recordBackup({
      createdAt: Date.now(), sourceDir: 's', targetDir: 't',
      snapshotPath: '/snap', fileCount: 0, sizeBytes: 0,
    });
    db.deleteBackup(bId);
    expect(db.getBackup(bId)).toBeNull();
  });
});

describe('defaultHistoryDbPath', () => {
  runIf('返回 userDataDir/history.db', () => {
    const result = defaultHistoryDbPath('C:/Users/x/AppData/Roaming/au');
    // 跨平台:用 path.join 构造期望值(Windows 用 \\, POSIX 用 /)
    const expected = join('C:/Users/x/AppData/Roaming/au', 'history.db');
    expect(result).toBe(expected);
  });
});
