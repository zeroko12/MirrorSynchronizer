/**
 * auth.ts - 远程源 (HTTP/WebDAV) 认证解析与 Header 构建
 *
 * 支持两种认证协议:
 * 1. Basic Auth: Authorization: Basic <base64(username:password)>
 * 2. Cloudflare Access: CF-Access-Client-Id / CF-Access-Client-Secret
 *
 * 密钥解析机制:
 * - 若配置了 sourceAuthSecretEnv，优先从 process.env[sourceAuthSecretEnv] 读取运行时密钥
 * - 否则读取配置对象中的直接密码/密钥
 */

import type { SourceAuth } from './types.js';

/**
 * 解析运行时实际生效的 SourceAuth
 * - 若指定了 secretEnv，优先读取 process.env[secretEnv]
 * - 缺失环境变量时若直接配置有密钥则使用，否则密码/密钥为空字符串
 */
export function resolveEffectiveAuth(
  auth?: SourceAuth,
  secretEnv?: string,
): SourceAuth | undefined {
  if (!auth) return undefined;

  let envSecret: string | undefined;
  if (secretEnv && typeof secretEnv === 'string' && secretEnv.trim()) {
    const val = process.env[secretEnv.trim()];
    if (val !== undefined) {
      envSecret = val;
    }
  }

  if (auth.kind === 'basic') {
    return {
      kind: 'basic',
      username: auth.username,
      password: envSecret !== undefined ? envSecret : (auth.password ?? ''),
    };
  }

  if (auth.kind === 'cf-access') {
    return {
      kind: 'cf-access',
      clientId: auth.clientId,
      clientSecret: envSecret !== undefined ? envSecret : (auth.clientSecret ?? ''),
    };
  }

  return auth;
}

/**
 * 根据 SourceAuth 构建 HTTP 请求头
 */
export function buildAuthHeaders(auth?: SourceAuth): Record<string, string> | undefined {
  if (!auth) return undefined;

  if (auth.kind === 'basic') {
    const user = auth.username ?? '';
    const pass = auth.password ?? '';
    const token = Buffer.from(`${user}:${pass}`).toString('base64');
    return { Authorization: `Basic ${token}` };
  }

  if (auth.kind === 'cf-access') {
    const headers: Record<string, string> = {};
    if (auth.clientId) {
      headers['CF-Access-Client-Id'] = auth.clientId;
    }
    if (auth.clientSecret) {
      headers['CF-Access-Client-Secret'] = auth.clientSecret;
    }
    return Object.keys(headers).length > 0 ? headers : undefined;
  }

  return undefined;
}
