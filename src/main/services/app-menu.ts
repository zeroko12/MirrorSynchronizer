/**
 * app-menu - 应用程序菜单栏
 *
 * 极简:一个 关于 菜单,只有"联系开发者"项
 * 点击后弹框显示开发者邮箱(用户可复制,不强制打开邮件客户端)
 *
 * Windows:顶部菜单栏(在窗口标题栏下)
 * macOS:第一个菜单是 app 名字(Apple HIG),所以第一个是 app 菜单,后面跟"关于"
 */

import { Menu, dialog, clipboard, type MenuItemConstructorOptions } from 'electron';
import { APP_DISPLAY_NAME } from '@core/constants';
import { mainLog } from '@core/logger';

const log = mainLog;

/** 开发者邮箱(支持反馈 / Bug 报告) */
export const DEVELOPER_EMAIL = 'zeroko12@foxmail.com';

/**
 * 设置应用菜单(顶部菜单栏)
 * 在 app.whenReady 后调用一次
 */
export function setAppMenu(): void {
  const isMac = process.platform === 'darwin';

  const template: MenuItemConstructorOptions[] = [
    // macOS:第一个菜单必须是 app 名字(Apple HIG)
    ...(isMac
      ? [{
          label: APP_DISPLAY_NAME,
          submenu: [
            { role: 'about' as const },
            { type: 'separator' as const },
            { role: 'hide' as const },
            { role: 'hideOthers' as const },
            { role: 'unhide' as const },
            { type: 'separator' as const },
            { role: 'quit' as const },
          ],
        }]
      : []),

    // 关于 菜单(Windows / Linux)— 只有"联系开发者"
    {
      label: '关于(&A)',
      submenu: [
        {
          label: '联系开发者',
          click: () => showContact(),
        },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  log.info('[app-menu] 应用菜单已设置');
}

/**
 * 联系开发者弹框
 * - 显示开发者邮箱
 * - "复制"按钮 → 复制到剪贴板
 * - "关闭"按钮 → 关闭弹框
 *
 * 设计原因:不强开系统默认邮件客户端(用户可能没装),
 *          弹框让用户直接看到邮箱 + 一键复制
 */
export function showContact(): void {
  dialog
    .showMessageBox({
      type: 'info',
      title: '联系开发者',
      message: '开发者邮箱',
      detail:
        `${DEVELOPER_EMAIL}\n\n` +
        `如有 Bug 报告、功能建议或合作意向,欢迎邮件联系。`,
      buttons: ['复制邮箱', '关闭'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    })
    .then((result) => {
      if (result.response === 0) {
        // 用户点"复制邮箱" → 复制到剪贴板 + 提示
        clipboard.writeText(DEVELOPER_EMAIL);
        log.info(`[app-menu] 已复制邮箱到剪贴板: ${DEVELOPER_EMAIL}`);
      }
    })
    .catch((err) => {
      log.warn('[app-menu] showContact failed:', err);
    });
}
