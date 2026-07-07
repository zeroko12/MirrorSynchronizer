/**
 * CLI 入口 - 用于 P1 验证核心同步引擎
 *
 * 模式:
 *   --init              在默认 userData 目录创建默认 config.json
 *   --once              跑一次同步后退出
 *   --watch             按 intervalSec 持续同步,SIGINT 退出
 *   --config <path>     指定配置文件路径(覆盖默认)
 *   --source <path>     覆盖配置里的 sourceDir
 *   --target <path>     覆盖配置里的 targetDir
 *   --interval <sec>    覆盖配置里的 intervalSec
 *   --quiet             减少日志输出
 *
 * 后续 P2+ 会把 CLI 模式并入 Electron 主进程,这里保持独立可执行以便测试
 */

import { existsSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { ConfigManager, DEFAULT_CONFIG, defaultConfigPath } from './config.js';
import { Syncer } from './syncer.js';
import { Scheduler } from './scheduler.js';
import { cliLog } from './logger.js';
import { atomicWriteJson } from './fs-utils.js';
import { APP_DATA_SUBDIR, MIN_INTERVAL_SEC } from './constants.js';
import type { AppConfig, FileEntry, SyncResult } from './types.js';

interface CliArgs {
  init: boolean;
  once: boolean;
  watch: boolean;
  configPath?: string;
  source?: string;
  target?: string;
  backupDir?: string;
  interval?: number;
  ignoreItems: string[];
  applyMode?: 'immediate' | 'staging' | 'immediate-with-precheck';
  stagingDir?: string;
  quiet: boolean;
}

function userDataDir(): string {
  const platform = process.platform;
  if (platform === 'win32') {
    const appData = process.env.APPDATA || join(os.homedir(), 'AppData', 'Roaming');
    return join(appData, APP_DATA_SUBDIR);
  }
  if (platform === 'darwin') {
    return join(os.homedir(), 'Library', 'Application Support', APP_DATA_SUBDIR);
  }
  const xdg = process.env.XDG_CONFIG_HOME || join(os.homedir(), '.config');
  return join(xdg, APP_DATA_SUBDIR);
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = { init: false, once: false, watch: false, ignoreItems: [], quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--init': out.init = true; break;
      case '--once': out.once = true; break;
      case '--watch': out.watch = true; break;
      case '--quiet': out.quiet = true; break;
      case '--config': out.configPath = argv[++i]; break;
      case '--source': out.source = argv[++i]; break;
      case '--target': out.target = argv[++i]; break;
      case '--backup-dir': out.backupDir = argv[++i]; break;
      case '--ignore-dir': out.ignoreItems.push(argv[++i]); break;
      case '--apply-mode': {
        const v = argv[++i];
        if (v !== 'immediate' && v !== 'staging') {
          throw new Error(`--apply-mode 必须是 immediate 或 staging,当前: ${v}`);
        }
        out.applyMode = v;
        break;
      }
      case '--staging-dir': out.stagingDir = argv[++i]; break;
      case '--interval': {
        const v = Number(argv[++i]);
        if (Number.isNaN(v) || v < MIN_INTERVAL_SEC) {
          throw new Error(`--interval 必须是 >= ${MIN_INTERVAL_SEC} 的整数`);
        }
        out.interval = v;
        break;
      }
      case '-h':
      case '--help':
        printHelp();
        process.exit(0);
      default:
        throw new Error(`未知参数: ${a}`);
    }
  }
  return out;
}

function printHelp(): void {
  cliLog.info(`自动更新检测程序 - CLI

用法:
  npm run sync-once -- [--config <path>] [--source <dir>] [--target <dir>] [--backup-dir <dir>] [--ignore-dir <dir>]... [--quiet]
  npm run watch     -- [--config <path>] [--source <dir>] [--target <dir>] [--backup-dir <dir>] [--ignore-dir <dir>]... [--interval <sec>] [--quiet]
  npm run init-config

选项:
  --init                  初始化默认配置
  --once                  跑一次同步
  --watch                 持续按间隔同步
  --config <path>         配置文件路径
  --source <dir>          覆盖源目录
  --target <dir>          覆盖目标目录
  --backup-dir <dir>      覆盖备份目录(空 = 默认派生自 targetDir)
  --ignore-dir <dir>      追加忽略目录(可多次,相对 target 根)
  --apply-mode <mode>     覆盖应用模式 (immediate|staging)
  --staging-dir <dir>     覆盖 staging 目录(staging 模式生效)
  --interval <sec>        覆盖检查间隔(秒, >= 60)
  --quiet                 减少日志
  -h, --help              显示帮助
`);
}

function log(quiet: boolean, level: 'info' | 'warn' | 'error', msg: string): void {
  if (quiet && level === 'info') return;
  const ts = new Date().toISOString();
  const tag = level === 'info' ? 'INFO ' : level === 'warn' ? 'WARN ' : 'ERROR';
  cliLog.info(`[${ts}] [${tag}] ${msg}`);
}

function summarize(r: SyncResult): string {
  return `added=${r.added.length} modified=${r.modified.length} deleted=${r.deleted.length} unchanged=${r.unchanged} mapping=${r.mappingCopied.length} duration=${r.durationMs}ms ok=${r.ok}`;
}

async function loadIndexCache(userData: string): Promise<FileEntry[] | null> {
  const path = join(userData, 'index-cache.json');
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(await fs.readFile(path, 'utf-8'));
  } catch {
    return null;
  }
}

async function saveIndexCache(userData: string, entries: FileEntry[]): Promise<void> {
  const path = join(userData, 'index-cache.json');
  await atomicWriteJson(path, entries);
}

async function runInit(args: CliArgs): Promise<void> {
  const userData = userDataDir();
  await fs.mkdir(userData, { recursive: true });
  const cfgPath = args.configPath ? String(args.configPath) : defaultConfigPath(userData);
  const mgr = new ConfigManager({ configPath: cfgPath, defaults: DEFAULT_CONFIG });
  const cfg = await mgr.resetToDefaults();
  cliLog.info(`✓ 已创建默认配置: ${cfgPath}`);
  cliLog.info(`  userData: ${userData}`);
  cliLog.info(`  sourceDir: ${cfg.sourceDir || '(待设置)'}`);
  cliLog.info(`  targetDir: ${cfg.targetDir || '(待设置)'}`);
  cliLog.info(`  backupDir: ${cfg.backupDir || '(空 → 派生自 targetDir)'}`);
  cliLog.info(`  intervalSec: ${cfg.intervalSec}`);
  cliLog.info(`  backupCount: ${cfg.backupCount}`);
}

async function runOnce(args: CliArgs): Promise<void> {
  const userData = userDataDir();
  const cfgPath = args.configPath ? String(args.configPath) : defaultConfigPath(userData);
  const mgr = new ConfigManager({ configPath: cfgPath, defaults: DEFAULT_CONFIG });
  const cfg = await mgr.load();
  const finalConfig = applyCliOverrides(cfg, args);

  if (!finalConfig.sourceDir || !finalConfig.targetDir) {
    log(false, 'error', 'sourceDir / targetDir 未配置,先用 --init 创建配置,再编辑 config.json');
    process.exit(1);
  }

  log(args.quiet, 'info', `源: ${finalConfig.sourceDir}`);
  log(args.quiet, 'info', `目标: ${finalConfig.targetDir}`);

  const lastIndex = await loadIndexCache(userData);
  const syncer = new Syncer(finalConfig);
  const { result, newSourceIndex } = await syncer.sync(lastIndex);
  await saveIndexCache(userData, newSourceIndex);

  if (result.fatalError) {
    log(false, 'error', result.fatalError);
  }
  for (const w of result.warnings) {
    log(false, 'warn', w);
  }
  log(false, 'info', `完成: ${summarize(result)}`);

  if (result.fatalError) process.exit(1);
}

async function runWatch(args: CliArgs): Promise<void> {
  const userData = userDataDir();
  const cfgPath = args.configPath ? String(args.configPath) : defaultConfigPath(userData);
  const mgr = new ConfigManager({ configPath: cfgPath, defaults: DEFAULT_CONFIG });
  let cfg = await mgr.load();
  cfg = applyCliOverrides(cfg, args);

  if (!cfg.sourceDir || !cfg.targetDir) {
    log(false, 'error', 'sourceDir / targetDir 未配置');
    process.exit(1);
  }

  const indexCachePath = join(userData, 'index-cache.json');
  const scheduler = new Scheduler({
    config: cfg,
    indexCachePath,
    onSync: (r) => {
      const level = r.fatalError ? 'error' : r.warnings.length ? 'warn' : 'info';
      log(args.quiet, level, `同步: ${summarize(r)}`);
    },
    onFatalError: (n) => {
      log(false, 'error', `连续失败 ${n} 次,请检查源目录`);
    },
  });

  scheduler.start();
  log(false, 'info', `调度器已启动,间隔 ${cfg.intervalSec}s,按 Ctrl+C 退出`);

  const shutdown = async () => {
    log(false, 'info', '正在停止调度器...');
    await scheduler.stop();
    log(false, 'info', '已停止');
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

function applyCliOverrides(cfg: AppConfig, args: CliArgs): AppConfig {
  return {
    ...cfg,
    sourceDir: args.source ?? cfg.sourceDir,
    targetDir: args.target ?? cfg.targetDir,
    backupDir: args.backupDir ?? cfg.backupDir,
    intervalSec: args.interval ?? cfg.intervalSec,
    // CLI 传入的 ignore-dir 追加到 config 列表后面(不去重,让 syncer 内部 buildIgnoreItems 去重)
    ignoreItems: [...(cfg.ignoreItems ?? []), ...args.ignoreItems],
    applyMode: args.applyMode ?? cfg.applyMode,
    stagingDir: args.stagingDir ?? cfg.stagingDir,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  try {
    if (args.init) {
      await runInit(args);
      return;
    }
    if (args.watch) {
      await runWatch(args);
      return;
    }
    if (args.once) {
      await runOnce(args);
      return;
    }
    printHelp();
  } catch (err) {
    cliLog.error(`错误: ${(err as Error).message}`);
    process.exit(1);
  }
}

main();
