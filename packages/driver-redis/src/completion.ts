import { DANGEROUS_COMMANDS, READ_COMMANDS, WRITE_COMMANDS } from '@db-explorer/core';

/**
 * Redis 命令域补全词表（C-14/规范 §3.2：键值数据源为命令域全量词表，归位驱动 src/completion.ts）。
 * 安全白名单单一来源仍在 core redisCommands.ts（editGuard/consoleService 同源消费）——
 * 本文件只做「补全词表 = 白名单键集」的派生，安全判定与补全永不漂移。
 */

/** 命令名补全（CompletionSource.keywords 位）= 只读 ∪ 危险 ∪ 普通写 的并集 */
export const REDIS_COMMAND_KEYWORDS: readonly string[] = [
  ...Object.keys(READ_COMMANDS),
  ...Object.keys(DANGEROUS_COMMANDS),
  ...WRITE_COMMANDS,
].sort();

/** 子命令补全（CompletionSource.functions 位） */
export const REDIS_SUBCOMMAND_KEYWORDS: readonly string[] = [
  'CONFIG GET', 'CONFIG SET', 'CLIENT LIST', 'CLIENT KILL', 'CLIENT INFO',
  'OBJECT ENCODING', 'OBJECT FREQ', 'OBJECT IDLETIME', 'OBJECT REFCOUNT',
  'MEMORY USAGE', 'MEMORY DOCTOR', 'LATENCY HISTORY', 'LATENCY LATEST',
  'XINFO STREAM', 'XINFO GROUPS', 'ACL WHOAMI', 'ACL LIST', 'ACL CAT',
];
