/**
 * notification service 单元测试
 *
 * 用 mock 替换 electron.Notification,验证:
 * - 致命错误分类触发对应 Toast
 * - 网络类前 1 次静默,>=2 次弹
 * - wasNetworkDown 跟踪 + notifyRecovered 触发恢复通知
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { notifications, NotificationMock } = vi.hoisted(() => {
  const notifications: Array<{ title: string; body: string }> = [];
  const NotificationMock = vi.fn().mockImplementation((opts: { title: string; body: string }) => ({
    show: () => {
      notifications.push(opts);
    },
  })) as unknown as {
    (...args: unknown[]): { show: () => void };
    isSupported: () => boolean;
    mockClear: () => void;
  };
  NotificationMock.isSupported = () => true;
  NotificationMock.mockClear = () => {};
  return { notifications, NotificationMock };
});

vi.mock('electron', () => ({
  Notification: NotificationMock,
}));

import {
  showNotification,
  handleFatalErrorToast,
  notifyRecovered,
  setWasNetworkDown,
  getWasNetworkDown,
} from '../src/main/services/notification.js';
import type { PathErrorKind } from '../src/core/errors.js';

describe('notification service', () => {
  beforeEach(() => {
    notifications.splice(0, notifications.length);
    NotificationMock.mockClear();
    setWasNetworkDown(false);
  });

  afterEach(() => {
    setWasNetworkDown(false);
  });

  describe('showNotification', () => {
    it('应该调用 Notification.show 并 push 到通知列表', () => {
      showNotification('标题', '内容');
      expect(notifications).toEqual([{ title: '标题', body: '内容' }]);
    });

    it('连续调用 3 次,3 条都入栈', () => {
      showNotification('a', '1');
      showNotification('b', '2');
      showNotification('c', '3');
      expect(notifications.length).toBe(3);
    });
  });

  describe('handleFatalErrorToast', () => {
    const cases: Array<{ reason: PathErrorKind; expectTitleContains: string; expectSilent: boolean }> = [
      { reason: 'permission-denied', expectTitleContains: '权限不足', expectSilent: false },
      { reason: 'disk-full', expectTitleContains: '磁盘', expectSilent: false },
      { reason: 'not-found', expectTitleContains: '路径不存在', expectSilent: false },
      { reason: 'busy', expectTitleContains: '同步失败', expectSilent: false },
      { reason: 'unknown', expectTitleContains: '同步失败', expectSilent: false },
    ];

    for (const c of cases) {
      it(`非网络类 ${c.reason} → 立即弹 Toast`, () => {
        handleFatalErrorToast(c.reason, 0, null);
        expect(notifications.length).toBe(1);
        expect(notifications[0].title).toContain(c.expectTitleContains);
      });
    }

    it('网络类 network-down 第 1 次静默(consecutiveNetwork=1)', () => {
      handleFatalErrorToast('network-down', 1, null);
      expect(notifications.length).toBe(0);
      expect(getWasNetworkDown()).toBe(true);
    });

    it('网络类 network-down 第 2 次弹(consecutiveNetwork=2)', () => {
      handleFatalErrorToast('network-down', 2, null);
      expect(notifications.length).toBe(1);
      expect(notifications[0].title).toBe('网络不可达');
      expect(notifications[0].body).toContain('连续 2');
    });

    it('网络类 network-down 第 5 次 + 有 nextRunDelayMs → 弹且带重试秒数', () => {
      handleFatalErrorToast('network-down', 5, 120_000);
      expect(notifications.length).toBe(1);
      expect(notifications[0].body).toContain('120s 后重试');
    });

    it('网络类 network-not-found 同样静默→弹的策略', () => {
      handleFatalErrorToast('network-not-found', 1, null);
      expect(notifications.length).toBe(0);
      handleFatalErrorToast('network-not-found', 3, null);
      expect(notifications.length).toBe(1);
    });

    it('网络类 timeout 同样驱动 wasNetworkDown', () => {
      handleFatalErrorToast('timeout', 1, null);
      expect(getWasNetworkDown()).toBe(true);
      expect(notifications.length).toBe(0);
    });
  });

  describe('网络恢复', () => {
    it('notifyRecovered 发"已恢复"通知', () => {
      setWasNetworkDown(true);
      notifyRecovered();
      expect(notifications.length).toBe(1);
      expect(notifications[0].body).toBe('已恢复同步');
    });

    it('调用 notifyRecovered 后,调用方应手动清 wasNetworkDown(模块不自动清)', () => {
      setWasNetworkDown(true);
      notifyRecovered();
      // 注意:notifyRecovered 不自动清状态 — 由 onSync 回调的"成功路径"手动清
      expect(getWasNetworkDown()).toBe(true);
    });
  });
});
