/**
 * errors 模块测试 - 错误分类器
 */

import { describe, it, expect } from 'vitest';
import {
  classifyErrno,
  isNetworkPath,
  isNetworkReason,
  formatFatalMessage,
  type PathErrorKind,
} from '../src/core/errors.js';

describe('classifyErrno', () => {
  const cases: Array<[string | undefined, string, PathErrorKind]> = [
    // ENOENT:区分本地 vs 网络
    ['ENOENT', 'C:/Users/test', 'not-found'],
    ['ENOENT', '/home/user/data', 'not-found'],
    ['ENOENT', '\\\\server\\share', 'network-not-found'],
    ['ENOENT', '//server/share', 'network-not-found'],
    ['ENOENT', '/mnt/smb/share', 'network-not-found'],
    ['ENOENT', '/Volumes/nas/data', 'network-not-found'],
    ['ENOENT', '/srv/cifs-backup', 'network-not-found'],
    // 网络类
    ['EHOSTUNREACH', 'C:/data', 'network-down'],
    ['ENETUNREACH', 'C:/data', 'network-down'],
    ['ENETDOWN', 'C:/data', 'network-down'],
    ['ENOTCONN', 'C:/data', 'network-down'],
    ['EIO', 'C:/data', 'network-down'],
    ['EPIPE', 'C:/data', 'network-down'],
    ['ECONNRESET', 'C:/data', 'network-down'],
    // 超时
    ['ETIMEDOUT', 'C:/data', 'timeout'],
    // 忙
    ['EBUSY', 'C:/data/file.txt', 'busy'],
    ['EAGAIN', 'C:/data', 'busy'],
    // 权限
    ['EACCES', 'C:/secret', 'permission-denied'],
    ['EPERM', 'C:/system', 'permission-denied'],
    // 磁盘
    ['ENOSPC', 'D:/full', 'disk-full'],
    ['EFBIG', 'D:/full', 'disk-full'],
    ['EDQUOT', 'D:/quota', 'disk-full'],
    // 未知
    ['EBADE', 'C:/data', 'unknown'],
    [undefined, 'C:/data', 'unknown'],
  ];

  for (const [code, path, expected] of cases) {
    it(`${code ?? 'undefined'} on ${path} → ${expected}`, () => {
      expect(classifyErrno(code, path)).toBe(expected);
    });
  }
});

describe('isNetworkPath', () => {
  it('识别 UNC 路径', () => {
    expect(isNetworkPath('\\\\server\\share')).toBe(true);
    expect(isNetworkPath('//server/share')).toBe(true);
    expect(isNetworkPath('\\\\192.168.1.1\\data')).toBe(true);
  });

  it('识别常见挂载点', () => {
    expect(isNetworkPath('/mnt/smb/share')).toBe(true);
    expect(isNetworkPath('/mnt/nas/data')).toBe(true);
    expect(isNetworkPath('/media/user/nas')).toBe(true);
    expect(isNetworkPath('/Volumes/share')).toBe(true);
  });

  it('识别 smb/cifs/nfs 关键词', () => {
    expect(isNetworkPath('/var/smb-backup/data')).toBe(true);
    expect(isNetworkPath('C:\\cifs\\share')).toBe(true);
    expect(isNetworkPath('/srv/nfs/data')).toBe(true);
  });

  it('本地路径不算网络', () => {
    expect(isNetworkPath('C:/Users/test')).toBe(false);
    expect(isNetworkPath('/home/user/data')).toBe(false);
    expect(isNetworkPath('D:/app/data')).toBe(false);
  });

  it('边界情况', () => {
    expect(isNetworkPath('')).toBe(false);
    expect(isNetworkPath('Z:\\')).toBe(false); // 盘符本身不是网络(挂载状态运行时才能判断)
  });
});

describe('isNetworkReason', () => {
  it('网络类为 true', () => {
    expect(isNetworkReason('network-down')).toBe(true);
    expect(isNetworkReason('network-not-found')).toBe(true);
    expect(isNetworkReason('timeout')).toBe(true);
  });

  it('非网络类为 false', () => {
    expect(isNetworkReason('not-found')).toBe(false);
    expect(isNetworkReason('permission-denied')).toBe(false);
    expect(isNetworkReason('busy')).toBe(false);
    expect(isNetworkReason('disk-full')).toBe(false);
    expect(isNetworkReason('unknown')).toBe(false);
    expect(isNetworkReason(null)).toBe(false);
    expect(isNetworkReason(undefined)).toBe(false);
  });
});

describe('formatFatalMessage', () => {
  it('网络不可达', () => {
    const msg = formatFatalMessage('network-not-found', 'source', '\\\\nas\\share');
    expect(msg).toContain('源目录');
    expect(msg).toContain('\\\\nas\\share');
    expect(msg).toContain('网络不可达');
  });

  it('权限不足', () => {
    const msg = formatFatalMessage('permission-denied', 'target', 'D:/app');
    expect(msg).toContain('目标目录');
    expect(msg).toContain('权限不足');
  });

  it('不存在', () => {
    const msg = formatFatalMessage('not-found', 'source', 'C:/missing');
    expect(msg).toContain('源目录');
    expect(msg).toContain('不存在');
  });

  it('磁盘满', () => {
    const msg = formatFatalMessage('disk-full', 'target', 'D:/data');
    expect(msg).toContain('磁盘');
    expect(msg).toContain('空间');
  });

  it('映射角色', () => {
    const msg = formatFatalMessage('network-not-found', 'mapping', '\\\\nas\\file.txt');
    expect(msg).toContain('映射文件');
  });
});
