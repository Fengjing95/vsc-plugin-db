/**
 * Redis 命令白名单与判定（驱动开发规范 §5.3 / 概要设计 §5.8 / 评审 P1-6）：
 * - supportsSQL=false 的驱动仍提供命令控制台；危险判定不走 SQL AST，改用命令白名单
 * - 三类判定：provablyRead（只读连接 fail-closed 的唯一放行条件）、dangerous（横幅/Modal）、known
 * - 未知命令不可证明为读（宁可拒绝不放过）；不虚报危险（dangerous 只标已知大范围破坏命令）
 * - 子命令感知：CONFIG GET 是读、CONFIG SET 危险；SORT 带 STORE 视为写
 * 纯函数、零依赖。行切分与 SqlStatement 形状兼容，可复用 statementAtOffset 定位「当前行命令」。
 */

/** 支持 'single' "double" 引号与 \ 转义（redis-cli 风格）；未闭合引号 → undefined */
export function tokenizeRedisCommand(line: string): string[] | undefined {
  const tokens: string[] = [];
  let i = 0;
  const n = line.length;

  while (i < n) {
    while (i < n && /\s/.test(line[i])) {
      i++;
    }
    if (i >= n) {
      break;
    }
    const ch = line[i];
    if (ch === "'" || ch === '"') {
      const quote = ch;
      i++;
      let token = '';
      let closed = false;
      while (i < n) {
        const c = line[i];
        if (c === '\\' && i + 1 < n) {
          token += line[i + 1];
          i += 2;
          continue;
        }
        if (c === quote) {
          if (quote === '"' && line[i + 1] === '"') {
            token += '"';
            i += 2;
            continue;
          }
          closed = true;
          i++;
          break;
        }
        token += c;
        i++;
      }
      if (!closed) {
        return undefined;
      }
      tokens.push(token);
      continue;
    }
    let token = '';
    while (i < n && !/\s/.test(line[i])) {
      token += line[i];
      i++;
    }
    tokens.push(token);
  }
  return tokens;
}

/**
 * 只读命令白名单：undefined = 命令整体只读；Set = 仅列出的子命令只读
 * （如 CONFIG GET 是读、CONFIG SET 是写）。导出供 driver-redis completion.ts 派生补全词表
 * （C-14：词表归位驱动，安全白名单单一来源仍在 core——editGuard/consoleService 同源消费）。
 */
export const READ_COMMANDS: Readonly<Record<string, ReadonlySet<string> | undefined>> = {
  GET: undefined, MGET: undefined, GETRANGE: undefined, STRLEN: undefined,
  EXISTS: undefined, TYPE: undefined, TTL: undefined, PTTL: undefined,
  EXPIRETIME: undefined, DUMP: undefined, RANDOMKEY: undefined, KEYS: undefined,
  SCAN: undefined, DBSIZE: undefined, SELECT: undefined, WAIT: undefined, LOLWUT: undefined,
  PING: undefined, ECHO: undefined, RESET: undefined,
  HGET: undefined, HMGET: undefined, HGETALL: undefined, HKEYS: undefined, HVALS: undefined,
  HLEN: undefined, HSCAN: undefined, HEXISTS: undefined, HSTRLEN: undefined, HRANDFIELD: undefined,
  LRANGE: undefined, LLEN: undefined, LINDEX: undefined, LPOS: undefined,
  SMEMBERS: undefined, SCARD: undefined, SISMEMBER: undefined, SMISMEMBER: undefined,
  SRANDMEMBER: undefined, SSCAN: undefined, SINTER: undefined, SUNION: undefined,
  SDIFF: undefined, SINTERCARD: undefined,
  ZRANGE: undefined, ZRANGEBYSCORE: undefined, ZRANGEBYLEX: undefined, ZREVRANGE: undefined,
  ZREVRANGEBYSCORE: undefined, ZREVRANGEBYLEX: undefined, ZCARD: undefined, ZCOUNT: undefined,
  ZSCORE: undefined, ZMSCORE: undefined, ZRANK: undefined, ZREVRANK: undefined,
  ZSCAN: undefined, ZRANDMEMBER: undefined, ZLEXCOUNT: undefined,
  GETBIT: undefined, BITCOUNT: undefined, BITPOS: undefined,
  PFCOUNT: undefined,
  XLEN: undefined, XRANGE: undefined, XREVRANGE: undefined, XREAD: undefined, XPENDING: undefined,
  XINFO: undefined,
  INFO: undefined,
  GEOPOS: undefined, GEODIST: undefined, GEOSEARCH: undefined, GEOHASH: undefined,
  OBJECT: undefined, MEMORY: undefined, LATENCY: undefined, TIME: undefined, LASTSAVE: undefined,
  SORT_RO: undefined,
  CONFIG: new Set(['GET']),
  CLIENT: new Set(['ID', 'GETNAME', 'LIST', 'INFO']),
  COMMAND: undefined,
  ACL: new Set(['WHOAMI', 'LIST', 'CAT', 'GETUSER']),
};

/** 大范围/服务器级破坏命令 → 横幅原因（普通写命令如 SET/DEL 不在此列，仅只读拒绝）。
 *  子命令感知的命令（CONFIG/CLIENT）先经 READ 命中只读子命令，其余子命令保守视为危险。
 *  导出供 driver-redis completion.ts 派生补全词表（C-14）。 */
export const DANGEROUS_COMMANDS: Readonly<Record<string, string>> = {
  FLUSHALL: '将清空所有数据库的全部数据',
  FLUSHDB: '将清空当前数据库的全部数据',
  SHUTDOWN: '将关闭 Redis 服务器',
  SLAVEOF: '将更改复制拓扑',
  REPLICAOF: '将更改复制拓扑',
  SWAPDB: '将交换两个数据库的全部键',
  DEBUG: '服务器调试命令，可能阻塞或破坏运行状态',
  SCRIPT: '将执行/管理 Lua 脚本',
  EVAL: '将执行 Lua 脚本',
  EVALSHA: '将执行 Lua 脚本',
  EVAL_RO: '将执行 Lua 脚本',
  FUNCTION: '将管理/执行服务器端函数',
  CLUSTER: '将执行集群管理操作',
  MODULE: '将管理服务器模块',
  MIGRATE: '将迁移键到其他实例',
  RESTORE: '将反序列化覆盖已有键',
  CONFIG: '将修改服务器配置',
  CLIENT: '将管理客户端连接',
};

/** 已知普通写命令（只读连接拒绝；不触发横幅）。导出供 driver-redis completion.ts 派生词表（C-14） */
export const WRITE_COMMANDS: ReadonlySet<string> = new Set([
  'SET', 'SETNX', 'SETEX', 'PSETEX', 'MSET', 'MSETNX', 'GETSET', 'GETDEL', 'APPEND', 'SETRANGE',
  'INCR', 'INCRBY', 'INCRBYFLOAT', 'DECR', 'DECRBY',
  'DEL', 'UNLINK', 'EXPIRE', 'PEXPIRE', 'EXPIREAT', 'PEXPIREAT', 'PERSIST',
  'RENAME', 'RENAMENX', 'MOVE', 'COPY',
  'HSET', 'HSETNX', 'HMSET', 'HDEL', 'HINCRBY', 'HINCRBYFLOAT',
  'LPUSH', 'LPUSHX', 'RPUSH', 'RPUSHX', 'LPOP', 'RPOP', 'LREM', 'LSET', 'LTRIM', 'LMOVE',
  'RPOPLPUSH', 'BLPOP', 'BRPOP', 'BRPOPLPUSH', 'LMPOP', 'BLMPOP',
  'SADD', 'SREM', 'SPOP', 'SMOVE', 'SINTERSTORE', 'SUNIONSTORE', 'SDIFFSTORE',
  'ZADD', 'ZINCRBY', 'ZREM', 'ZREMRANGEBYRANK', 'ZREMRANGEBYSCORE', 'ZREMRANGEBYLEX',
  'ZPOPMIN', 'ZPOPMAX', 'ZMPOP', 'BZPOPMIN', 'BZPOPMAX',
  'SETBIT', 'BITFIELD', 'BITOP', 'PFADD', 'PFMERGE',
  'XADD', 'XDEL', 'XTRIM', 'XACK', 'XGROUP', 'XSETID', 'XCLAIM', 'XAUTOCLAIM',
  'GEOADD',
  'SORT', // 仅当带 STORE 时为写，见 assessRedisCommand 特判
  'SAVE', 'BGSAVE', 'BGREWRITEAOF',
  'MULTI', 'EXEC', 'WATCH', 'UNWATCH', 'DISCARD',
]);

export interface RedisCommandAssessment {
  /** 大范围破坏/服务器级命令（触发横幅或 prod Modal） */
  dangerous: boolean;
  reasons: string[];
  /** 命令可解析且在白名单中 */
  known: boolean;
  /** 可证明为读：只读连接 fail-closed（概要 §5.8）的唯一放行条件 */
  provablyRead: boolean;
  /** 引号未闭合等 token 化失败 */
  unparseable: boolean;
}

export function assessRedisCommand(text: string): RedisCommandAssessment {
  const result: RedisCommandAssessment = {
    dangerous: false,
    reasons: [],
    known: false,
    provablyRead: false,
    unparseable: false,
  };
  const tokens = tokenizeRedisCommand(text);
  if (tokens === undefined) {
    result.unparseable = true;
    return result;
  }
  if (tokens.length === 0) {
    result.provablyRead = true; // 空命令无副作用（调用方不会执行空行）
    return result;
  }
  const cmd = tokens[0].toUpperCase();
  const sub = tokens[1]?.toUpperCase();

  // SORT 带 STORE = 写（目标键被覆盖）；默认为读
  if (cmd === 'SORT') {
    result.known = true;
    result.provablyRead = !tokens.slice(1).some((t) => t.toUpperCase() === 'STORE');
    return result;
  }

  result.known = cmd in READ_COMMANDS || cmd in DANGEROUS_COMMANDS || WRITE_COMMANDS.has(cmd);

  if (cmd in READ_COMMANDS) {
    const readSubs = READ_COMMANDS[cmd];
    if (readSubs === undefined || (sub !== undefined && readSubs.has(sub))) {
      result.provablyRead = true;
      return result;
    }
    // 已知命令但子命令不在只读集合（CONFIG SET / CLIENT KILL）→ 继续判危险
  }

  const dangerReason = DANGEROUS_COMMANDS[cmd];
  if (dangerReason !== undefined) {
    result.dangerous = true;
    result.reasons.push(`${cmd} ${dangerReason}`);
  }
  return result;
}

export function isProvablyReadRedisCommand(text: string): boolean {
  return assessRedisCommand(text).provablyRead;
}

export interface RedisCommandRange {
  /** 命令行原文（去首尾空白） */
  text: string;
  /** 在脚本中的起止偏移（start 指向首个非空白字符；end 为行尾） */
  start: number;
  end: number;
}

/**
 * 命令控制台按行切分（§5.3）：空行与 # 注释行跳过。
 * 与 SqlStatement 形状兼容，statementAtOffset 可直接复用（Ctrl+Enter 定位当前行命令）。
 */
export function splitCommandLines(script: string): RedisCommandRange[] {
  const out: RedisCommandRange[] = [];
  let base = 0;
  for (const line of script.split('\n')) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#')) {
      const start = base + (line.length - line.trimStart().length);
      out.push({ text: trimmed, start, end: base + line.length });
    }
    base += line.length + 1; // +1 为换行符
  }
  return out;
}
