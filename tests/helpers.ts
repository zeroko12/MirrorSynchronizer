/**
 * 测试辅助 - 创建临时目录,递归写入文件,清理
 */

import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

export async function makeTempDir(prefix = 'au-test-'): Promise<string> {
  return fs.mkdtemp(join(tmpdir(), prefix));
}

export async function writeFile(absPath: string, content: string | Buffer): Promise<void> {
  await fs.mkdir(join(absPath, '..'), { recursive: true });
  await fs.writeFile(absPath, content);
}

export interface TreeFile {
  relPath: string;
  content: string;
}

export async function writeTree(root: string, files: TreeFile[]): Promise<void> {
  for (const f of files) {
    await writeFile(join(root, f.relPath), f.content);
  }
}

export async function readTree(root: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  await walk(root, root, out);
  return out;
}

async function walk(root: string, current: string, out: Map<string, string>): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(current, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const abs = join(current, e.name);
    if (e.isDirectory()) {
      await walk(root, abs, out);
    } else if (e.isFile()) {
      const rel = abs.slice(root.length + 1).split('\\').join('/');
      out.set(rel, await fs.readFile(abs, 'utf-8'));
    }
  }
}

export async function rmTemp(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true });
}

export function randomId(): string {
  return randomBytes(4).toString('hex');
}

/** 等待 N ms */
export const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
