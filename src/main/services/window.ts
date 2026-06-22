/**
 * window - BrowserWindow 生命周期
 *
 * 职责:
 * - 创建主窗口
 * - 监听 renderer 崩溃 / console(转发到主进程日志)
 * - 拦截外链(走系统浏览器)
 * - 关闭按钮 = 最小化到托盘(不退出)
 */

import { app, BrowserWindow, shell, type BrowserWindow as BrowserWindowType } from 'electron';
import { join } from 'node:path';
import { APP_DISPLAY_NAME } from '@core/constants';
import { mainLog } from '@core/logger';

const log = mainLog;

/** 主窗口引用(模块级共享) */
export let mainWindow: BrowserWindowType | null = null;
export function setMainWindow(w: BrowserWindowType | null): void {
  mainWindow = w;
}
export function getMainWindow(): BrowserWindowType | null {
  return mainWindow;
}

export function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 760,
    height: 600,
    minWidth: 600,
    minHeight: 400,
    show: false,
    // 不自动隐藏 — 顶部"关于"菜单用户得能直接看到
    autoHideMenuBar: false,
    title: APP_DISPLAY_NAME,
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      sandbox: false,
    },
  });

  // 生产环境不自动开 DevTools
  // mainWindow.webContents.openDevTools({ mode: 'detach' });

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show();
  });

  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    log.error('[renderer] crashed:', details);
  });
  mainWindow.webContents.on('console-message', (_e, level, message, line, source) => {
    const tag = ['DEBUG', 'INFO', 'WARN', 'ERROR'][level] ?? 'LOG';
    log.info(`[renderer ${tag}] ${source}:${line} ${message}`);
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // 关闭按钮 = 最小化到托盘(不退出),只能从托盘菜单或 app.quit 真正退出
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
