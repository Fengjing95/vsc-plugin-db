import * as vscode from 'vscode';
import { DriverError } from '@db-explorer/core';

/** 日志级别（LogOutputChannel 原生四级；trace 不使用） */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * Host 侧日志门面（M8 优化）：包装 LogOutputChannel——原生 info/warn/error/debug 分级、
 * 自动时间戳、输出面板右上角级别过滤与 error 徽标。各服务经本门面打点，不直接持有 channel。
 * - 保留 [源标签] 前缀约定（conn/console/ddl/dangerGuard/rpc/form/export），便于 grep
 * - C-10 脱敏：打点内容不得携带密码/凭证/连接串密钥部分（host/port/库名可打，options 整体不打）；
 *   错误经 describeError 提取 DriverError code + message（错误文案映射层 C-6 已保证不含凭证）
 * - 不自动 show() 面板（不打断用户）；聚焦入口是 dbExplorer.showLog 命令
 */
export class Logger {
  constructor(private readonly channel: vscode.LogOutputChannel) {}

  debug(tag: string, message: string): void {
    this.channel.debug(`[${tag}] ${message}`);
  }

  info(tag: string, message: string): void {
    this.channel.info(`[${tag}] ${message}`);
  }

  warn(tag: string, message: string): void {
    this.channel.warn(`[${tag}] ${message}`);
  }

  error(tag: string, message: string): void {
    this.channel.error(`[${tag}] ${message}`);
  }

  /** 直接写已带源标签的行（纯层转发通道，如 exportTasks 的 log 回调；常规打点勿用） */
  write(level: LogLevel, taggedLine: string): void {
    if (level === 'debug') {
      this.channel.debug(taggedLine);
    } else if (level === 'warn') {
      this.channel.warn(taggedLine);
    } else if (level === 'error') {
      this.channel.error(taggedLine);
    } else {
      this.channel.info(taggedLine);
    }
  }

  /** 聚焦输出面板的 Database Explorer 频道（dbExplorer.showLog，不抢焦点） */
  show(): void {
    this.channel.show(true);
  }
}

/** 错误 → 日志文本：DriverError 携错误码（C-6 链路补充），普通错误携 message（不含堆栈） */
export function describeError(err: unknown): string {
  if (DriverError.is(err)) {
    return `${err.code} ${err.message}`;
  }
  return err instanceof Error ? err.message : String(err);
}

/** 连接目标 host:port（C-10：仅地址与端口，库名/用户名等 options 其余键不打） */
export function describeTarget(options: Record<string, unknown>): string {
  const host = typeof options.host === 'string' && options.host ? options.host : '127.0.0.1';
  const port = typeof options.port === 'number' ? options.port : '?';
  return `${host}:${port}`;
}

/** SQL 摘要：压平空白并截断（日志单行可读；超长语句以 … 截断示意） */
export function sqlDigest(sql: string, max = 120): string {
  const flat = sql.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}
