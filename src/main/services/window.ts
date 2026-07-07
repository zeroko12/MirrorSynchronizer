/**
 * window - BrowserWindow 生命周期
 *
 * 职责:
 * - 创建主窗口
 * - 监听 renderer 崩溃 / console(转发到主进程日志)
 * - 拦截外链(走系统浏览器)
 * - 关闭按钮 = 最小化到托盘(不退出)
 */

import { app, BrowserWindow, nativeImage, shell, type BrowserWindow as BrowserWindowType } from 'electron';
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

/** 主进程在退出时设置;window 关闭按钮看到这个 flag 就不再 preventDefault,让窗口真正关 */
let isQuitting = false;
export function setQuitting(): void {
  isQuitting = true;
}
export function isAppQuitting(): boolean {
  return isQuitting;
}

/** 应用图标(打包前用 resources/icon.png,打包后从 app 根目录取) */
function loadAppIcon() {
  // 开发模式:从源码 resources/ 取
  const devPath = join(app.getAppPath(), 'resources', 'icon.png');
  return nativeImage.createFromPath(devPath);
}

export function createWindow(): void {
  const icon = loadAppIcon();
  mainWindow = new BrowserWindow({
    width: 760,
    height: 600,
    minWidth: 600,
    minHeight: 400,
    show: false,
    // 不自动隐藏 — 顶部"关于"菜单用户得能直接看到
    autoHideMenuBar: false,
    title: APP_DISPLAY_NAME,
    ...(icon.isEmpty() ? {} : { icon }),
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      sandbox: false,
    },
  });

  // DevTools 入口(隐秘:F12 / Ctrl+Shift+I 切显)
  // 不在启动时自动开 — 用户需要主动调,避免每次启动都弹控制台。
  // (调试流程:F12 打开 → DevTools Console → Ctrl+F 找元素)
  mainWindow.webContents.on('before-input-event', (_e, input) => {
    const isF12 = input.key === 'F12';
    const isCtrlShiftI =
      input.type === 'keyDown' &&
      input.key === 'I' &&
      input.control &&
      input.shift;
    if (isF12 || isCtrlShiftI) {
      if (!mainWindow) return;
      if (mainWindow.webContents.isDevToolsOpened()) {
        mainWindow.webContents.closeDevTools();
      } else {
        mainWindow.webContents.openDevTools({ mode: 'detach' });
      }
    }
  });

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

  // 关闭按钮 = 最小化到托盘(不退出);主进程调 app.quit() 时 setQuitting(true),
  // 之后 close 就不 preventDefault,让窗口真的关掉
  mainWindow.on('close', (e) => {
    if (!isQuitting) {
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
