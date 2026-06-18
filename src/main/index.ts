/**
 * Electron 主进程入口
 *
 * 职责:bootstrap + wire-up
 * - 加载配置 / history / state
 * - 启动 BrowserWindow + Tray + Scheduler
 * - 注册 IPC handler(所有 25 个通道)
 * - 管理生命周期
 *
 * 业务逻辑已拆到 ./services/* 模块
 */

import electron from 'electron';
import { existsSync, promises as fs } from 'node:fs';
import { join } from 'node:path';
import { ConfigManager, DEFAULT_CONFIG } from '../core/config.js';
import { Scheduler } from '../core/scheduler.js';
import { Syncer } from '../core/syncer.js';
import { Backupper } from '../core/backupper.js';
import { HistoryDB, ensureHistoryDir } from '../core/history.js';
import { Indexer } from '../core/indexer.js';
import { StateManager } from '../core/state.js';
import { mainLog } from '../core/logger.js';
import { SOURCE_TEST_SAMPLE_SIZE, SOURCE_TEST_TIMEOUT_MS } from '../core/constants.js';
import { pickAdapter, type SourceAdapter } from '../core/adapter.js';
import { classifyFetchError, classifyHttpStatus, type PathErrorKind } from '../core/errors.js';
import type { AppConfig } from '../core/types.js';
import { getConfigPath, getHistoryDbPath, getIndexCachePath, getStatePath } from './services/paths.js';
import { createWindow, getMainWindow } from './services/window.js';
import { createTray } from './services/tray.js';
import { handleUserDecision } from './services/user-decision.js';
import { buildOnSyncHandler } from './services/scheduler-events.js';
import { scanWithTimeout } from './services/scan-timeout.js';

const log = mainLog;
const { app, BrowserWindow, dialog, ipcMain } = electron;

let currentConfig: AppConfig | null = null;
let historyDB: HistoryDB | null = null;
let stateMgr: StateManager | null = null;
let scheduler: Scheduler | null = null;
const backupper = new Backupper();

async function ensureConfig(): Promise<AppConfig> {
  const cfgPath = getConfigPath();
  const mgr = new ConfigManager({ configPath: cfgPath, defaults: DEFAULT_CONFIG });
  if (!existsSync(cfgPath)) {
    await mgr.save(DEFAULT_CONFIG);
  }
  return mgr.load();
}

/* ============================ IPC handlers ============================ */

function registerIpc(): void {
  // P1: 状态查询
  ipcMain.handle('status:get', () => {
    const status = scheduler?.getStatus();
    return {
      sourceDir: currentConfig?.sourceDir ?? '',
      targetDir: currentConfig?.targetDir ?? '',
      backupDir: currentConfig?.backupDir ?? '',
      intervalSec: currentConfig?.intervalSec ?? 0,
      backupCount: currentConfig?.backupCount ?? 0,
      autostart: currentConfig?.autostart ?? false,
      fileMappings: currentConfig?.fileMappings ?? [],
      running: status?.running ?? false,
      consecutiveNetworkFailures: status?.consecutiveNetworkFailures ?? 0,
      nextRunDelayMs: status?.nextRunDelayMs ?? null,
      lastFatalReason: status?.lastFatalReason ?? null,
      lastResult: status?.lastResult
        ? {
            added: status.lastResult.added.length,
            modified: status.lastResult.modified.length,
            deleted: status.lastResult.deleted.length,
            durationMs: status.lastResult.durationMs,
            ok: status.lastResult.ok,
            fatalReason: status.lastResult.fatalReason ?? null,
          }
        : null,
    };
  });

  ipcMain.handle('sync:runNow', async () => {
    if (!scheduler) return { ok: false, error: 'scheduler not ready' };
    const result = await scheduler.runNow();
    return { ok: true, result };
  });

  // P2: 完整配置读写
  ipcMain.handle('config:load', async (): Promise<AppConfig> => {
    if (!currentConfig) throw new Error('config not initialized');
    return currentConfig;
  });

  ipcMain.handle('config:save', async (_e, cfg: AppConfig) => {
    const mgr = new ConfigManager({
      configPath: getConfigPath(),
      defaults: DEFAULT_CONFIG,
    });
    try {
      await mgr.save(cfg);
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
    currentConfig = cfg;
    if (scheduler) scheduler.updateConfig(cfg);
    return { ok: true };
  });

  // P2: 原生文件夹选择对话框
  ipcMain.handle('dialog:selectFolder', async (_e, defaultPath?: string) => {
    const w = getMainWindow();
    if (!w) return { canceled: true, path: null };
    const result = await dialog.showOpenDialog(w, {
      title: '选择文件夹',
      defaultPath: defaultPath || undefined,
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return { canceled: true, path: null };
    }
    return { canceled: false, path: result.filePaths[0] };
  });

  // P5: 选文件 / 选目录
  ipcMain.handle(
    'dialog:selectPath',
    async (_e, opts: { defaultPath?: string; mode: 'file' | 'folder' | 'both' }) => {
      const w = getMainWindow();
      if (!w) return { canceled: true, path: null, isDirectory: false };
      const properties: Array<'openFile' | 'openDirectory' | 'createDirectory'> = [];
      if (opts.mode === 'file') properties.push('openFile');
      else if (opts.mode === 'folder') properties.push('openDirectory', 'createDirectory');
      else properties.push('openFile', 'openDirectory');
      const result = await dialog.showOpenDialog(w, {
        title: opts.mode === 'file' ? '选择文件' : opts.mode === 'folder' ? '选择文件夹' : '选择文件或文件夹',
        defaultPath: opts.defaultPath || undefined,
        properties,
      });
      if (result.canceled || result.filePaths.length === 0) {
        return { canceled: true, path: null, isDirectory: false };
      }
      const picked = result.filePaths[0];
      try {
        const st = await fs.stat(picked);
        return { canceled: false, path: picked, isDirectory: st.isDirectory() };
      } catch {
        return { canceled: false, path: picked, isDirectory: false };
      }
    },
  );

  // 调试:扫描源/目标文件数
  ipcMain.handle('debug:countFiles', async () => {
    if (!currentConfig) return { source: 0, target: 0, error: 'no config' };
    const idx = new Indexer();
    const src = await idx.scan(currentConfig.sourceDir);
    const tgt = await idx.scan(currentConfig.targetDir);
    return {
      source: src.fatal ? 0 : src.files.length,
      target: tgt.fatal ? 0 : tgt.files.length,
      sourcePath: currentConfig.sourceDir,
      targetPath: currentConfig.targetDir,
      sourceFatal: src.fatal,
      targetFatal: tgt.fatal,
    };
  });

  // P3: 历史
  ipcMain.handle('history:list', async (_e, opts: { limit?: number; offset?: number } = {}) => {
    if (!historyDB) return { items: [], total: 0 };
    const items = historyDB.listSyncs(opts.limit ?? 50, opts.offset ?? 0);
    const total = historyDB.countSyncs();
    return { items, total };
  });

  ipcMain.handle('history:delete', async (_e, id: number) => {
    if (!historyDB) return { ok: false, error: 'db not ready' };
    historyDB.deleteSync(id);
    return { ok: true };
  });

  // P3: 备份
  ipcMain.handle('backup:list', async () => {
    if (!historyDB) return [];
    if (!currentConfig) return historyDB.listBackups();
    const backupDir = currentConfig.backupDir || backupper.resolveBackupDir(currentConfig.targetDir);
    const fsBackups = await backupper.list(backupDir);
    const dbBackups = historyDB.listBackups();
    const dbPaths = new Set(dbBackups.map((b) => b.snapshotPath));

    for (const f of fsBackups) {
      if (!dbPaths.has(f.path)) {
        log.info(`[backup:list] 补登记冷启动备份: ${f.path}`);
        historyDB.recordBackup({
          createdAt: f.createdAt,
          sourceDir: currentConfig.sourceDir,
          targetDir: currentConfig.targetDir,
          snapshotPath: f.path,
          fileCount: f.fileCount,
          sizeBytes: f.sizeBytes,
        });
      }
    }

    const allBackups = historyDB.listBackups();
    return allBackups.map((b) => {
      const live = fsBackups.find((f) => f.path === b.snapshotPath);
      if (live) return { ...b, sizeBytes: live.sizeBytes, fileCount: live.fileCount };
      return { ...b, _stale: true };
    });
  });

  ipcMain.handle('backup:rollback', async (_e, id: number) => {
    if (!historyDB) return { ok: false, error: 'db not ready' };
    const b = historyDB.getBackup(id);
    if (!b) return { ok: false, error: '备份不存在' };
    try {
      log.info(`[rollback] 尝试回退 #${id}:`);
      log.info(`[rollback]   snapshotPath = ${b.snapshotPath}`);
      log.info(`[rollback]   targetDir   = ${b.targetDir}`);
      log.info(`[rollback]   existsSync  = ${existsSync(b.snapshotPath)}`);
      if (!existsSync(b.snapshotPath)) {
        const parent = b.snapshotPath.split(/[\\/]/).slice(0, -1).join('\\');
        try {
          const siblings = await fs.readdir(parent);
          log.info(`[rollback]   backupDir 实际内容: ${siblings.join(', ')}`);
        } catch (e) {
          log.info(`[rollback]   无法列出 ${parent}: ${(e as Error).message}`);
        }
        return { ok: false, error: `快照文件不存在: ${b.snapshotPath}\n(可能已被人手动删除,或 backupDir 配置变了)` };
      }
      const safetyBackup = await backupper.createSnapshot(
        b.targetDir,
        currentConfig?.backupDir || undefined,
      );
      log.info(`[rollback] 回退前安全快照: ${safetyBackup.path}`);
      await backupper.rollback(b.snapshotPath, b.targetDir);
      log.info(`[rollback] 已回退到 ${b.snapshotPath}`);
      if (scheduler) {
        scheduler.updateConfig(currentConfig!);
        const indexCache = join(getIndexCachePath());
        try {
          await fs.unlink(indexCache);
          log.info(`[rollback] 已清 index-cache,下次 sync 重建`);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
            log.warn(`[rollback] 清 index-cache 失败(非致命): ${(e as Error).message}`);
          }
        }
      }
      return { ok: true, safetySnapshotPath: safetyBackup.path };
    } catch (err) {
      log.error(`[rollback] 失败:`, err);
      return { ok: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('backup:delete', async (_e, id: number) => {
    if (!historyDB) return { ok: false, error: 'db not ready' };
    const b = historyDB.getBackup(id);
    if (!b) return { ok: false, error: '备份不存在' };
    try {
      await backupper.deleteSnapshot(b.snapshotPath);
      historyDB.deleteBackup(id);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  // P4: 用户弹窗决策
  ipcMain.handle('user:decide', async (_e, action: 'apply' | 'snooze' | 'ignore', hash: string) => {
    await handleUserDecision(stateMgr, scheduler, action, hash);
    return { ok: true };
  });

  // P4: 运行时状态
  ipcMain.handle('state:get', async () => {
    if (!stateMgr) return null;
    return stateMgr.load();
  });

  ipcMain.handle('state:setPopupEnabled', async (_e, enabled: boolean) => {
    if (!stateMgr) return { ok: false, error: 'state not ready' };
    await stateMgr.update({ popupEnabled: enabled });
    if (scheduler) scheduler.setDryRunMode(enabled);
    return { ok: true };
  });

  // P5: 开机自启动
  ipcMain.handle('autostart:get', () => {
    const openAtLogin = app.getLoginItemSettings().openAtLogin;
    return { openAtLogin };
  });

  ipcMain.handle('autostart:set', (_e, enabled: boolean) => {
    try {
      app.setLoginItemSettings({ openAtLogin: enabled });
      return { ok: true, openAtLogin: enabled };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  // P5: 立即应用所有映射
  ipcMain.handle('mappings:applyAll', async () => {
    if (!currentConfig) return { ok: false, error: 'config not ready' };
    const syncer = new Syncer(currentConfig);
    const result = await syncer.applyMappingsOnly();
    if (historyDB && result.ok) {
      const syncId = historyDB.recordSync({
        startedAt: result.startedAt,
        durationMs: result.durationMs,
        sourceDir: '(映射模式)',
        targetDir: currentConfig.targetDir,
        addedCount: 0,
        modifiedCount: 0,
        deletedCount: 0,
        unchangedCount: 0,
        mappingCopiedCount: result.mappingCopied.length,
        mappingSkippedExistingCount: result.mappingSkippedExisting.length,
        mappingSkippedCount: result.mappingSkipped.length,
        fatalError: null,
        backupId: null,
      });
      log.info(`[mappings:applyAll] 完成,映射已拷 ${result.mappingCopied.length},跳过 ${result.mappingSkippedExisting.length},历史 #${syncId}`);
    }
    return {
      ok: result.ok,
      mappingCopied: result.mappingCopied,
      mappingSkippedExisting: result.mappingSkippedExisting,
      mappingSkipped: result.mappingSkipped,
      warnings: result.warnings,
      error: result.fatalError,
    };
  });

  ipcMain.handle('mappings:testOne', async (_e, mappingId: string) => {
    if (!currentConfig) return { ok: false, error: 'config not ready' };
    const m = currentConfig.fileMappings.find((x) => x.id === mappingId);
    if (!m) return { ok: false, error: '规则不存在' };
    const testMapping = { ...m, enabled: true };
    const testConfig = {
      ...currentConfig,
      fileMappings: currentConfig.fileMappings.map((x) => (x.id === mappingId ? testMapping : x)),
    };
    const syncer = new Syncer(testConfig);
    const result = await syncer.applyMappingsOnly();
    return {
      ok: result.ok,
      mappingCopied: result.mappingCopied,
      mappingSkippedExisting: result.mappingSkippedExisting,
      mappingSkipped: result.mappingSkipped,
      warnings: result.warnings,
      error: result.fatalError,
    };
  });

  // 源测试(只读,不改 config)
  ipcMain.handle('source:test', async (_e, source: string) => {
    const startedAt = Date.now();
    if (!source || !source.trim()) {
      return { ok: false, error: '源路径为空', fatalReason: 'not-found', durationMs: 0 };
    }
    const trimmed = source.trim();

    let adapter: SourceAdapter;
    try {
      adapter = pickAdapter(trimmed);
    } catch (err) {
      return {
        ok: false,
        error: `无效的源路径: ${(err as Error).message}`,
        fatalReason: 'not-found',
        durationMs: Date.now() - startedAt,
      };
    }

    try {
      const entries = await scanWithTimeout(adapter, SOURCE_TEST_TIMEOUT_MS);
      const totalSize = entries.reduce((s, e) => s + (e.size || 0), 0);
      const sample = [...entries]
        .sort((a, b) => a.relPath.localeCompare(b.relPath))
        .slice(0, SOURCE_TEST_SAMPLE_SIZE)
        .map((e) => ({
          relPath: e.relPath,
          size: e.size,
          mtimeMs: e.mtimeMs,
          etag: e.etag,
        }));
      log.info(`[source:test] ${adapter.kind} ok: ${entries.length} files, ${totalSize} bytes (${Date.now() - startedAt}ms)`);
      return {
        ok: true,
        adapterKind: adapter.kind,
        fileCount: entries.length,
        totalSize,
        sample,
        durationMs: Date.now() - startedAt,
      };
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      const statusMatch = /HTTP\s+(\d{3})/.exec(msg);
      const isTimeout = /timeout|abort|timed?\s*out/i.test(msg);
      let fatalReason: PathErrorKind;
      if (isTimeout) {
        fatalReason = 'timeout';
      } else if (statusMatch) {
        fatalReason = classifyHttpStatus(Number(statusMatch[1]));
      } else {
        fatalReason = classifyFetchError(err);
      }
      log.warn(`[source:test] ${adapter.kind} failed (${fatalReason}): ${msg}`);
      return {
        ok: false,
        adapterKind: adapter.kind,
        error: msg,
        fatalReason,
        durationMs: Date.now() - startedAt,
      };
    } finally {
      await adapter.close().catch(() => undefined);
    }
  });
}

/* ============================ Bootstrap ============================ */

app.whenReady().then(async () => {
  log.info('========================================');
  log.info('  自动更新检测 启动中');
  log.info(`  Electron: ${process.versions.electron}`);
  log.info(`  Node: ${process.versions.node}`);
  log.info(`  Platform: ${process.platform}`);
  log.info('========================================');

  currentConfig = await ensureConfig();
  log.info(`[main] config loaded from ${getConfigPath()}`);
  log.info(`[main]   sourceDir = ${currentConfig.sourceDir || '(空!)'}`);
  log.info(`[main]   targetDir = ${currentConfig.targetDir || '(空!)'}`);
  log.info(`[main]   backupDir = ${currentConfig.backupDir || '(空,派生自 targetDir)'}`);
  log.info(`[main]   intervalSec = ${currentConfig.intervalSec}`);

  // 初始化历史 DB(失败时降级到不可用,不影响 P1/P2 同步)
  const historyPath = getHistoryDbPath();
  try {
    await ensureHistoryDir(historyPath);
    historyDB = new HistoryDB(historyPath);
    log.info(`[main] history db at ${historyPath}`);
  } catch (err) {
    log.error(`[main] ⚠️ history db 初始化失败,P3(历史/备份)功能不可用:`);
    log.error(`       ${(err as Error).message}`);
    log.error(`       修复: cd "${process.cwd()}" && npx electron-rebuild -f -w better-sqlite3`);
    historyDB = null;
  }

  // 初始化运行时状态
  stateMgr = new StateManager(getStatePath());
  await stateMgr.load();
  log.info(`[main] state at ${getStatePath()}`);

  registerIpc();
  createWindow();
  createTray({ onRunNow: () => scheduler?.runNow() });

  scheduler = new Scheduler({
    config: currentConfig,
    indexCachePath: getIndexCachePath(),
    onSync: buildOnSyncHandler({
      getScheduler: () => scheduler,
      stateMgr,
      historyDB,
      currentConfig: () => currentConfig,
      getMainWindow,
    }),
    onFatalError: (n) => {
      log.error(`[scheduler] 连续失败 ${n} 次`);
    },
  });

  const initialState = await stateMgr.load();
  scheduler.setDryRunMode(initialState.popupEnabled);
  scheduler.start();
  log.info(`[scheduler] 已启动,立即跑一次,然后每 ${currentConfig.intervalSec}s 一次 · dryRun=${initialState.popupEnabled}`);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', async () => {
  if (scheduler) {
    await scheduler.stop();
    scheduler = null;
  }
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', async (e) => {
  if (scheduler) {
    e.preventDefault();
    await scheduler.stop();
    scheduler = null;
    app.quit();
  }
});
