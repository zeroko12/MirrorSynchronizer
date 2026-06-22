/**
 * remote/server - Express HTTP + WebSocket
 *
 * 端点:
 * - GET  /                   → 静态 UI(单页 Vue 3 from CDN)
 * - GET  /api/state          → 完整状态快照(JSON,需 JWT)
 * - POST /api/login          → 密码 → JWT(JSON,公开)
 * - GET  /api/version        → { name, version }(公开)
 * - GET  /ws                 → WebSocket(需 ?token=JWT)
 *
 * 安全:
 * - bind 0.0.0.0 让同 LAN 可访问
 * - JWT 1 小时过期
 * - 静态 UI 不含敏感数据(运行时拉)
 */

import express, { type Request, type Response, type NextFunction, type Express } from 'express';
import { createServer, type Server as HttpServer } from 'node:http';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WsHub, createWsServer } from './ws-hub.js';
import {
  verifyPassword,
  issueToken,
  extractBearerToken,
  verifyToken,
} from './auth.js';
import { getRemoteState, type RemoteState } from './state-provider.js';
import { mainLog } from '@core/logger';
import { APP_DISPLAY_NAME } from '@core/constants';
import type { AppConfig } from '@core/types';
import type { HistoryDB } from '@core/history';
import type { Scheduler } from '@core/scheduler';

const log = mainLog;

export interface ServerDeps {
  config: () => AppConfig | null;
  historyDB: () => HistoryDB | null;
  scheduler: () => Scheduler | null;
  pendingPopup: () => RemoteState['pendingPopup'];
  /** 远程决策回调(返回 'applied' | 'cleared' | 'no-op') */
  onRemoteDecision: (action: 'apply' | 'snooze' | 'ignore', hash: string) => 'applied' | 'no-op' | Promise<'applied' | 'no-op'>;
  /** 远程手动同步 */
  onRemoteRunNow: () => Promise<unknown>;
  appName: string;
  appVersion: string;
  /** 配置路径 hash → 作 JWT secret salt */
  configPath: string;
}

export interface RemoteServerHandle {
  port: number;
  url: string;             // http://<host>:<port>
  close: () => Promise<void>;
  /** 广播事件到所有 WS client */
  broadcast: (payload: unknown) => void;
  /** 当前 client 数 */
  getClientCount: () => number;
}

/**
 * 启动 remote server
 * 失败抛(端口占用等)
 */
export async function startRemoteServer(deps: ServerDeps): Promise<RemoteServerHandle> {
  const config = deps.config();
  if (!config?.remote?.enabled) {
    throw new Error('远程服务器未启用(config.remote.enabled = false)');
  }
  if (!config.remote.passwordHash) {
    throw new Error('远程服务器未配置密码(passwordHash 为空)');
  }
  const port = config.remote.port;
  const stableSalt = deps.configPath; // 用绝对路径作 salt(同一 config 派生同一 secret)

  const app: Express = express();
  app.use(express.json({ limit: '32kb' }));

  // ---- CORS(同 LAN,简单允许)----
  app.use((_req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    next();
  });

  // ---- 公开端点 ----
  app.get('/api/version', (_req, res) => {
    res.json({ name: APP_DISPLAY_NAME, version: deps.appVersion });
  });

  app.post('/api/login', async (req, res) => {
    const { password } = req.body ?? {};
    if (typeof password !== 'string') {
      res.status(400).json({ error: 'missing password' });
      return;
    }
    const ok = await verifyPassword(password, config.remote!.passwordHash);
    if (!ok) {
      log.warn('[server] login failed');
      res.status(401).json({ error: 'invalid password' });
      return;
    }
    const token = issueToken('user', stableSalt);
    log.info('[server] login ok');
    res.json({ token, ttl: 60 * 60 });
  });

  // ---- 鉴权中间件 ----
  const requireAuth = (req: Request, res: Response, next: NextFunction): void => {
    const token = extractBearerToken(req.header('Authorization'));
    if (!token) {
      res.status(401).json({ error: 'missing token' });
      return;
    }
    try {
      verifyToken(token, stableSalt);
      next();
    } catch {
      res.status(401).json({ error: 'invalid token' });
    }
  };

  // ---- 鉴权端点 ----
  app.get('/api/state', requireAuth, (_req, res) => {
    res.json(getRemoteState(deps));
  });

  // ---- 静态 UI ----
  const uiDir = resolveUiDir();
  app.use(express.static(uiDir, { index: 'index.html' }));

  // ---- HTTP + WS server ----
  const httpServer = createServer(app);
  const wsServer = createWsServer();
  const wsHub = new WsHub({ stableSalt });

  // 注册 client 消息路由(目前只处理 decision / run-sync)
  wsHub.onClientMessage((client, msg) => {
    if (msg.type === 'decide') {
      const action = msg.action as string;
      const hash = msg.hash as string;
      if (!['apply', 'snooze', 'ignore'].includes(action) || typeof hash !== 'string') {
        client.ws.send(JSON.stringify({ type: 'error', error: 'bad decide payload' }));
        return;
      }
      // 异步处理决策(可能涉及文件 I/O)
      void (async () => {
        const result = await Promise.resolve(
          deps.onRemoteDecision(action as 'apply' | 'snooze' | 'ignore', hash),
        );
        log.info(`[server] remote decide ${action} hash=${hash.slice(0, 8)}... → ${result}`);
        if (client.ws.readyState === client.ws.OPEN) {
          client.ws.send(JSON.stringify({ type: 'decision-ack', action, hash, result }));
        }
        if (result === 'applied') {
          wsHub.broadcast({ type: 'popup-cleared', hash });
        }
      })();
    } else if (msg.type === 'run-sync') {
      // 远程手动触发同步
      void (async () => {
        const result = await Promise.resolve(deps.onRemoteRunNow());
        log.info('[server] remote run-sync done');
        if (client.ws.readyState === client.ws.OPEN) {
          client.ws.send(JSON.stringify({
            type: 'run-sync-ack',
            ok: result != null,
          }));
        }
      })();
    }
  });

  httpServer.on('upgrade', (req, socket, head) => {
    if (req.url?.startsWith('/ws')) {
      wsServer.handleUpgrade(req, socket, head, (ws) => {
        wsHub.handleUpgrade(ws, req);
      });
    } else {
      socket.destroy();
    }
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', (err) => reject(err));
    httpServer.listen(port, '0.0.0.0', () => {
      httpServer.off('error', reject);
      resolve();
    });
  });

  const actualPort = (httpServer.address() as { port: number } | null)?.port ?? port;
  const host = primaryHost() ?? '127.0.0.1';
  const url = `http://${host}:${actualPort}`;
  log.info(`[server] 远程服务器已启动: ${url}`);

  return {
    port: actualPort,
    url,
    broadcast: (payload) => wsHub.broadcast(payload),
    getClientCount: () => wsHub.count,
    close: () => closeRemoteServer(httpServer, wsServer, wsHub),
  };
}

async function closeRemoteServer(
  httpServer: HttpServer,
  wsServer: ReturnType<typeof createWsServer>,
  wsHub: WsHub,
): Promise<void> {
  wsHub.closeAll();
  await new Promise<void>((resolve) => wsServer.close(() => resolve()));
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  log.info('[server] 远程服务器已关闭');
}

/** UI 静态文件目录 */
function resolveUiDir(): string {
  // 从 server.ts 位置向上找项目根(找 package.json)
  let dir = dirname(fileURLToPath(import.meta.url));
  while (dir !== dirname(dir)) {
    if (existsSync(join(dir, 'package.json'))) {
      const candidate = join(dir, 'resources', 'remote-ui');
      if (existsSync(candidate)) return candidate;
    }
    dir = dirname(dir);
  }
  // 兜底:当前工作目录
  return join(process.cwd(), 'resources', 'remote-ui');
}

/** 拿主网卡 IP(给 web UI 显示) */
function primaryHost(): string | null {
  const { networkInterfaces } = require('node:os') as typeof import('node:os');
  const ifs = networkInterfaces();
  for (const list of Object.values(ifs)) {
    if (!list) continue;
    for (const i of list) {
      if (i.family === 'IPv4' && !i.internal) return i.address;
    }
  }
  return null;
}
