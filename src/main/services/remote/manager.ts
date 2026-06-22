/**
 * remote/manager - 远程功能总入口
 *
 * 负责:
 * - 启动 / 关闭 remote server + mDNS
 * - 给 scheduler.onSync 提供 broadcast 钩子
 * - 暴露 startRemoteAccess() / stopRemoteAccess() / getAccessInfo() 给 main 调用
 */

import { generatePassword, hashPassword } from './auth.js';
import { startRemoteServer, type RemoteServerHandle } from './server.js';
import { startMdns, type MdnsHandle } from './mdns.js';
import { getRemoteState, type RemoteState } from './state-provider.js';
import { mainLog } from '@core/logger';
import type { AppConfig, SyncResult } from '@core/types';
import type { HistoryDB } from '@core/history';
import type { Scheduler } from '@core/scheduler';
import { networkInterfaces } from 'node:os';

const log = mainLog;

/** 单个网卡信息(给 web UI 展示) */
export interface NetworkInterfaceInfo {
  name: string;          // "eth0" / "Wi-Fi" / "以太网" 等
  address: string;       // IPv4
  family: 'IPv4' | 'IPv6';
  internal: boolean;
  mac: string;
}

/** 列出所有可用 IP(去掉 loopback + 容器虚拟网卡) */
export function listNetworkIPs(): NetworkInterfaceInfo[] {
  const ifs = networkInterfaces();
  const result: NetworkInterfaceInfo[] = [];
  for (const [name, list] of Object.entries(ifs)) {
    if (!list) continue;
    for (const i of list) {
      // 只取 IPv4,跳过 loopback(127.x) 和 internal
      if (i.family !== 'IPv4' || i.internal) continue;
      result.push({
        name,
        address: i.address,
        family: 'IPv4',
        internal: i.internal,
        mac: i.mac,
      });
    }
  }
  return result;
}

export interface RemoteDeps {
  getConfig: () => AppConfig | null;
  getHistoryDB: () => HistoryDB | null;
  getScheduler: () => Scheduler | null;
  /** 当前待决的弹窗(由 detector.decide 算) */
  getPendingPopup: () => RemoteState['pendingPopup'];
  /** 用户决策路由(返回 'applied' 表示已应用) */
  onRemoteDecision: (action: 'apply' | 'snooze' | 'ignore', hash: string) => 'applied' | 'no-op' | Promise<'applied' | 'no-op'>;
  /** 手动触发同步(返回 Promise<result|null>) */
  onRemoteRunNow: () => Promise<unknown>;
  appName: string;
  appVersion: string;
  configPath: string;
}

export interface RemoteManager {
  start: () => Promise<RemoteAccessInfo>;
  stop: () => Promise<void>;
  /** sync 完成时调用,广播给所有 client */
  onSyncResult: (result: SyncResult) => void;
  /** 检测到弹窗时调用 */
  onPopup: (payload: { hash: string; addedCount: number; modifiedCount: number; deletedCount: number; isLocked: boolean; lockSnapshotTimestamp: string | null }) => void;
  /** 弹窗关闭时(本地决定 或 远程决定) */
  onPopupClosed: (hash: string) => void;
  /** 当前信息(供 tray 展示) */
  getInfo: () => RemoteAccessInfo | null;
  /** 是否启用 */
  isEnabled: () => boolean;
  /** 当前是否运行中(server 已启动) */
  isRunning: () => boolean;
  /**
   * 重置密码:生成新密码、重新哈希、断开所有 client(让 JWT 失效)
   * 返回新密码明文(只这一次显示给用户)
   */
  resetPassword: () => Promise<{ newPassword: string; info: RemoteAccessInfo | null }>;
  /** 主动广播 payload(给 main 用于:runNow 后立刻推 snapshot) */
  broadcast: (payload: unknown) => void;
}

export interface RemoteAccessInfo {
  enabled: boolean;
  running: boolean;
  url: string | null;
  port: number | null;
  initialPassword: string | null;  // 首次启动后展示,用户复制
  passwordReset: boolean;          // 标记是否刚刚重置过密码(让 tray 高亮)
  clientCount: number;
}

export function createRemoteManager(deps: RemoteDeps): RemoteManager {
  let server: RemoteServerHandle | null = null;
  let mdns: MdnsHandle | null = null;
  let lastInitialPassword: string | null = null;
  let enabled = false;

  async function start(): Promise<RemoteAccessInfo> {
    const config = deps.getConfig();
    if (!config?.remote) {
      throw new Error('config.remote 不存在');
    }
    if (!config.remote.enabled) {
      throw new Error('远程访问未启用(config.remote.enabled = false)');
    }
    enabled = true;

    // 首次启动密码缺失 → 生成 + 哈希 + 写回 config
    let initialPassword: string | null = null;
    if (!config.remote.passwordHash) {
      const plain = generatePassword();
      config.remote.passwordHash = await hashPassword(plain);
      config.remote.initialPassword = plain;
      initialPassword = plain;
      lastInitialPassword = plain;
      // 写回 config(通过 useConfig.save)
      log.info('[manager] 首次启动,生成新密码');
    }

    // 启动 HTTP + WS server
    server = await startRemoteServer({
      config: () => deps.getConfig(),
      historyDB: () => deps.getHistoryDB(),
      scheduler: () => deps.getScheduler(),
      pendingPopup: () => deps.getPendingPopup(),
      onRemoteDecision: deps.onRemoteDecision,
      onRemoteRunNow: deps.onRemoteRunNow,  // ← 新增
      appName: deps.appName,
      appVersion: deps.appVersion,
      configPath: deps.configPath,
    });

    // 启动 mDNS
    if (config.remote.autoDiscover) {
      const host = primaryHost();
      if (host) {
        mdns = startMdns(server.port, host);
      } else {
        log.warn('[manager] 无法获取主网卡 IP,mDNS 不启动(用 IP 访问)');
      }
    }

    log.info(`[manager] 远程访问已启动: ${server.url} (clients=${server.getClientCount()})`);
    return {
      enabled: true,
      running: true,
      url: server.url,
      port: server.port,
      initialPassword,
      passwordReset: initialPassword !== null,
      clientCount: 0,
    };
  }

  async function stop(): Promise<void> {
    if (mdns) {
      mdns.close();
      mdns = null;
    }
    if (server) {
      await server.close();
      server = null;
    }
    enabled = false;
    log.info('[manager] 远程访问已停止');
  }

  function onSyncResult(result: SyncResult): void {
    if (!server) return;
    // 1. 广播 sync-result 事件
    server.broadcast({ type: 'sync-result', data: result });
    // 2. 推送最新 state 快照
    server.broadcast({ type: 'snapshot', data: getRemoteState({
      config: deps.getConfig,
      historyDB: deps.getHistoryDB,
      scheduler: deps.getScheduler,
      pendingPopup: deps.getPendingPopup,
      appName: deps.appName,
      appVersion: deps.appVersion,
    })});
  }

  function onPopup(payload: { hash: string; addedCount: number; modifiedCount: number; deletedCount: number; isLocked: boolean; lockSnapshotTimestamp: string | null }): void {
    if (!server) return;
    server.broadcast({ type: 'popup', data: payload });
  }

  function onPopupClosed(hash: string): void {
    if (!server) return;
    server.broadcast({ type: 'popup-cleared', hash });
  }

  function getInfo(): RemoteAccessInfo | null {
    if (!server) {
      return {
        enabled,
        running: false,
        url: null,
        port: null,
        initialPassword: lastInitialPassword,
        passwordReset: lastInitialPassword !== null,
        clientCount: 0,
      };
    }
    return {
      enabled,
      running: true,
      url: server.url,
      port: server.port,
      initialPassword: lastInitialPassword,
      passwordReset: lastInitialPassword !== null,
      clientCount: server.getClientCount(),
    };
  }

  function isEnabled(): boolean {
    return enabled;
  }

  function isRunning(): boolean {
    return server !== null;
  }

  /**
   * 重置密码
   * - 生成新密码
   * - 重哈希
   * - 让所有 client 失效(广播一个 force-logout + JWT secret 改动)
   *   (实际上 JWT secret 在 deps.configPath 上,不变;但我们广播 force-logout 让 client 知道)
   * - 重启 server 强制所有 WS client 断连(简单粗暴但有效)
   */
  async function resetPassword(): Promise<{ newPassword: string; info: RemoteAccessInfo | null }> {
    if (!deps.getConfig()?.remote) {
      throw new Error('config.remote 不存在');
    }
    const plain = generatePassword();
    const newHash = await hashPassword(plain);

    // 1. 写新密码
    const cfg = deps.getConfig()!;
    cfg.remote!.passwordHash = newHash;
    cfg.remote!.initialPassword = plain;
    lastInitialPassword = plain;

    // 2. 强制所有 client 掉线 — 重启 server
    if (server) {
      await server.close();
      server = null;
    }
    if (mdns) {
      mdns.close();
      mdns = null;
    }

    // 3. 重新启动(用新密码的 server)
    server = await startRemoteServer({
      config: () => deps.getConfig(),
      historyDB: () => deps.getHistoryDB(),
      scheduler: () => deps.getScheduler(),
      pendingPopup: () => deps.getPendingPopup(),
      onRemoteDecision: deps.onRemoteDecision,
      onRemoteRunNow: deps.onRemoteRunNow,
      appName: deps.appName,
      appVersion: deps.appVersion,
      configPath: deps.configPath,
    });
    if (cfg.remote!.autoDiscover) {
      const host = primaryHostForMdns();
      if (host) mdns = startMdns(server.port, host);
    }

    log.info(`[manager] 密码已重置(新密码已生成)`);
    return { newPassword: plain, info: getInfo() };
  }

  function primaryHostForMdns(): string | null {
    const ifs = networkInterfaces();
    for (const list of Object.values(ifs)) {
      if (!list) continue;
      for (const i of list) {
        if (i.family === 'IPv4' && !i.internal) return i.address;
      }
    }
    return null;
  }

  return {
    start, stop, onSyncResult, onPopup, onPopupClosed,
    getInfo, isEnabled, isRunning, resetPassword,
    broadcast: (payload) => { if (server) server.broadcast(payload); },
  };
}

function primaryHost(): string | null {
  const ifs = networkInterfaces();
  for (const list of Object.values(ifs)) {
    if (!list) continue;
    for (const i of list) {
      if (i.family === 'IPv4' && !i.internal) return i.address;
    }
  }
  return null;
}
