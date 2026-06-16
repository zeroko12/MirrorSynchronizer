/**
 * Electron 主进程入口
 *
 * 职责:
 * - 创建 BrowserWindow,加载 Vue UI
 * - 注册 IPC handler:状态查询 / 同步触发 / 配置读写 / 文件夹选择 / 映射管理
 * - 启动后台 Scheduler,配置变化时热更新
 * - 系统托盘 + 弹窗决策
 * - 开机自启动
 */

import electron from 'electron';
import { existsSync, promises as fs } from 'node:fs';
import { join } from 'node:path';
import { ConfigManager, DEFAULT_CONFIG } from '../core/config.js';
import { Scheduler } from '../core/scheduler.js';
import { Syncer } from '../core/syncer.js';
import { Backupper, statDir } from '../core/backupper.js';
import { HistoryDB, defaultHistoryDbPath, ensureHistoryDir } from '../core/history.js';
import { Indexer } from '../core/indexer.js';
import { StateManager, defaultStatePath } from '../core/state.js';
import { decide } from '../core/detector.js';
import { mainLog } from '../core/logger.js';
import type { AppConfig } from '../core/types.js';

const log = mainLog;

// Electron 33+ / Node 22+ 推荐 default import 然后解构,避免 named import 互操作报错
const { app, BrowserWindow, dialog, ipcMain, shell, Notification, Tray, Menu, nativeImage } = electron;
type BrowserWindowType = InstanceType<typeof BrowserWindow>;
type TrayType = InstanceType<typeof Tray>;

let mainWindow: BrowserWindowType | null = null;
let scheduler: Scheduler | null = null;
let currentConfig: AppConfig | null = null;
let historyDB: HistoryDB | null = null;
let stateMgr: StateManager | null = null;
let tray: TrayType | null = null;
/** 当前同步活跃状态(用于托盘图标四态) */
let activityState: 'idle' | 'has-update' | 'syncing' | 'error' = 'idle';
const backupper = new Backupper();

function getConfigPath(): string {
  return join(app.getPath('userData'), 'config.json');
}

function getIndexCachePath(): string {
  return join(app.getPath('userData'), 'index-cache.json');
}

function getHistoryDbPath(): string {
  return defaultHistoryDbPath(app.getPath('userData'));
}

function getStatePath(): string {
  return defaultStatePath(app.getPath('userData'));
}

/**
 * P4: 处理用户弹窗决策。
 * 渲染进程调用 ipcRenderer.invoke('update:decide', ...) 触发
 */
async function handleUserDecision(
  action: 'apply' | 'snooze' | 'ignore',
  hash: string,
): Promise<void> {
  if (!stateMgr) return;
  const state = await stateMgr.load();

  switch (action) {
    case 'apply': {
      // 用户决定"立即同步" → 关闭干运行模式,强制跑一次实际 sync
      await stateMgr.update({ lastShownChangeHash: hash });
      if (scheduler) {
        // 已回退锁 → 先解锁
        if (state.postRollbackLock) {
          await stateMgr.update({ postRollbackLock: null });
          log.info('[decide] 回退锁已解除');
        }
        scheduler.setDryRunMode(false);
        const result = await scheduler.runNow();
        scheduler.setDryRunMode(state.popupEnabled);
        if (result?.ok) {
          log.info('[decide] 用户决定应用,同步成功');
        } else {
          log.error('[decide] 用户决定应用,但同步失败');
        }
      }
      break;
    }
    case 'snooze': {
      // "稍后再问" → 暂休 5 分钟
      await stateMgr.update({
        snoozeUntil: Date.now() + 300_000, // 5min
        lastShownChangeHash: hash,
      });
      log.info('[decide] 用户暂休 5 分钟');
      break;
    }
    case 'ignore': {
      // "忽略本次" → 标记为已读,不实际同步
      await stateMgr.update({ lastShownChangeHash: hash });
      log.info('[decide] 用户忽略本次');
      break;
    }
  }
}

function setActivityState(s: typeof activityState): void {
  activityState = s;
  updateTrayMenu();
}

function buildTrayIcon(_state: typeof activityState) {
  // 根据状态选不同 emoji-as-icon(简化:用一个空图,标题做指示)
  // 实际产品会用 .ico 文件,这里走文本路线
  return nativeImage.createEmpty();
}

function updateTrayMenu(): void {
  if (!tray) return;
  const statusLabel = {
    idle: '✓ 空闲',
    'has-update': '⚠ 有更新待确认',
    syncing: '↻ 同步中',
    error: '✗ 错误',
  }[activityState];
  const contextMenu = Menu.buildFromTemplate([
    { label: statusLabel, enabled: false },
    { type: 'separator' },
    {
      label: '显示主窗口',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        }
      },
    },
    {
      label: '立即检查一次',
      click: async () => {
        if (scheduler) await scheduler.runNow();
      },
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        app.quit();
      },
    },
  ]);
  tray.setToolTip(`自动更新检测 · ${statusLabel}`);
  tray.setContextMenu(contextMenu);
}

function createTray(): void {
  if (tray) return;
  tray = new Tray(buildTrayIcon(activityState));
  tray.on('click', () => {
    if (mainWindow) {
      if (mainWindow.isVisible()) mainWindow.hide();
      else {
        mainWindow.show();
        mainWindow.focus();
      }
    }
  });
  updateTrayMenu();
}

async function ensureConfig(): Promise<AppConfig> {
  const cfgPath = getConfigPath();
  const mgr = new ConfigManager({ configPath: cfgPath, defaults: DEFAULT_CONFIG });
  if (!existsSync(cfgPath)) {
    await mgr.save(DEFAULT_CONFIG);
  }
  return mgr.load();
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 760,
    height: 600,
    minWidth: 600,
    minHeight: 400,
    show: false,
    autoHideMenuBar: true,
    title: '自动更新检测',
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      sandbox: false,
    },
  });

  // 生产环境不自动开 DevTools。
  // 如需临时调试:打开下面这行,或者运行时按 Ctrl+Shift+I
  // mainWindow.webContents.openDevTools({ mode: 'detach' });

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show();
  });

  // 渲染进程任何错误都打到主进程控制台
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    log.error('[renderer] crashed:', details);
  });
  mainWindow.webContents.on('console-message', (_e, level, message, line, source) => {
    const tag = ['DEBUG', 'INFO', 'WARN', 'ERROR'][level] ?? 'LOG';
    log.info(`[renderer ${tag}] ${source}:${line} ${message}`);
  });

  // 不允许外链在窗口内打开
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // P4: 关闭按钮 = 最小化到托盘(不退出),只能从托盘菜单或 app.quit 真正退出
  mainWindow.on('close', (e) => {
    if (!(app as unknown as { isQuitting?: boolean }).isQuitting) {
      e.preventDefault();
      mainWindow?.hide();
    }
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

function registerIpc(): void {
  // P1: 状态查询
  ipcMain.handle('status:get', () => {
    return {
      sourceDir: currentConfig?.sourceDir ?? '',
      targetDir: currentConfig?.targetDir ?? '',
      backupDir: currentConfig?.backupDir ?? '',
      intervalSec: currentConfig?.intervalSec ?? 0,
      backupCount: currentConfig?.backupCount ?? 0,
      autostart: currentConfig?.autostart ?? false,
      fileMappings: currentConfig?.fileMappings ?? [],
      running: scheduler?.getStatus().running ?? false,
      lastResult: scheduler?.getStatus().lastResult
        ? {
            added: scheduler!.getStatus().lastResult!.added.length,
            modified: scheduler!.getStatus().lastResult!.modified.length,
            deleted: scheduler!.getStatus().lastResult!.deleted.length,
            durationMs: scheduler!.getStatus().lastResult!.durationMs,
            ok: scheduler!.getStatus().lastResult!.ok,
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
    if (scheduler) {
      scheduler.updateConfig(cfg);
    }
    return { ok: true };
  });

  // P2: 原生文件夹选择对话框
  ipcMain.handle('dialog:selectFolder', async (_e, defaultPath?: string) => {
    if (!mainWindow) return { canceled: true, path: null };
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择文件夹',
      defaultPath: defaultPath || undefined,
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return { canceled: true, path: null };
    }
    return { canceled: false, path: result.filePaths[0] };
  });

  // P5: 选文件 / 选目录(用户决定)
  ipcMain.handle(
    'dialog:selectPath',
    async (_e, opts: { defaultPath?: string; mode: 'file' | 'folder' | 'both' }) => {
      if (!mainWindow) return { canceled: true, path: null, isDirectory: false };
      const properties: Array<'openFile' | 'openDirectory' | 'createDirectory'> = [];
      if (opts.mode === 'file') properties.push('openFile');
      else if (opts.mode === 'folder') properties.push('openDirectory', 'createDirectory');
      else properties.push('openFile', 'openDirectory'); // both:Windows 上有限制,通常会按 OS 默认行为
      const result = await dialog.showOpenDialog(mainWindow, {
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

  // 调试用:扫描源/目标目录返回文件数(不实际同步)
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

  // P3: 历史日志
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

    // 冷启动/迁移数据:把"FS 有但 DB 没"的快照补登记到 DB,这样它们就有正常 id
    // 不会再出现 id=-1 这种删不掉的孤儿
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

    // 重新查,所有备份都有正常 id
    const allBackups = historyDB.listBackups();
    // 用 fs 信息补 sizeBytes / fileCount,并标 stale
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
      // 详细诊断:记录路径 + 文件状态
      log.info(`[rollback] 尝试回退 #${id}:`);
      log.info(`[rollback]   snapshotPath = ${b.snapshotPath}`);
      log.info(`[rollback]   targetDir   = ${b.targetDir}`);
      log.info(`[rollback]   existsSync  = ${existsSync(b.snapshotPath)}`);
      if (!existsSync(b.snapshotPath)) {
        // 列出 backupDir 内容,看实际目录长啥样
        const parent = b.snapshotPath.split(/[\\/]/).slice(0, -1).join('\\');
        try {
          const siblings = await fs.readdir(parent);
          log.info(`[rollback]   backupDir 实际内容: ${siblings.join(', ')}`);
        } catch (e) {
          log.info(`[rollback]   无法列出 ${parent}: ${(e as Error).message}`);
        }
        return { ok: false, error: `快照文件不存在: ${b.snapshotPath}\n(可能已被人手动删除,或 backupDir 配置变了)` };
      }
      // 备份当前 target(防止回退不可逆)
      const safetyBackup = await backupper.createSnapshot(
        b.targetDir,
        currentConfig?.backupDir || undefined,
      );
      log.info(`[rollback] 回退前安全快照: ${safetyBackup.path}`);
      // 执行回退
      await backupper.rollback(b.snapshotPath, b.targetDir);
      log.info(`[rollback] 已回退到 ${b.snapshotPath}`);

      // P4: 激活回退锁 + 清掉上次"已读"标记(下次同步会重新提示)
      if (stateMgr) {
        await stateMgr.lockPostRollback(
          b.snapshotPath.split(/[\\/]/).pop() ?? `#${b.id}`,
          b.id,
        );
        await stateMgr.markUnread();
        log.info(`[rollback] 已激活回退锁`);
      }

      // 重置 indexer 缓存(强制下次 sync 完整扫描)
      if (currentConfig) {
        const cachePath = getIndexCachePath();
        try {
          await fs.unlink(cachePath);
        } catch {
          // ignore
        }
      }

      return { ok: true, safetySnapshotPath: safetyBackup.path };
    } catch (err) {
      log.error(`[rollback] 异常:`, err);
      return { ok: false, error: `回退失败: ${(err as Error).message}` };
    }
  });

  ipcMain.handle('backup:delete', async (_e, id: number) => {
    if (!historyDB) return { ok: false, error: 'db not ready' };
    const b = historyDB.getBackup(id);
    if (!b) return { ok: false, error: '备份不存在' };
    try {
      log.info(`[delete] 尝试删除备份 #${id}: ${b.snapshotPath}`);
      log.info(`[delete]   existsSync = ${existsSync(b.snapshotPath)}`);
      await backupper.deleteSnapshot(b.snapshotPath);
      historyDB.deleteBackup(id);
      log.info(`[delete] 已删除 #${id}`);
      return { ok: true };
    } catch (err) {
      log.error(`[delete] 异常:`, err);
      return { ok: false, error: `删除失败: ${(err as Error).message}` };
    }
  });

  // P4: 用户决策
  ipcMain.handle('user:decide', async (_e, action: 'apply' | 'snooze' | 'ignore', hash: string) => {
    try {
      await handleUserDecision(action, hash);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  // P4: 状态查询/修改(popup 开关、回退锁等)
  ipcMain.handle('state:get', async () => {
    if (!stateMgr) return null;
    return await stateMgr.load();
  });

  ipcMain.handle('state:setPopupEnabled', async (_e, enabled: boolean) => {
    if (!stateMgr) return { ok: false, error: 'state not ready' };
    await stateMgr.update({ popupEnabled: enabled });
    // 同时调度器 dryRun 模式同步切换
    if (scheduler) scheduler.setDryRunMode(enabled);
    log.info(`[state] popupEnabled=${enabled}, dryRun=${enabled}`);
    return { ok: true };
  });

  // P5: 开机自启动
  ipcMain.handle('autostart:get', () => {
    // 优先用 OS 实际状态(用户可能手动改了注册表/启动项)
    const settings = app.getLoginItemSettings();
    return { openAtLogin: settings.openAtLogin };
  });

  ipcMain.handle('autostart:set', async (_e, enabled: boolean) => {
    try {
      // openAsHidden: Windows 上仅打包应用生效,dev 环境忽略
      app.setLoginItemSettings({
        openAtLogin: enabled,
        openAsHidden: true, // 启动时最小化到托盘(不弹主窗)
      });
      // 同步到 config
      if (currentConfig) {
        const next = { ...currentConfig, autostart: enabled };
        await new ConfigManager({
          configPath: getConfigPath(),
          defaults: DEFAULT_CONFIG,
        }).save(next);
        currentConfig = next;
      }
      log.info(`[autostart] openAtLogin=${enabled}`);
      return { ok: true, openAtLogin: app.getLoginItemSettings().openAtLogin };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  // P5: 立即应用所有映射规则(无需等同步周期)
  ipcMain.handle('mappings:applyAll', async () => {
    if (!currentConfig) {
      return { ok: false, error: 'config not ready' };
    }
    if (!currentConfig.targetDir) {
      return { ok: false, error: '目标目录未配置,请先在设置里配' };
    }
    if (!currentConfig.fileMappings.length) {
      return { ok: false, error: '没有映射规则' };
    }
    try {
      const syncer = new Syncer(currentConfig);
      const result = await syncer.applyMappingsOnly();
      // 写历史
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
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  // 测试单条映射(不保存,只跑一次诊断性的应用)
  ipcMain.handle('mappings:testOne', async (_e, mappingId: string) => {
    if (!currentConfig) return { ok: false, error: 'config not ready' };
    const m = currentConfig.fileMappings.find((x) => x.id === mappingId);
    if (!m) return { ok: false, error: '规则不存在' };
    // 临时启用,跑一次,再恢复(避免副作用)
    const originalEnabled = m.enabled;
    const testMapping: typeof m = { ...m, enabled: true };
    const testConfig = {
      ...currentConfig,
      fileMappings: currentConfig.fileMappings.map((x) => (x.id === mappingId ? testMapping : x)),
    };
    const syncer = new Syncer(testConfig);
    const result = await syncer.applyMappingsOnly();
    void originalEnabled; // 占位,实际不修改(测试用 enabled=true 临时覆盖)
    return {
      ok: result.ok,
      mappingCopied: result.mappingCopied,
      mappingSkippedExisting: result.mappingSkippedExisting,
      mappingSkipped: result.mappingSkipped,
      warnings: result.warnings,
      error: result.fatalError,
    };
  });

  // P4: 回退时 main 端激活回退锁
  // 复用现有 backup:rollback 流程,在成功回退后激活锁
}

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

  // 初始化历史 DB
  // 失败也不能让 app 崩 — P3(历史/备份)是可选功能,失败时降级到不可用,设置/同步照常工作
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
  createTray();

  scheduler = new Scheduler({
    config: currentConfig,
    indexCachePath: getIndexCachePath(),
    onSync: (r) => {
      const summary = `added=${r.added.length} modified=${r.modified.length} deleted=${r.deleted.length} unchanged=${r.unchanged} mapping=${r.mappingCopied.length} duration=${r.durationMs}ms`;
      if (r.fatalError) {
        log.error(`[sync FATAL] ${r.fatalError}`);
        log.error(`[sync FATAL] | ${summary}`);
      } else if (r.warnings.length > 0) {
        log.warn(`[sync WARN] warnings=${r.warnings.length}`);
        log.warn(`[sync WARN] | ${summary}`);
        for (const w of r.warnings) log.warn(`  - ${w}`);
      } else {
        log.info(`[sync OK] ${summary}`);
      }

      // P4: 托盘状态指示(简化:有变化 → has-update)
      if (r.fatalError) {
        setActivityState('error');
      } else if (r.added.length + r.modified.length + r.deleted.length > 0) {
        setActivityState('has-update');
      } else {
        setActivityState('idle');
      }

      // P4: 弹窗决策
      void (async () => {
        if (!stateMgr) return;
        const state = await stateMgr.load();
        const decision = decide({
          result: r,
          lastShownChangeHash: state.lastShownChangeHash,
          popupEnabled: state.popupEnabled,
          snoozeUntil: state.snoozeUntil,
          isPostRollbackLockActive: !!state.postRollbackLock,
        });

        if (decision.kind === 'silent') {
          log.info(`[decide] silent (${decision.reason})`);
          return;
        }

        const fingerprint = decision.fingerprint;
        log.info(`[decide] ${decision.kind} (${decision.kind === 'popup' ? decision.reason : 'locked'}) hash=${fingerprint.hash}`);

        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('update:prompt', {
            ...fingerprint,
            isLocked: decision.kind === 'locked-detect',
            lockSnapshotTimestamp: state.postRollbackLock?.snapshotTimestamp ?? null,
          });
          // 自动弹出主窗(从托盘)
          mainWindow.show();
          mainWindow.focus();
          // Windows Toast 通知
          try {
            new Notification({
              title: '自动更新检测',
              body: decision.kind === 'locked-detect'
                ? `已回退 · 检测到 ${fingerprint.addedCount + fingerprint.modifiedCount + fingerprint.deletedCount} 个新变更,需确认`
                : `检测到 ${fingerprint.addedCount + fingerprint.modifiedCount + fingerprint.deletedCount} 个文件变化,需确认`,
            }).show();
          } catch (e) {
            log.warn('[notification] 显示失败:', (e as Error).message);
          }
        }
      })();

      // P3: 写入历史(异步,失败不阻塞同步)
      void (async () => {
        if (!historyDB || !currentConfig) return;
        try {
          let backupId: number | null = null;
          if (r.backupCreated && r.backupSnapshotPath) {
            // 重新 stat 拿到文件数 / 大小(快照已存在)
            const { fileCount, sizeBytes } = await statDir(r.backupSnapshotPath);
            backupId = historyDB.recordBackup({
              createdAt: r.startedAt,
              sourceDir: currentConfig.sourceDir,
              targetDir: currentConfig.targetDir,
              snapshotPath: r.backupSnapshotPath,
              fileCount,
              sizeBytes,
            });
            log.info(`[history] 备份 #${backupId} 已记录`);
          }
          const syncId = historyDB.recordSync({
            startedAt: r.startedAt,
            durationMs: r.durationMs,
            sourceDir: currentConfig.sourceDir,
            targetDir: currentConfig.targetDir,
            addedCount: r.added.length,
            modifiedCount: r.modified.length,
            deletedCount: r.deleted.length,
            unchangedCount: r.unchanged,
            mappingCopiedCount: r.mappingCopied.length,
            mappingSkippedExistingCount: r.mappingSkippedExisting.length,
            mappingSkippedCount: r.mappingSkipped.length,
            fatalError: r.fatalError ?? null,
            backupId,
          });
          log.info(`[history] 同步 #${syncId} 已记录(added=${r.added.length} mod=${r.modified.length} del=${r.deleted.length})`);
        } catch (e) {
          log.error('[history] 写入失败:', (e as Error).message);
        }
      })();

      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('sync:result', r);
      }
    },
    onFatalError: (n) => {
      log.error(`[scheduler] 连续失败 ${n} 次`);
    },
  });
  // P4: dryRun 模式根据 popup 开关启动
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
