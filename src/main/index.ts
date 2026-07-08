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
import { applyPending, clearStaging, countPendingApply, hasPendingApply } from '../core/swapper.js';
import { tryLaunchExecutable } from '../core/launcher.js';
import { deriveDefaultStagingDir } from '../core/types.js';
import { Backupper } from '../core/backupper.js';
import { HistoryDB, ensureHistoryDir } from '../core/history.js';
import { Indexer } from '../core/indexer.js';
import { StateManager } from '../core/state.js';
import { mainLog } from '../core/logger.js';
import { SOURCE_TEST_SAMPLE_SIZE, SOURCE_TEST_TIMEOUT_MS } from '../core/constants.js';
import { pickAdapter, type SourceAdapter } from '../core/adapter.js';
import { classifyFetchError, classifyHttpStatus, type PathErrorKind } from '../core/errors.js';
import type { AppConfig, SyncResult } from '../core/types.js';
import { getConfigPath, getHistoryDbPath, getIndexCachePath, getStatePath } from './services/paths.js';
import { createWindow, getMainWindow } from './services/window.js';
import { createTray } from './services/tray.js';
import { handleUserDecision } from './services/user-decision.js';
import { buildOnSyncHandler } from './services/scheduler-events.js';
import { scanWithTimeout } from './services/scan-timeout.js';
import { setAppMenu } from './services/app-menu.js';
import { createRemoteManager, type RemoteManager, type RemoteAccessInfo, listNetworkIPs } from './services/remote/manager.js';
import { decide } from '../core/detector.js';

const log = mainLog;
const { app, BrowserWindow, dialog, ipcMain } = electron;

let currentConfig: AppConfig | null = null;
let historyDB: HistoryDB | null = null;
let stateMgr: StateManager | null = null;
let scheduler: Scheduler | null = null;
let remote: RemoteManager | null = null;
let pendingPopup: import('./services/remote/state-provider.js').RemoteState['pendingPopup'] = null;
let remoteInfo: RemoteAccessInfo | null = null;
let suppressNextLocalPopup = false;
const backupper = new Backupper();

/** 写回 config(用于 remote 首次生成密码后) */
async function saveConfig(): Promise<void> {
  if (!currentConfig) return;
  const mgr = new ConfigManager({ configPath: getConfigPath(), defaults: DEFAULT_CONFIG });
  await mgr.save(currentConfig);
}

/**
 * 映射拷贝成功后,看是否要启动可执行文件
 *
 * 与 scheduler.runNow → force 路径下的 launch 守卫对齐:
 *  - 同步/映射成功(result.ok=true) → 才考虑 launch
 *  - 配置了 executablePath → 启动
 *  - 启动失败或文件不存在 → 返 null + warning
 *
 * "保存映射后立即应用"开关触发时,用户期望:
 *   配置映射 → 保存 → IPC applyMappingsOnly → 启动
 * 启动必须在映射拷完之后,这样程序加载的是最新文件。
 */
async function maybeLaunchAfterMappings(
  config: AppConfig | null,
  result: SyncResult,
): Promise<number | null> {
  if (!config || !result.ok) return null;
  if (!config.executablePath || !config.executablePath.trim()) return null;
  // 即便 result.mappingCopied 为空(本次没拷贝),只要映射路径里 executablePath 没问题
  // 也尝试启动 — 用户的"保存映射后立即应用"意图是"完成动作后让程序跑起来"
  const lr = await tryLaunchExecutable(config.targetDir, config.executablePath);
  if (lr.launched && lr.pid) {
    log.info(`[mappings:applyAll] 同步/映射成功,已启动 ${config.executablePath} (PID=${lr.pid})`);
    return lr.pid;
  }
  if (lr.reason) {
    log.warn(`[mappings:applyAll] 启动失败: ${lr.reason} - ${config.executablePath}`);
  }
  return null;
}

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

  // 同步 IPC 30s 上限:SMB / 网络源挂死时不能让 renderer 一直转圈
  // 超时后放行 IPC,返 ok=false + 错误信息,后台 sync 仍在跑(完成后会发 sync:result push)
  const SYNC_IPC_TIMEOUT_MS = 30_000;
  const syncTimeoutMessage = (op: string) =>
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`${op} 超时 ${SYNC_IPC_TIMEOUT_MS / 1000}s,sync 可能卡住(SMB 死链?)`)),
        SYNC_IPC_TIMEOUT_MS,
      ),
    );

  ipcMain.handle('sync:runNow', async () => {
    // 保留 dryRun 语义 — 托盘"立即检查一次"、通用检查入口
    if (!scheduler) return { ok: false, error: 'scheduler not ready' };
    try {
      const result = await Promise.race([
        scheduler.runNow(),
        syncTimeoutMessage('sync:runNow'),
      ]);
      return { ok: true, result };
    } catch (err) {
      log.error(`[sync:runNow] ${(err as Error).message}`);
      return { ok: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('sync:runNowForce', async () => {
    // 强制真同步 — 即便弹窗模式也真删真拷,用于"保存并立即同步"按钮
    // (语义跟本地弹窗"应用"按钮和远程"立即同步"一致:用户主动要求立刻落盘)
    if (!scheduler) return { ok: false, error: 'scheduler not ready' };
    try {
      const result = await Promise.race([
        scheduler.runNow({ force: true }),
        syncTimeoutMessage('sync:runNowForce'),
      ]);
      return { ok: true, result };
    } catch (err) {
      log.error(`[sync:runNowForce] ${(err as Error).message}`);
      return { ok: false, error: (err as Error).message };
    }
  });

  // P6:staging 模式 — 立即应用 staging 中待 swap 的内容到 target
  ipcMain.handle('sync:applyNow', async () => {
    if (!currentConfig || !scheduler) {
      return { ok: false, error: 'scheduler/config not ready', applied: 0, blocked: 0, warnings: [] };
    }
    if (currentConfig.applyMode !== 'staging') {
      return { ok: false, error: '当前不是 staging 模式', applied: 0, blocked: 0, warnings: [] };
    }
    const stagingDir = currentConfig.stagingDir || deriveDefaultStagingDir(currentConfig.targetDir);
    try {
      const r = await Promise.race([
        applyPending({
          targetDir: currentConfig.targetDir,
          stagingDir,
          backupDir: currentConfig.backupDir || '',
          backupCount: currentConfig.backupCount,
          executablePath: currentConfig.executablePath,
          ignoreItems: currentConfig.ignoreItems,
        }),
        syncTimeoutMessage('sync:applyNow'),
      ]);
      // swap 完后,如果 executableUpdate === 'success',启动目标程序
      let launchedPid: number | undefined;
      if (currentConfig.executablePath && r.executableUpdate === 'success') {
        const lr = await tryLaunchExecutable(currentConfig.targetDir, currentConfig.executablePath);
        if (lr.launched) launchedPid = lr.pid;
      }
      // 通知 renderer(swap 完可能有新状态)
      const w = getMainWindow();
      if (w && !w.isDestroyed()) {
        w.webContents.send('sync:result', {
          ok: r.ok,
          applied: r.applied,
          blocked: r.blocked,
          executableUpdate: r.executableUpdate,
          launchedPid,
        });
      }
      return {
        ok: r.ok,
        applied: r.applied.length,
        blocked: r.blocked.length,
        warnings: r.warnings,
        error: r.fatalError,
        executableUpdate: r.executableUpdate,
        launchedPid,
      };
    } catch (err) {
      log.error(`[sync:applyNow] ${(err as Error).message}`);
      return { ok: false, error: (err as Error).message, applied: 0, blocked: 0, warnings: [] };
    }
  });

  // P6:取消 staging 待应用(清空 stagingDir)
  ipcMain.handle('sync:clearStaging', async () => {
    if (!currentConfig) return { ok: false, error: 'config not ready' };
    if (currentConfig.applyMode !== 'staging') {
      return { ok: false, error: '当前不是 staging 模式' };
    }
    const stagingDir = currentConfig.stagingDir || deriveDefaultStagingDir(currentConfig.targetDir);
    const r = await clearStaging({ stagingDir });
    return r;
  });

  // P6:查 staging 待应用文件数(给 UI banner)
  ipcMain.handle('sync:pendingApplyCount', async () => {
    if (!currentConfig) return 0;
    if (currentConfig.applyMode !== 'staging') return 0;
    const stagingDir = currentConfig.stagingDir || deriveDefaultStagingDir(currentConfig.targetDir);
    return await countPendingApply(stagingDir);
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
    // ★ 先 updateConfig 让 scheduler 视角立即是新 config(避免 runNow 进 readConfig 拿到老值),
    //   再 currentConfig 赋值 — 顺序反过来让 race window 缩到单行赋值(实际不可见)。
    //   反向顺序会留 "currentConfig 是新值但 scheduler 仍跑老值" 的窗口期,可能多跑一轮老 sync。
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
        { ignoreItems: currentConfig?.ignoreItems },
      );
      log.info(`[rollback] 回退前安全快照: ${safetyBackup.path}`);
      // 回退时 Backupper 优先读快照自带的 .meta.json(用备份时的 ignoreItems),
      // 老快照没 meta 时 fallback 到当前 config
      await backupper.rollback(b.snapshotPath, b.targetDir, {
        fallbackIgnoreItems: currentConfig?.ignoreItems,
      });
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
  // 加 30s 上限:handleUserDecision 内的 scheduler.runNow 可能因为 SMB / 网络源慢而拖很久
  // (apply 路径会真同步 + 跑 launch;远端用户通过 web 触发时会更慢)
  // 超时后放行 IPC,让渲染端的乐观关闭逻辑生效 — 不要再让用户卡在转圈
  ipcMain.handle('user:decide', async (_e, action: 'apply' | 'snooze' | 'ignore', hash: string) => {
    const DECIDE_TIMEOUT_MS = 30_000;
    try {
      const { result } = await Promise.race([
        handleUserDecision(stateMgr, scheduler, action, hash),
        new Promise<{ result: null; state: null }>((_, reject) =>
          setTimeout(
            () => reject(new Error(`user:decide 超时 ${DECIDE_TIMEOUT_MS / 1000}s,sync 可能卡住`)),
            DECIDE_TIMEOUT_MS,
          ),
        ),
      ]);
      // ★ 关键:把 sync 真实结果透传给渲染端
      // 之前返 {ok:true} 不管 sync 成败 → 用户在锁住场景下点"重试同步"看到
      // "已同步"提示,实际啥都没动。
      // 现在:result.ok=true → 渲染端弹"已同步";result.ok=false → 弹"同步失败"
      //   (失败时 handlePopupDecision 已经通过 update:prompt 把 locked 弹窗推回来了)
      return {
        ok: result?.ok === true,
        fatalReason: result?.fatalReason ?? null,
        fatalError: result?.fatalError ?? null,
      };
    } catch (err) {
      log.error(`[user:decide] ${(err as Error).message}`);
      return { ok: false, error: (err as Error).message };
    }
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
      mappingFailed: result.mappingFailed,
      warnings: result.warnings,
      error: result.fatalError,
      // ★ 关键:映射拷贝成功 + 配置了 executablePath → 启动可执行文件
      // 与 scheduler.runNow → force 流程一致:同步/映射成功后才 launch
      // "保存映射后立即应用"开关触发这个 IPC,用户期望:映射拷完 → 程序启动
      launchedPid: await maybeLaunchAfterMappings(currentConfig, result),
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
  // 远程访问信息(renderer 端显示)
  ipcMain.handle('remote:getInfo', () => remoteInfo);

  // 列出所有可用 IPv4(给用户多网卡时选)
  ipcMain.handle('remote:listIPs', () => listNetworkIPs());

  // 切换远程访问开/关
  ipcMain.handle('remote:setEnabled', async (_e, enabled: boolean) => {
    if (typeof enabled !== 'boolean') {
      return { ok: false, error: 'enabled 必须是 boolean' };
    }
    if (!currentConfig?.remote) {
      return { ok: false, error: 'config 不存在' };
    }
    if (currentConfig.remote.enabled === enabled) {
      return { ok: true }; // idempotent
    }
    currentConfig.remote.enabled = enabled;
    await saveConfig();
    if (enabled) {
      if (remote && !remote.isRunning()) {
        try {
          remoteInfo = await remote.start();
        } catch (err) {
          log.error(`[remote] setEnabled(true) start 失败: ${(err as Error).message}`);
        }
      }
    } else {
      if (remote && remote.isRunning()) {
        await remote.stop();
        remoteInfo = remote.getInfo();
      }
    }
    return { ok: true, info: remoteInfo };
  });

  // 重置远程访问密码
  ipcMain.handle('remote:resetPassword', async () => {
    if (!remote) {
      return { ok: false, error: '远程服务未启动' };
    }
    try {
      const { newPassword, info } = await remote.resetPassword();
      remoteInfo = info;
      await saveConfig();
      log.info('[remote] 密码已重置');
      return { ok: true, newPassword, info };
    } catch (err) {
      log.error(`[remote] resetPassword 失败: ${(err as Error).message}`);
      return { ok: false, error: (err as Error).message };
    }
  });

  // 在系统默认浏览器打开 URL(给 web UI 跳浏览器用)
  ipcMain.handle('shell:openExternal', async (_e, url: string) => {
    if (typeof url !== 'string' || !url.startsWith('http')) {
      return;
    }
    const { shell } = electron;
    await shell.openExternal(url);
  });

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
  setAppMenu();
  createWindow();
  createTray({
    // 用户从托盘点"立即检查一次" → 主动重新确认。
    // 清掉 lastShownChangeHash 让 decide() 不再走 already-shown 静默,
    // 同样的 diff 会被重新弹窗询问。
    // 备注:之前不弹窗就是因为 auto-popup 写完 hash 后,tray 触发的 runNow 跑出同样 fp
    //       → decide 永远 silent → 用户感受"明明有改动却不弹"。
    onRunNow: async () => {
      if (stateMgr) {
        await stateMgr.update({ lastShownChangeHash: null });
      }
      return scheduler?.runNow();
    },
    getRemoteInfo: () => remoteInfo,
  });

  const baseOnSync = buildOnSyncHandler({
    getScheduler: () => scheduler,
    stateMgr,
    historyDB,
    currentConfig: () => currentConfig,
    getMainWindow,
    shouldSkipPopup: () => suppressNextLocalPopup,
  });

  scheduler = new Scheduler({
    config: currentConfig,
    indexCachePath: getIndexCachePath(),
    // preflight 文件锁检测 → 转发到 renderer 显示警告 banner
    onPreflight: (info) => {
      const w = getMainWindow();
      if (w && !w.isDestroyed()) {
        w.webContents.send('sync:preflight', info);
      }
    },
    onSync: async (r) => {
      const wasRemoteSuppressed = suppressNextLocalPopup;
      await baseOnSync(r);
      if (wasRemoteSuppressed) suppressNextLocalPopup = false;
      // 让 remote 也能吃到这次同步
      if (remote) {
        // 算 pendingPopup 状态(用同样的 detector)
        const state = stateMgr ? await stateMgr.load() : null;
        const decision = state
          ? decide({
              result: r,
              lastShownChangeHash: state.lastShownChangeHash,
              popupEnabled: state.popupEnabled,
              snoozeUntil: state.snoozeUntil,
              isPostRollbackLockActive: !!state.postRollbackLock,
            })
          : null;
        if (decision && decision.kind !== 'silent') {
          pendingPopup = {
            hash: decision.fingerprint.hash,
            addedCount: decision.fingerprint.addedCount,
            modifiedCount: decision.fingerprint.modifiedCount,
            deletedCount: decision.fingerprint.deletedCount,
            isLocked: decision.kind === 'locked-detect',
            lockSnapshotTimestamp: state?.postRollbackLock?.snapshotTimestamp ?? null,
          };
        } else {
          // 弹窗关闭(可能本地决断了)
          pendingPopup = null;
        }
        remote.onSyncResult(r);
        remote.onPopupClosed(pendingPopup ? '' : 'latest'); // 实际 hash 由 onSyncResult 推 snapshot
      }
    },
    onFatalError: (n) => {
      log.error(`[scheduler] 连续失败 ${n} 次}`);
    },
  });

  const initialState = await stateMgr.load();
  scheduler.setDryRunMode(initialState.popupEnabled);
  scheduler.start();
  log.info(`[scheduler] 已启动,立即跑一次,然后每 ${currentConfig.intervalSec}s 一次 · dryRun=${initialState.popupEnabled}`);

  // 启动时:staging 模式下,如果有 pending 更新,先尝试 swap(目标程序已退出时最常见)
  if (currentConfig.applyMode === 'staging') {
    const stagingDir = currentConfig.stagingDir || deriveDefaultStagingDir(currentConfig.targetDir);
    if (await hasPendingApply(stagingDir)) {
      try {
        log.info(`[startup] 检测到 pending apply,执行 swap`);
        const r = await applyPending({
          targetDir: currentConfig.targetDir,
          stagingDir,
          backupDir: currentConfig.backupDir || '',
          backupCount: currentConfig.backupCount,
          executablePath: currentConfig.executablePath,
          ignoreItems: currentConfig.ignoreItems,
        });
        for (const w of r.warnings) log.warn(`[swap] ${w}`);
        log.info(`[startup] swap 完成 applied=${r.applied.length} blocked=${r.blocked.length}`);
        // swap 完后,如果 executableUpdate=success,启动目标程序
        if (currentConfig.executablePath && r.executableUpdate === 'success') {
          const lr = await tryLaunchExecutable(currentConfig.targetDir, currentConfig.executablePath);
          if (lr.launched) log.info(`[startup] 已启动 ${currentConfig.executablePath} (PID=${lr.pid})`);
        }
      } catch (err) {
        log.error(`[startup] swap 失败: ${(err as Error).message}`);
      }
    }
  }

  // 启动远程访问(如果启用)
  await startRemoteIfEnabled();

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

/**
 * 退出前 hook:等 scheduler 收尾(stop 内部会 cancel in-flight sync)
 *
 * 加 3s 超时保护 — 万一 scheduler.stop 卡在死锁网络 IO 上,
 * 超时后强制放行 quit,避免用户看到"点了退出但没反应"。
 */
app.on('before-quit', async (e) => {
  if (!scheduler) return; // 已经被清理过,直接放行
  e.preventDefault();
  try {
    await Promise.race([
      scheduler.stop(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('scheduler.stop 超时 3s,强制退出')), 3000),
      ),
    ]);
  } catch (err) {
    log.warn(`[main] before-quit: scheduler.stop 异常,继续退出: ${(err as Error).message}`);
  }
  scheduler = null;
  app.quit();
});

/* ============================ 远程访问 ============================ */

async function startRemoteIfEnabled(): Promise<void> {
  if (!currentConfig?.remote?.enabled) return;
  remote = createRemoteManager({
    getConfig: () => currentConfig,
    getHistoryDB: () => historyDB,
    getScheduler: () => scheduler,
    getPendingPopup: () => pendingPopup,
    onRemoteDecision: async (action, hash) => {
      if (!stateMgr) return 'no-op';
      await handleUserDecision(stateMgr, scheduler, action, hash);
      pendingPopup = null;
      return 'applied';
    },
    onRemoteRunNow: async () => {
      if (!scheduler) {
        log.warn('[main] onRemoteRunNow: scheduler 不存在');
        return null;
      }
      log.info('[main] onRemoteRunNow: 远程触发同步(force)');
      // 标记下一次 sync 跳过本地 popup + fatal toast(远程已主动确认,本地不打扰)
      suppressNextLocalPopup = true;
      // force=true:即便当前是弹窗询问模式(popupEnabled=true → dryRunMode=true),
      // 远程"立即同步"也是用户主动行为,必须真同步(拷贝/删除/落盘索引)。
      // 之前这里没传 force,导致 dryRun 模式下删除被吞,history 写了但 target 没动。
      // 远程 trigger 不启动目标程序(skipLaunch=true)— 服务端跑 GUI 没意义
      const result = await scheduler.runNow({ force: true, skipLaunch: true });
      log.info(`[main] onRemoteRunNow: 同步完成 ok=${result?.ok} fatal=${!!result?.fatalError} added=${result?.added.length ?? 0} deleted=${result?.deleted.length ?? 0}`);
      // 主动推 snapshot + sync-result,确保 web UI 立即看到新 history
      if (remote) {
        try {
          const { getRemoteState } = await import('./services/remote/state-provider.js');
          const snapshot = getRemoteState({
            config: () => currentConfig,
            historyDB: () => historyDB,
            scheduler: () => scheduler,
            pendingPopup: () => null,
            appName: '自动更新检测',
            appVersion: app.getVersion(),
          });
          remote.broadcast({ type: 'snapshot', data: snapshot });
          remote.broadcast({ type: 'sync-result', data: result });
        } catch (err) {
          log.warn('[main] runNow 后 broadcast 失败:', err);
        }
      }
      return result;
    },
    appName: '自动更新检测',
    appVersion: app.getVersion(),
    configPath: getConfigPath(),
  });
  try {
    remoteInfo = await remote.start();
    if (remoteInfo.passwordReset) {
      log.info(`[remote] 首次启动,密码已生成(显示在托盘菜单): ${remoteInfo.initialPassword}`);
      // 密码需要写盘
      await saveConfig();
    }
    // 监听同步事件 → 推送给远程 client
    // (这里用 monkey-patch 风格:scheduler.start 后我们 hook 进 onSync)
  } catch (err) {
    log.error(`[remote] 启动失败: ${(err as Error).message}`);
    remote = null;
    remoteInfo = null;
  }
}
