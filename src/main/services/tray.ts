/**
 * tray - 系统托盘 + 活动状态指示
 *
 * 状态机(idle / has-update / syncing / error)由 setActivityState 维护
 * 每次状态变化 → 重新构建菜单 + 刷新 tooltip
 */

import { app, Menu, nativeImage, Tray, type Tray as TrayType } from 'electron';
import { APP_DISPLAY_NAME } from '@core/constants';
import { mainLog } from '@core/logger';
import { getMainWindow } from './window.js';

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
  // 简化:用空图,标题做指示。实际产品应用 .ico
  return nativeImage.createEmpty();
}

function updateTrayMenu(): void {
  rebuildMenu();
}

export interface TrayDeps {
  /** "立即检查一次" 菜单项的回调 */
  onRunNow: () => unknown | Promise<unknown>;
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
  // 用一个 setContextMenu 替代 buildFromTemplate 中的 click
  // 重新构建菜单时用 _onRunNow
  // 注:这里为了避免重写完整模板,直接 patch 现有 menu 的回调
  // 简化:用 module-level 变量持有回调
  trayOnRunNow = _onRunNow;
  rebuildMenu();
  log.info('[tray] 已创建');
}

let trayOnRunNow: (() => unknown | Promise<unknown>) | null = null;

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
    {
      label: '退出',
      click: () => {
        app.quit();
      },
    },
  ]);
  tray.setToolTip(`${APP_DISPLAY_NAME} · ${statusLabel}`);
  tray.setContextMenu(contextMenu);
}
