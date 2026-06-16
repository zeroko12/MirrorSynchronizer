/**
 * Indexer 测试
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { Indexer } from '../src/core/indexer.js';
import { makeTempDir, rmTemp, writeTree, writeFile } from './helpers.js';

describe('Indexer', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await makeTempDir('idx-');
  });

  afterEach(async () => {
    await rmTemp(dir);
  });

  it('空目录:返回空数组', async () => {
    const indexer = new Indexer();
    const result = await indexer.scan(dir);
    expect(result.fatal).toBe(false);
    expect(result.files).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('目录不存在:fatal=true', async () => {
    const indexer = new Indexer();
    const result = await indexer.scan(join(dir, 'no-such-dir'));
    expect(result.fatal).toBe(true);
    expect(result.files).toEqual([]);
  });

  it('递归扫描,返回所有文件(相对路径用正斜杠)', async () => {
    await writeTree(dir, [
      { relPath: 'a.txt', content: 'aaa' },
      { relPath: 'b/c.txt', content: 'ccc' },
      { relPath: 'b/d/e.txt', content: 'eee' },
    ]);
    const indexer = new Indexer();
    const result = await indexer.scan(dir);

    expect(result.fatal).toBe(false);
    const paths = result.files.map((f) => f.relPath).sort();
    expect(paths).toEqual(['a.txt', 'b/c.txt', 'b/d/e.txt']);
    for (const f of result.files) {
      expect(f.relPath).not.toContain('\\');
    }
  });

  it('返回正确的 size 和 mtime', async () => {
    await writeFile(join(dir, 'x.txt'), 'hello');
    const indexer = new Indexer();
    const result = await indexer.scan(dir);
    expect(result.files.length).toBe(1);
    expect(result.files[0].size).toBe(5);
    expect(result.files[0].mtimeMs).toBeGreaterThan(0);
  });
});
