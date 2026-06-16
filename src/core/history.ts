/**
 * HistoryDB - 同步历史 + 备份历史(SQLite)
 *
 * 两张表:
 *   sync_history: 每次同步的记录
 *   backups:      每次创建的备份
 * 关系: sync_history.backup_id → backups.id(可选,只有改了/删了时才有备份)
 *
 * 数据库位置: <userData>/history.db
 * 使用 better-sqlite3(synchronous, 适合 Electron 主进程的 IPC handler)
 */

import Database, { type Database as DatabaseT } from 'better-sqlite3';
import { join, dirname } from 'node:path';
import { promises as fs } from 'node:fs';

export interface SyncHistoryEntry {
  id: number;
  startedAt: number;
  durationMs: number;
  sourceDir: string;
  targetDir: string;
  addedCount: number;
  modifiedCount: number;
  deletedCount: number;
  unchangedCount: number;
  mappingCopiedCount: number;
  mappingSkippedExistingCount: number;
  mappingSkippedCount: number;
  fatalError: string | null;
  backupId: number | null;
}

export interface BackupHistoryEntry {
  id: number;
  createdAt: number;
  sourceDir: string;
  targetDir: string;
  snapshotPath: string;
  fileCount: number;
  sizeBytes: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sync_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  source_dir TEXT NOT NULL,
  target_dir TEXT NOT NULL,
  added_count INTEGER NOT NULL DEFAULT 0,
  modified_count INTEGER NOT NULL DEFAULT 0,
  deleted_count INTEGER NOT NULL DEFAULT 0,
  unchanged_count INTEGER NOT NULL DEFAULT 0,
  mapping_copied_count INTEGER NOT NULL DEFAULT 0,
  mapping_skipped_existing_count INTEGER NOT NULL DEFAULT 0,
  mapping_skipped_count INTEGER NOT NULL DEFAULT 0,
  fatal_error TEXT,
  backup_id INTEGER
);
CREATE INDEX IF NOT EXISTS idx_sync_started ON sync_history(started_at DESC);

CREATE TABLE IF NOT EXISTS backups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at INTEGER NOT NULL,
  source_dir TEXT NOT NULL,
  target_dir TEXT NOT NULL,
  snapshot_path TEXT NOT NULL,
  file_count INTEGER NOT NULL DEFAULT 0,
  size_bytes INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_backup_created ON backups(created_at DESC);
`;

export interface RecordSyncInput {
  startedAt: number;
  durationMs: number;
  sourceDir: string;
  targetDir: string;
  addedCount: number;
  modifiedCount: number;
  deletedCount: number;
  unchangedCount: number;
  mappingCopiedCount: number;
  mappingSkippedExistingCount: number;
  mappingSkippedCount: number;
  fatalError: string | null;
  backupId?: number | null;
}

export interface RecordBackupInput {
  createdAt: number;
  sourceDir: string;
  targetDir: string;
  snapshotPath: string;
  fileCount: number;
  sizeBytes: number;
}

export class HistoryDB {
  private db: DatabaseT;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  recordSync(input: RecordSyncInput): number {
    const stmt = this.db.prepare(`
      INSERT INTO sync_history (
        started_at, duration_ms, source_dir, target_dir,
        added_count, modified_count, deleted_count, unchanged_count,
        mapping_copied_count, mapping_skipped_existing_count, mapping_skipped_count,
        fatal_error, backup_id
      ) VALUES (
        @started_at, @duration_ms, @source_dir, @target_dir,
        @added_count, @modified_count, @deleted_count, @unchanged_count,
        @mapping_copied_count, @mapping_skipped_existing_count, @mapping_skipped_count,
        @fatal_error, @backup_id
      )
    `);
    const info = stmt.run({
      started_at: input.startedAt,
      duration_ms: input.durationMs,
      source_dir: input.sourceDir,
      target_dir: input.targetDir,
      added_count: input.addedCount,
      modified_count: input.modifiedCount,
      deleted_count: input.deletedCount,
      unchanged_count: input.unchangedCount,
      mapping_copied_count: input.mappingCopiedCount,
      mapping_skipped_existing_count: input.mappingSkippedExistingCount,
      mapping_skipped_count: input.mappingSkippedCount,
      fatal_error: input.fatalError,
      backup_id: input.backupId ?? null,
    });
    return Number(info.lastInsertRowid);
  }

  recordBackup(input: RecordBackupInput): number {
    const stmt = this.db.prepare(`
      INSERT INTO backups (
        created_at, source_dir, target_dir, snapshot_path, file_count, size_bytes
      ) VALUES (
        @created_at, @source_dir, @target_dir, @snapshot_path, @file_count, @size_bytes
      )
    `);
    const info = stmt.run({
      created_at: input.createdAt,
      source_dir: input.sourceDir,
      target_dir: input.targetDir,
      snapshot_path: input.snapshotPath,
      file_count: input.fileCount,
      size_bytes: input.sizeBytes,
    });
    return Number(info.lastInsertRowid);
  }

  listSyncs(limit = 50, offset = 0): SyncHistoryEntry[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM sync_history ORDER BY started_at DESC LIMIT ? OFFSET ?`,
      )
      .all(limit, offset) as Array<Record<string, unknown>>;
    return rows.map(rowToSync);
  }

  countSyncs(): number {
    const row = this.db.prepare(`SELECT COUNT(*) as n FROM sync_history`).get() as { n: number };
    return row.n;
  }

  getSync(id: number): SyncHistoryEntry | null {
    const row = this.db
      .prepare(`SELECT * FROM sync_history WHERE id = ?`)
      .get(id) as Record<string, unknown> | undefined;
    return row ? rowToSync(row) : null;
  }

  listBackups(): BackupHistoryEntry[] {
    const rows = this.db
      .prepare(`SELECT * FROM backups ORDER BY created_at DESC`)
      .all() as Array<Record<string, unknown>>;
    return rows.map(rowToBackup);
  }

  getBackup(id: number): BackupHistoryEntry | null {
    const row = this.db
      .prepare(`SELECT * FROM backups WHERE id = ?`)
      .get(id) as Record<string, unknown> | undefined;
    return row ? rowToBackup(row) : null;
  }

  deleteSync(id: number): void {
    this.db.prepare(`DELETE FROM sync_history WHERE id = ?`).run(id);
  }

  deleteBackup(id: number): void {
    this.db.prepare(`DELETE FROM backups WHERE id = ?`).run(id);
  }
}

function rowToSync(row: Record<string, unknown>): SyncHistoryEntry {
  return {
    id: row.id as number,
    startedAt: row.started_at as number,
    durationMs: row.duration_ms as number,
    sourceDir: row.source_dir as string,
    targetDir: row.target_dir as string,
    addedCount: row.added_count as number,
    modifiedCount: row.modified_count as number,
    deletedCount: row.deleted_count as number,
    unchangedCount: row.unchanged_count as number,
    mappingCopiedCount: row.mapping_copied_count as number,
    mappingSkippedExistingCount: row.mapping_skipped_existing_count as number,
    mappingSkippedCount: row.mapping_skipped_count as number,
    fatalError: (row.fatal_error as string | null) ?? null,
    backupId: (row.backup_id as number | null) ?? null,
  };
}

function rowToBackup(row: Record<string, unknown>): BackupHistoryEntry {
  return {
    id: row.id as number,
    createdAt: row.created_at as number,
    sourceDir: row.source_dir as string,
    targetDir: row.target_dir as string,
    snapshotPath: row.snapshot_path as string,
    fileCount: row.file_count as number,
    sizeBytes: row.size_bytes as number,
  };
}

/**
 * 工具:获取 history.db 路径(默认 userData 下)
 */
export function defaultHistoryDbPath(userDataDir: string): string {
  return join(userDataDir, 'history.db');
}

/** 异步确保父目录存在(初始化用) */
export async function ensureHistoryDir(dbPath: string): Promise<void> {
  await fs.mkdir(dirname(dbPath), { recursive: true });
}
