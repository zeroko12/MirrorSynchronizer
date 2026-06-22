/**
 * app-menu service 测试
 *
 * mock electron.Menu / app / dialog / shell / clipboard,验证:
 * - setAppMenu 调用 Menu.setApplicationMenu
 * - 关于 菜单只有"联系开发者"项(没有"关于"和"项目主页")
 * - 联系开发者 → dialog.showMessageBox,带"复制邮箱"和"关闭"两个按钮
 * - 点"复制邮箱"→ clipboard.writeText
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const { setApplicationMenu, appVersion, showMessageBox, openExternal, writeText } = vi.hoisted(() => {
  return {
    setApplicationMenu: vi.fn(),
    appVersion: vi.fn(() => '0.2.0'),
    showMessageBox: vi.fn(async () => ({ response: 1 })), // 默认返回"关闭"
    openExternal: vi.fn(async () => undefined),
    writeText: vi.fn(),
  };
});

vi.mock('electron', () => ({
  Menu: {
    setApplicationMenu: setApplicationMenu,
    buildFromTemplate: (t: unknown) => ({ __template: t }),
  },
  app: {
    getVersion: appVersion,
  },
  dialog: {
    showMessageBox,
  },
  shell: {
    openExternal,
  },
  clipboard: {
    writeText,
  },
}));

vi.mock('@core/logger', () => ({
  mainLog: { info: vi.fn(), warn: vi.fn() },
}));

vi.mock('@core/constants', () => ({
  APP_DISPLAY_NAME: '自动更新检测',
  APP_ID: 'com.local.auto-updater',
  APP_DATA_SUBDIR: 'auto-updater',
}));

import {
  setAppMenu,
  showContact,
  DEVELOPER_EMAIL,
} from '../src/main/services/app-menu.js';

describe('app-menu constants', () => {
  it('DEVELOPER_EMAIL 是 zeroko12@foxmail.com', () => {
    expect(DEVELOPER_EMAIL).toBe('zeroko12@foxmail.com');
  });
});

describe('setAppMenu', () => {
  beforeEach(() => {
    setApplicationMenu.mockClear();
    showMessageBox.mockClear();
    openExternal.mockClear();
  });

  it('设置应用菜单(Menu.setApplicationMenu 被调用)', () => {
    setAppMenu();
    expect(setApplicationMenu).toHaveBeenCalledOnce();
  });

  it('macOS 平台额外加 app 菜单', () => {
    const origPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    setAppMenu();
    const menu = setApplicationMenu.mock.calls[0][0] as { __template: unknown[] };
    const first = menu.__template[0] as { label: string };
    expect(first.label).toBe('自动更新检测');
    Object.defineProperty(process, 'platform', { value: origPlatform, configurable: true });
  });

  it('Windows 平台:关于菜单里只有"联系开发者"', () => {
    setAppMenu();
    const menu = setApplicationMenu.mock.calls[0][0] as { __template: unknown[] };
    const aboutMenu = menu.__template[0] as { label: string; submenu: { label?: string }[] };
    expect(aboutMenu.label).toBe('关于(&A)');
    const labels = aboutMenu.submenu.map((s) => s.label ?? '');
    // 只有"联系开发者"一项
    expect(labels).toEqual(['联系开发者']);
    // 不能有"关于 自动更新检测"和"项目主页"/GitHub
    expect(labels.some((l) => l.includes('关于'))).toBe(false);
    expect(labels.some((l) => l.includes('项目主页') || l.includes('GitHub'))).toBe(false);
  });
});

describe('showContact', () => {
  beforeEach(() => {
    showMessageBox.mockClear();
    writeText.mockClear();
  });

  it('调用 dialog.showMessageBox,显示邮箱', async () => {
    await showContact();
    expect(showMessageBox).toHaveBeenCalledOnce();
    const opts = (showMessageBox.mock.calls[0] as unknown as unknown[])[0] as {
      type: string; title: string; message: string; detail: string;
      buttons: string[]; defaultId: number; cancelId: number;
    };
    expect(opts.type).toBe('info');
    expect(opts.title).toBe('联系开发者');
    expect(opts.message).toBe('开发者邮箱');
    expect(opts.detail).toContain(DEVELOPER_EMAIL);
    expect(opts.detail).toContain('Bug');
    expect(opts.buttons).toEqual(['复制邮箱', '关闭']);
    expect(opts.defaultId).toBe(0);
    expect(opts.cancelId).toBe(1);
  });

  it('默认(关闭)不复制到剪贴板', async () => {
    showMessageBox.mockResolvedValueOnce({ response: 1 }); // "关闭"
    await showContact();
    expect(writeText).not.toHaveBeenCalled();
  });

  it('用户点"复制邮箱"→ 复制到剪贴板', async () => {
    showMessageBox.mockResolvedValueOnce({ response: 0 }); // "复制邮箱"
    await showContact();
    expect(writeText).toHaveBeenCalledWith(DEVELOPER_EMAIL);
  });
});
