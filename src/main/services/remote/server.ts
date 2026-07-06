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
      // 加 90s 上限:runNow 包含 preflight + sync + launch,SMB/网络源卡住时会拖很久
      // 超时后仍然发 ack(失败状态),让 web 端不卡转圈
      const SYNC_TIMEOUT_MS = 90_000;
      void (async () => {
        let caughtErr: unknown = null;
        let result: unknown = null;
        try {
          result = await Promise.race([
            Promise.resolve(deps.onRemoteRunNow()),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error(`remote run-sync 超时 ${SYNC_TIMEOUT_MS / 1000}s`)), SYNC_TIMEOUT_MS),
            ),
          ]);
        } catch (err) {
          caughtErr = err;
        }
        const ack = buildRunSyncAck(result, caughtErr);
        log.info(
          `[server] remote run-sync done ok=${ack.ok} added=${ack.added} modified=${ack.modified} deleted=${ack.deleted}` +
          (ack.fatal ? ` fatal=${ack.fatal}` : ''),
        );
        if (client.ws.readyState === client.ws.OPEN) {
          client.ws.send(JSON.stringify({
            type: 'run-sync-ack',
            ...ack,
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

/**
 * run-sync 消息回传的 ack 字段。
 * 暴露成纯函数给单元测试,避免通过 ws/http 间接测。
 */
export interface RunSyncAck {
  ok: boolean;
  fatal: string | null;
  added: number;
  modified: number;
  deleted: number;
}

/**
 * 把 onRemoteRunNow() 的返回值(+ 捕获的异常)归一化为 web UI 用的 ack。
 *
 * 之前的版本只 `result != null` 判 ok → fatalError 也会报成功。
 *   用户感受"显示同步成功,但实际上并没有同步成功"。
 * 现在正确判定:
 *   - 异常 → ok=false + fatal=err.message
 *   - result 为 null / 非对象 → ok=false + fatal="scheduler 未返回结果"
 *   - result.ok=false → ok=false + fatal=result.fatalError
 *   - result.ok=true  → ok=true + added/modified/deleted 计数
 */
export function buildRunSyncAck(result: unknown, caughtErr: unknown = null): RunSyncAck {
  if (caughtErr) {
    const msg = caughtErr instanceof Error ? caughtErr.message : String(caughtErr);
    return { ok: false, fatal: msg, added: 0, modified: 0, deleted: 0 };
  }
  if (!result || typeof result !== 'object' || !('ok' in result)) {
    return { ok: false, fatal: 'scheduler 未返回结果', added: 0, modified: 0, deleted: 0 };
  }
  const r = result as {
    ok: unknown;
    fatalError?: unknown;
    added?: unknown;
    modified?: unknown;
    deleted?: unknown;
  };
  if (r.ok !== true) {
    const fatal = typeof r.fatalError === 'string' ? r.fatalError : '同步失败';
    return { ok: false, fatal, added: 0, modified: 0, deleted: 0 };
  }
  return {
    ok: true,
    fatal: null,
    added: Array.isArray(r.added) ? r.added.length : 0,
    modified: Array.isArray(r.modified) ? r.modified.length : 0,
    deleted: Array.isArray(r.deleted) ? r.deleted.length : 0,
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
  // 1. 打包后:electron-builder 把 resources/ 拷到 process.resourcesPath
  //    (Linux/Win:/usr/lib/auto-updater/resources/;macOS:Auto Updater.app/Contents/Resources/)
  //    我们需要的是 <resources>/remote-ui/
  const resPath = process.resourcesPath;
  if (resPath) {
    const candidate = join(resPath, 'remote-ui');
    if (existsSync(candidate)) return candidate;
  }
  // 2. 开发期:从 server.ts 位置向上找项目根(找 package.json)
  let dir = dirname(fileURLToPath(import.meta.url));
  while (dir !== dirname(dir)) {
    if (existsSync(join(dir, 'package.json'))) {
      const candidate = join(dir, 'resources', 'remote-ui');
      if (existsSync(candidate)) return candidate;
    }
    dir = dirname(dir);
  }
  // 3. 兜底:当前工作目录
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
