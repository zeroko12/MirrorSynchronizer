/**
 * tray - 系统托盘 + 活动状态指示
 *
 * 状态机(idle / has-update / syncing / error)由 setActivityState 维护
 * 每次状态变化 → 重新构建菜单 + 刷新 tooltip
 */

import { app, clipboard, Menu, nativeImage, shell, Tray, type Tray as TrayType } from 'electron';
import { join } from 'node:path';
import { APP_DISPLAY_NAME } from '@core/constants';
import { mainLog } from '@core/logger';
import { getMainWindow, setQuitting } from './window.js';
import { showContact } from './app-menu.js';
import type { RemoteAccessInfo } from './remote/manager.js';

const log = mainLog;

export type ActivityState = 'idle' | 'has-update' | 'syncing' | 'error';

let tray: TrayType | null = null;
let activityState: ActivityState = 'idle';

export function getActivityState(): ActivityState {
  return activityState;
}

export function setActivityState(s: ActivityState): void {
  activityState = s;
  updateTrayMenu();
}

function buildTrayIcon(_state: ActivityState) {
  // 简化:用 Electron 默认 app icon 作托盘图标,实际产品应换 .ico
  // 之前 createEmpty() 让托盘在 Windows 上不可见
  return app.getAppPath().length > 0
    ? nativeImage.createFromPath(join(app.getAppPath(), 'resources', 'icon.png'))
    : nativeImage.createEmpty();
}

function updateTrayMenu(): void {
  rebuildMenu();
}

export interface TrayDeps {
  /** "立即检查一次" 菜单项的回调 */
  onRunNow: () => unknown | Promise<unknown>;
  /** 远程访问信息(URL / 客户端数 / 初始密码)— 用于托盘菜单 */
  getRemoteInfo: () => RemoteAccessInfo | null;
}

export function createTray(deps: TrayDeps): void {
  if (tray) return;
  tray = new Tray(buildTrayIcon(activityState));
  tray.on('click', () => {
    const w = getMainWindow();
    if (!w) return;
    if (w.isVisible()) w.hide();
    else {
      w.show();
      w.focus();
    }
  });
  // 保存回调供菜单用(闭包)
  const _onRunNow = deps.onRunNow;
  const _getRemoteInfo = deps.getRemoteInfo;
  trayOnRunNow = _onRunNow;
  trayGetRemoteInfo = _getRemoteInfo;
  rebuildMenu();
  log.info('[tray] 已创建');
}

let trayOnRunNow: (() => unknown | Promise<unknown>) | null = null;
let trayGetRemoteInfo: (() => RemoteAccessInfo | null) | null = null;

function rebuildMenu(): void {
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
        const w = getMainWindow();
        if (w) {
          w.show();
          w.focus();
        }
      },
    },
    {
      label: '立即检查一次',
      click: async () => {
        if (trayOnRunNow) await trayOnRunNow();
      },
    },
    { type: 'separator' },
    ...buildRemoteAccessMenu(trayGetRemoteInfo ? trayGetRemoteInfo() : null),
    { type: 'separator' },
    {
      label: '联系开发者',
      click: () => showContact(),
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        // 关键:先置 isQuitting = true,这样隐藏到托盘的主窗口
        // close handler 看到后不再 preventDefault,让窗口正常关闭 → app.quit 才会真正结束
        setQuitting();
        app.quit();
      },
    },
  ]);
  tray.setToolTip(`${APP_DISPLAY_NAME} · ${statusLabel}`);
  tray.setContextMenu(contextMenu);
}

/**
 * 构造"远程访问"菜单块
 * 远程未启用:返回 1 个 disabled 提示
 * 远程启用:显示 URL + 客户端数 + 复制 URL / 复制密码 / 打开浏览器
 */
function buildRemoteAccessMenu(info: RemoteAccessInfo | null) {
  if (!info || !info.enabled) {
    return [{ label: '远程访问未启用', enabled: false }];
  }
  if (!info.running || !info.url) {
    return [{ label: '远程访问启动中…', enabled: false }];
  }
  const items: Electron.MenuItemConstructorOptions[] = [
    { label: `远程访问 ${info.clientCount} 个客户端已连接`, enabled: false },
    { label: info.url, enabled: false },
    { type: 'separator' },
    {
      label: '在浏览器中打开',
      click: () => {
        shell.openExternal(info.url!).catch((err) => {
          log.warn('[tray] openExternal failed:', err);
        });
      },
    },
    {
      label: '复制 URL',
      click: () => {
        clipboard.writeText(info.url!);
        log.info('[tray] copied URL to clipboard');
      },
    },
  ];
  if (info.initialPassword) {
    items.push({
      label: '复制初始密码',
      click: () => {
        clipboard.writeText(info.initialPassword!);
        log.info('[tray] copied initial password to clipboard');
      },
    });
  }
  return items;
}
