/**
 * remote/ws-hub - WebSocket 连接管理
 *
 * 职责:
 * - 接受新连接(已鉴权)
 * - 给所有 client 广播事件
 * - 给单个 client 发送定向消息
 *
 * WebSocket 消息协议(JSON):
 * - 服务端 → 客户端:
 *   - { type: "snapshot", data: RemoteState }    初始快照
 *   - { type: "sync-result", data: SyncResult }  一次同步完成
 *   - { type: "popup", data: { hash, ...counts } } 弹窗待决
 *   - { type: "popup-cleared", hash: string }     弹窗已关(本地关了 或 远程已决)
 * - 客户端 → 服务端:
 *   - { type: "ping" }                          心跳
 *   - { type: "decide", action: "apply"|"snooze"|"ignore", hash: string }  远程决策
 */

import { WebSocket, WebSocketServer, type RawData } from 'ws';
import type { IncomingMessage } from 'node:http';
import { verifyToken } from './auth.js';
import { mainLog } from '@core/logger';

const log = mainLog;

export interface WsHubOptions {
  /** 鉴权用 stable salt(用 config 路径 hash 即可) */
  stableSalt: string;
}

interface Client {
  ws: WebSocket;
  id: string;
  userId: string;
  connectedAt: number;
}

export class WsHub {
  private clients = new Map<string, Client>();
  private nextId = 0;

  constructor(private opts: WsHubOptions) {}

  /** 处理新连接(在 HTTP server upgrade 时调用) */
  handleUpgrade(ws: WebSocket, req: IncomingMessage): void {
    // 鉴权:从 query.token 拿 JWT
    const url = new URL(req.url ?? '/', 'http://localhost');
    const token = url.searchParams.get('token');
    if (!token) {
      log.warn('[ws-hub] reject: missing token');
      ws.close(4401, 'missing token');
      return;
    }
    let userId: string;
    try {
      const claims = verifyToken(token, this.opts.stableSalt);
      userId = claims.sub;
    } catch (err) {
      log.warn(`[ws-hub] reject: invalid token (${(err as Error).message})`);
      ws.close(4403, 'invalid token');
      return;
    }

    const id = `c${++this.nextId}`;
    const client: Client = { ws, id, userId, connectedAt: Date.now() };
    this.clients.set(id, client);
    log.info(`[ws-hub] +${id} (user=${userId}, total=${this.clients.size})`);

    ws.on('close', () => {
      this.clients.delete(id);
      log.info(`[ws-hub] -${id} (total=${this.clients.size})`);
    });
    ws.on('error', (err: Error) => {
      log.warn(`[ws-hub] ${id} error: ${err.message}`);
    });
    // 收到 ping → 忽略(WebSocket ping 帧,不需要处理)
    // 收到 client 消息 → 让主进程处理
    ws.on('message', (data: RawData) => {
      this.onMessage(client, data);
    });
  }

  /** 收到 client 消息的统一处理(这里只解析,业务由主进程路由) */
  private onMessage(client: Client, data: RawData): void {
    let msg: unknown;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      log.warn(`[ws-hub] ${client.id} sent invalid JSON`);
      return;
    }
    if (!msg || typeof msg !== 'object') return;
    const m = msg as Record<string, unknown>;
    if (m.type === 'ping') {
      client.ws.send(JSON.stringify({ type: 'pong' }));
    }
    // 业务消息(decision 等)由外部通过 wsHub.onClientMessage 注册的 handler 处理
    if (typeof m.type === 'string') {
      this.dispatchClientMessage(client, m as { type: string; [k: string]: unknown });
    }
  }

  /** 注册客户端消息 handler(由主进程设置) */
  private clientMessageHandler: ((client: Client, msg: { type: string; [k: string]: unknown }) => void) | null = null;
  onClientMessage(handler: (client: Client, msg: { type: string; [k: string]: unknown }) => void): void {
    this.clientMessageHandler = handler;
  }
  private dispatchClientMessage(client: Client, msg: { type: string; [k: string]: unknown }): void {
    if (this.clientMessageHandler) this.clientMessageHandler(client, msg);
  }

  /** 广播到所有 client */
  broadcast(payload: unknown): void {
    const data = JSON.stringify(payload);
    for (const c of this.clients.values()) {
      if (c.ws.readyState === c.ws.OPEN) {
        c.ws.send(data);
      }
    }
  }

  /** 关闭所有连接 */
  closeAll(): void {
    for (const c of this.clients.values()) {
      c.ws.close(1001, 'server shutdown');
    }
    this.clients.clear();
  }

  /** 当前连接数(用于 tray 显示) */
  get count(): number {
    return this.clients.size;
  }
}

/** 创建 WebSocketServer(供 HTTP server 的 upgrade handler 用) */
export function createWsServer(): WebSocketServer {
  return new WebSocketServer({ noServer: true });
}
