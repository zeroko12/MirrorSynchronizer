/**
 * logger - 平台感知的日志门面
 *
 * 主进程 / CLI:走 electron-log,自动写文件到 userData/logs/main.log(主进程)
 * 或 cwd/main.log(CLI),dev 时同时输出到 stderr。
 * 渲染进程:用 console.*(DevTools 已经在生产构建里关闭,console 是无副作用的本地输出)。
 *
 * 之所以不强制渲染进程走 electron-log:IPC 转发日志会污染主进程日志,
 * 渲染层的报错应该靠 [renderer console-message] 监听器集中转写到主进程。
 *
 * 选型:electron-log(单一依赖,经过验证,带滚动/格式化/文件切割)
 * TS 规则明令禁止 console.log 在生产代码里 —— 这个文件是唯一允许 console.* 出现的地方。
 */

import electronLog from 'electron-log/main';

type LogFn = (msg: string, ...args: unknown[]) => void;

function noop(): void {
  /* render stub */
}

function makeLoggers(enabled: boolean): {
  info: LogFn;
  warn: LogFn;
  error: LogFn;
  debug: LogFn;
} {
  if (!enabled) {
    const stub: LogFn = () => {};
    return { info: stub, warn: stub, error: stub, debug: stub };
  }
  return {
    info: (msg, ...args) => electronLog.info(msg, ...args),
    warn: (msg, ...args) => electronLog.warn(msg, ...args),
    error: (msg, ...args) => electronLog.error(msg, ...args),
    debug: (msg, ...args) => electronLog.debug(msg, ...args),
  };
}

/** 主进程 logger。app ready 之后才能用(需要 app.getPath)。 */
export const mainLog = makeLoggers(
  typeof process !== 'undefined' && process.type === 'browser',
);

/** CLI 进程 logger(Node 直接跑 src/core/cli.ts)。 */
export const cliLog = makeLoggers(
  typeof process !== 'undefined' && process.type === undefined,
);

/**
 * 平台无关 logger(主进程 + CLI + 测试都能用)。
 * 同步引擎这种被两边 import 的模块用这个,避免主/CLI 选错。
 * 写到 stderr,不走文件 —— 写文件是主进程独有的事。
 */
export const coreLog = makeLoggers(typeof process !== 'undefined');

/** 渲染进程 logger —— 故意是 noop,渲染层用 console.* 即可。 */
export const renderLog = { info: noop, warn: noop, error: noop, debug: noop };

/** 暴露底层 electron-log,用于主进程初始化阶段设置日志路径等。 */
export const _electronLog = electronLog;
