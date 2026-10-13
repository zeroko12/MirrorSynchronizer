/**
 * auth.test.ts - 验证 SourceAuth 解析与 Header 构建
 */

import { describe, it, expect } from 'vitest';
import { buildAuthHeaders, resolveEffectiveAuth } from '../src/core/auth.js';
import type { SourceAuth } from '../src/core/types.js';

describe('buildAuthHeaders', () => {
  it('returns undefined when auth is undefined', () => {
    expect(buildAuthHeaders(undefined)).toBeUndefined();
  });

  it('generates Basic Auth header with base64 encoded user:pass', () => {
    const auth: SourceAuth = { kind: 'basic', username: 'alice', password: 'secret123' };
    const headers = buildAuthHeaders(auth);
    expect(headers).toEqual({
      Authorization: 'Basic ' + Buffer.from('alice:secret123').toString('base64'),
    });
  });

  it('handles empty password in Basic Auth', () => {
    const auth: SourceAuth = { kind: 'basic', username: 'bob', password: '' };
    const headers = buildAuthHeaders(auth);
    expect(headers).toEqual({
      Authorization: 'Basic ' + Buffer.from('bob:').toString('base64'),
    });
  });

  it('generates Cloudflare Access Service Token headers', () => {
    const auth: SourceAuth = {
      kind: 'cf-access',
      clientId: 'service-client-id-xyz',
      clientSecret: 'service-client-secret-abc',
    };
    const headers = buildAuthHeaders(auth);
    expect(headers).toEqual({
      'CF-Access-Client-Id': 'service-client-id-xyz',
      'CF-Access-Client-Secret': 'service-client-secret-abc',
    });
  });
});

describe('resolveEffectiveAuth', () => {
  it('returns undefined if auth is undefined', () => {
    expect(resolveEffectiveAuth(undefined)).toBeUndefined();
  });

  it('uses direct password when secretEnv is not specified', () => {
    const auth: SourceAuth = { kind: 'basic', username: 'testuser', password: 'my-pass' };
    const resolved = resolveEffectiveAuth(auth);
    expect(resolved).toEqual({
      kind: 'basic',
      username: 'testuser',
      password: 'my-pass',
    });
  });

  it('reads secret from process.env when secretEnv is specified and present', () => {
    const envKey = 'TEST_SYNC_AUTH_PASS_12345';
    process.env[envKey] = 'env-super-secret';
    try {
      const auth: SourceAuth = { kind: 'basic', username: 'testuser', password: '' };
      const resolved = resolveEffectiveAuth(auth, envKey);
      expect(resolved).toEqual({
        kind: 'basic',
        username: 'testuser',
        password: 'env-super-secret',
      });
    } finally {
      delete process.env[envKey];
    }
  });

  it('reads Cloudflare Access clientSecret from process.env when secretEnv is specified', () => {
    const envKey = 'TEST_SYNC_CF_SECRET_67890';
    process.env[envKey] = 'env-cf-secret-token';
    try {
      const auth: SourceAuth = { kind: 'cf-access', clientId: 'cf-id-123', clientSecret: '' };
      const resolved = resolveEffectiveAuth(auth, envKey);
      expect(resolved).toEqual({
        kind: 'cf-access',
        clientId: 'cf-id-123',
        clientSecret: 'env-cf-secret-token',
      });
    } finally {
      delete process.env[envKey];
    }
  });

  it('falls back to direct secret if environment variable is not defined', () => {
    const envKey = 'NON_EXISTENT_ENV_VAR_ABCDEF';
    delete process.env[envKey];
    const auth: SourceAuth = { kind: 'basic', username: 'testuser', password: 'fallback-pass' };
    const resolved = resolveEffectiveAuth(auth, envKey);
    expect(resolved).toEqual({
      kind: 'basic',
      username: 'testuser',
      password: 'fallback-pass',
    });
  });
});
