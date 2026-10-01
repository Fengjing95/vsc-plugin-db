import {
  DriverError,
  type ColumnMeta,
  type NormalizedType,
  type ObjectMeta,
} from '@db-explorer/core';

/**
 * Redis 纯函数层：值编码契约 / 游标 / glob 识别 / 列虚拟化 / 前缀分组。
 * 与连接实现分离，便于无 Redis 环境下的契约级单测。
 */

// ───────────────────────── 值编码（驱动开发规范 §5.3） ─────────────────────────

const INTEGER_RE = /^-?(0|[1-9]\d*)$/;

/**
 * Redis 值 → 传输编码（C-7）：
 * - 二进制（无效 UTF-8）→ base64 字符串（列类型 binary）
 * - 整数形状 → number（|v| ≤ MAX_SAFE_INTEGER）
 * - JSON 数组/对象 → 已解析对象（Hash/List/Set/ZSet 值统一 json）
 * - 其余 → 原样字符串（前导零/浮点字符串不嗅探，保精度）
 */
export function encodeRedisValue(value: unknown): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value !== 'string' && !Buffer.isBuffer(value)) {
    return value; // number/boolean 等原样透传（ZSCORE 等已数字化的回复）
  }
  const buf = typeof value === 'string' ? Buffer.from(value, 'utf8') : value;
  const text = isBinary(buf) ? buf.toString('base64') : buf.toString('utf8');
  if (isBinary(buf)) {
    return text; // binary 以 base64 字符串承载
  }
  if (INTEGER_RE.test(text)) {
    const n = Number(text);
    if (Number.isSafeInteger(n)) {
      return n;
    }
    return text; // 超限按字符串保精度（概要 §4.4）
  }
  const first = text[0];
  if (first === '[' || first === '{') {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return text;
}

/** 无效 UTF-8 序列（含 0x00-0x08 控制字符）→ 视为二进制 */
function isBinary(buf: Buffer): boolean {
  const decoded = buf.toString('utf8');
  if (!Buffer.from(decoded, 'utf8').equals(buf)) {
    return true;
  }
  // 控制字符嗅探正是二进制判定的本意
  // eslint-disable-next-line no-control-regex
  const hasControlChar = /[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(decoded) && !/[\x09\x0A\x0D]/.test(decoded);
  return hasControlChar;
}

/** 类型化读取统一以 Buffer 接收（sendCommand + typeMapping），key 名等场景直接解码 */
export function utf8(value: Buffer | string): string {
  return typeof value === 'string' ? value : value.toString('utf8');
}

// ───────────────────────── 游标（pagination=cursor，驱动规范 §4） ─────────────────────────

/** 游标 wire 形态（base64url(JSON) 内部结构）：pending 以 base64 承载——
 *  批内值可能是二进制（Buffer），utf8 字符串通道会丢字节 */
export interface RedisCursor {
  /** SCAN 服务端游标（'0' = 起始/结束） */
  scan: string;
  /** 当前批次内尚未消费的键/字段（SCAN 一批可能多于页大小，位置须进游标），base64 编码 */
  pending?: string[];
}

/** 游标运行态：feedScan 的可变位置状态 */
export interface ScanState {
  scan: string;
  pending: Buffer[];
}

/** 游标不透明化：base64url(JSON)，避免客户端理解/伪造内部状态 */
export function cursorOf(scanCursor: string, pending?: Buffer[]): string {
  return Buffer.from(
    JSON.stringify({
      scan: scanCursor,
      pending: pending?.map((b) => b.toString('base64')),
    } satisfies RedisCursor),
    'utf8',
  ).toString('base64url');
}

/** 非法游标返回 undefined（调用方报 E_VALIDATION） */
export function decodeCursor(cursor: string): ScanState | undefined {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Partial<RedisCursor>;
    if (parsed && typeof parsed.scan === 'string') {
      return {
        scan: parsed.scan,
        pending: Array.isArray(parsed.pending) ? parsed.pending.map((s) => Buffer.from(String(s), 'base64')) : [],
      };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export function decodeCursorOrThrow(cursor: string): ScanState {
  const decoded = decodeCursor(cursor);
  if (!decoded) {
    throw new DriverError('E_VALIDATION', '分页游标非法，请从首页重新翻页');
  }
  return decoded;
}

// ───────────────────────── glob 模式（pattern 浏览 vs 单键内容） ─────────────────────────

const GLOB_CHARS = /[*?[\]]/;

export function isGlobPattern(obj: string): boolean {
  return GLOB_CHARS.test(obj);
}

// ───────────────────────── 列元数据虚拟化（驱动规范 §5.3） ─────────────────────────

function col(
  name: string,
  dataType: string,
  normalizedType: NormalizedType,
  ordinal: number,
): ColumnMeta {
  return { name, dataType, normalizedType, nullable: false, isPrimaryKey: false, ordinal };
}

/** 模式浏览（obj 如 user:*）：key/type/__ttl，TTL 为只读虚拟列（integer） */
export function patternColumns(): ColumnMeta[] {
  return [
    col('key', 'string', 'string', 1),
    col('type', 'string', 'string', 2),
    col('__ttl', 'integer', 'integer', 3),
  ];
}

/** 单键内容列（类型化展示）；未知类型返回 undefined（调用方报 E_UNSUPPORTED） */
export function keyContentColumns(redisType: string): ColumnMeta[] | undefined {
  switch (redisType) {
    case 'string':
      return [col('value', 'string', 'string', 1)];
    case 'hash':
      return [col('field', 'string', 'string', 1), col('value', 'string', 'json', 2)];
    case 'list':
      return [col('index', 'integer', 'integer', 1), col('value', 'string', 'json', 2)];
    case 'set':
      return [col('member', 'string', 'string', 1)];
    case 'zset':
      return [col('member', 'string', 'string', 1), col('score', 'double', 'float', 2)];
    default:
      return undefined;
  }
}

/** 内容表的主键列（editable=false，仅定位/展示用） */
export function contentPrimaryKey(redisType: string): string[] | undefined {
  switch (redisType) {
    case 'hash':
      return ['field'];
    case 'set':
    case 'zset':
      return ['member'];
    case 'list':
      return ['index'];
    default:
      return undefined;
  }
}

const KNOWN_REDIS_TYPES = new Set(['string', 'hash', 'list', 'set', 'zset', 'stream']);

/** TYPE 回复归一（none/未知 → undefined） */
export function redisTypeOf(reply: string): string | undefined {
  return KNOWN_REDIS_TYPES.has(reply) ? reply : undefined;
}

// ───────────────────────── Keys 目录前缀分组（概要 §5.1.3 三级） ─────────────────────────

export interface GroupOptions {
  /** 不少于 N 个同前缀键才合并为模式节点 */
  groupMin: number;
  /** 单次列出的节点上限；超出时追加「*」模式节点供表格分页浏览 */
  cap: number;
}

/**
 * SCAN 采样的键名 → ObjectMeta[]（kind=collection）：
 * - 同前缀（首个 ':' 之前）≥ groupMin → 模式节点 `prefix:*`（comment 携带采样数）
 * - 其余键逐一列出（comment = 类型）
 * 树渲染（extension 层）只认 kind=collection，分组策略完全由驱动决定。
 */
export function groupKeysToObjects(
  keys: string[],
  types: Map<string, string>,
  opts: GroupOptions,
): ObjectMeta[] {
  const groups = new Map<string, number>();
  for (const key of keys) {
    const i = key.indexOf(':');
    if (i > 0) {
      groups.set(key.slice(0, i) + ':', (groups.get(key.slice(0, i) + ':') ?? 0) + 1);
    }
  }

  const out: ObjectMeta[] = [];
  const consumed = new Set<string>();
  for (const [prefix, count] of [...groups.entries()].sort((a, b) => b[1] - a[1])) {
    if (count < opts.groupMin) {
      continue;
    }
    out.push({
      name: `${prefix.slice(0, -1)}:*`,
      kind: 'collection',
      comment: `模式分组 · 采样 ${count} 键`,
    });
    for (const key of keys) {
      if (key.startsWith(prefix)) {
        consumed.add(key);
      }
    }
    if (out.length >= opts.cap) {
      return out.slice(0, opts.cap);
    }
  }

  for (const key of keys) {
    if (out.length >= opts.cap - 1) {
      // 留 1 位给「其余键」模式节点
      out.push({ name: '*', kind: 'collection', comment: '其余键（模式浏览）' });
      return out;
    }
    if (!consumed.has(key)) {
      out.push({ name: key, kind: 'collection', comment: types.get(key) });
    }
  }
  return out;
}
