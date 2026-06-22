/**
 * remote/mdns - mDNS 服务广播(LAN 自动发现)
 *
 * 广播 `mirror-sync._http._tcp.local` 服务,让同 LAN 的设备
 * 通过 `http://mirror-sync.local:9527` 直接访问
 *
 * 注意:.local TLD 在某些浏览器 / 系统需要 mDNSResponder 支持
 *  - macOS / iOS:✅ 内建
 *  - Windows:需要 Bonjour Print Services 或 Win10+ 内建(mDNS 解析)
 *  - Linux:Avahi
 *
 * 失败是 best-effort:广播失败不影响 HTTP server 工作
 */

import multicastDns from 'multicast-dns';
import { mainLog } from '@core/logger';

const log = mainLog;

export interface MdnsHandle {
  close: () => void;
}

const SERVICE_NAME = 'mirror-sync';
const SERVICE_TYPE = 'http'; // _http._tcp.local

/**
 * 启动 mDNS 广播
 * @param port HTTP 端口
 * @param host 本机 IP(供 mDNS 响应)
 */
export function startMdns(port: number, host: string): MdnsHandle {
  let mdns: ReturnType<typeof multicastDns> | null = null;
  try {
    mdns = multicastDns();
  } catch (err) {
    log.warn(`[mdns] 启动失败(LAN 自动发现不可用): ${(err as Error).message}`);
    return { close: () => undefined };
  }

  const txt = {
    // 标准字段
    path: '/',
    // 我们的字段
    app: SERVICE_NAME,
    ver: '0.2.0',
  };

  mdns.on('query', (query: { questions: Array<{ type: string; name: string }> }) => {
    const hasOurService = query.questions.some(
      (q: { type: string; name: string }) => q.type === 'PTR' && q.name === `_${SERVICE_TYPE}._tcp.local`,
    );
    if (!hasOurService) return;

    const answers = [
      {
        name: `_${SERVICE_TYPE}._tcp.local`,
        type: 'PTR',
        data: `${SERVICE_NAME}._${SERVICE_TYPE}._tcp.local`,
        ttl: 60,
      },
      {
        name: `${SERVICE_NAME}._${SERVICE_TYPE}._tcp.local`,
        type: 'SRV',
        data: {
          port,
          target: host,
          priority: 0,
          weight: 0,
        },
        ttl: 60,
      },
      {
        name: `${SERVICE_NAME}._${SERVICE_TYPE}._tcp.local`,
        type: 'TXT',
        data: txt,
        ttl: 60,
      },
      {
        name: `${host}`,
        type: 'A',
        data: host,
        ttl: 60,
      },
    ];
    for (const ans of answers) {
      mdns!.respond(ans as never);
    }
    log.debug?.(`[mdns] 响应 PTR 查询 (${query.questions.length} questions)`);
  });

  log.info(`[mdns] 广播服务: http://${SERVICE_NAME}.local:${port} (host=${host})`);

  return {
    close: () => {
      try {
        mdns?.destroy();
      } catch {
        // ignore
      }
    },
  };
}
