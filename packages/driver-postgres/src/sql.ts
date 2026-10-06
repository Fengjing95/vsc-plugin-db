import { DriverError, type FilterCondition, type NormalizedType } from '@db-explorer/core';

/**
 * 纯函数层：SQL 构建 / 类型归一 / 值编码 / 时间文本规范化。
 * 与连接实现分离，便于无数据库环境下的契约级单测（同 driver-mysql 口径）。
 * db 参数语义（D-15）：db = schema 名，SQL 中对象引用一律 `"schema"."obj"` 显式限定。
 */

export function quotePgIdentifier(name: string): string {
  return '"' + name.replace(/"/g, '""') + '"';
}

/** LIKE 通配符转义由驱动负责（驱动规范 §4）；PG 默认 LIKE 转义符即反斜杠 */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/** 字符串字面量剥除后做整词匹配——判断用户片段是否已引用某列（忽略大小写） */
export function fragmentHasColumn(sql: string, column: string): boolean {
  const stripped = sql.replace(/'(?:[^']|'')*'/g, ' ');
  return new RegExp(`\\b${column.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(stripped);
}

export interface SelectParts {
  db: string;
  obj: string;
  columns?: string[];
  filters?: FilterCondition[];
  sorts?: Array<{ column: string; dir: 'asc' | 'desc' }>;
  search?: string;
  /** 用户手写 WHERE 片段（驱动规范 §4：原样拼接，括号包裹保持 AND 语义） */
  whereSql?: string;
  /** 用户手写 ORDER BY 片段（追加在列头排序之后） */
  orderBySql?: string;
  /** 追加在 orderBySql 之后的兜底排序（主键升序，保证翻页稳定 P-10） */
  tailSorts?: Array<{ column: string; dir: 'asc' | 'desc' }>;
  searchColumns: string[];
  limit: number;
  offset?: number;
  /** 值编码 → 原生参数转换（§5：编辑回传 base64 字符串，驱动绑定前转 Buffer 等）；
   *  仅列定位值经此钩子（search 关键字与 LIMIT/OFFSET 不经列语义） */
  encodeParam?: (column: string, value: unknown) => unknown;
}

export interface BuiltSelect {
  sql: string;
  params: unknown[];
}

/** 结构化筛选 → 参数化 SELECT（$n 占位符，禁止值拼接，概要设计 §8） */
export function buildSelect(req: SelectParts): BuiltSelect {
  const params: unknown[] = [];
  const enc = req.encodeParam ?? ((_column: string, value: unknown) => value);
  const next = (column: string, value: unknown): string => `$${params.push(enc(column, value))}`;
  const raw = (value: unknown): string => `$${params.push(value)}`;
  const cols = req.columns && req.columns.length > 0 ? req.columns : null;
  const selectList = cols ? cols.map(quotePgIdentifier).join(', ') : '*';
  let sql = `SELECT ${selectList} FROM ${quotePgIdentifier(req.db)}.${quotePgIdentifier(req.obj)}`;

  const where: string[] = [];
  for (const f of req.filters ?? []) {
    const col = quotePgIdentifier(f.column);
    switch (f.op) {
      case 'eq':
        where.push(`${col} = ${next(f.column, f.value)}`);
        break;
      case 'ne':
        where.push(`${col} <> ${next(f.column, f.value)}`);
        break;
      case 'gt':
        where.push(`${col} > ${next(f.column, f.value)}`);
        break;
      case 'ge':
        where.push(`${col} >= ${next(f.column, f.value)}`);
        break;
      case 'lt':
        where.push(`${col} < ${next(f.column, f.value)}`);
        break;
      case 'le':
        where.push(`${col} <= ${next(f.column, f.value)}`);
        break;
      case 'like':
        where.push(`${col} LIKE ${raw(`%${escapeLike(String(f.value ?? ''))}%`)}`);
        break;
      case 'notLike':
        where.push(`${col} NOT LIKE ${raw(`%${escapeLike(String(f.value ?? ''))}%`)}`);
        break;
      case 'in': {
        const vals = f.values ?? [];
        if (vals.length === 0) {
          where.push('1 = 0');
          break;
        }
        where.push(`${col} IN (${vals.map((v) => next(f.column, v)).join(', ')})`);
        break;
      }
      case 'notIn': {
        const vals = f.values ?? [];
        if (vals.length === 0) break;
        where.push(`${col} NOT IN (${vals.map((v) => next(f.column, v)).join(', ')})`);
        break;
      }
      case 'isNull':
        where.push(`${col} IS NULL`);
        break;
      case 'isNotNull':
        where.push(`${col} IS NOT NULL`);
        break;
      case 'between': {
        const [lo, hi] = f.values ?? [];
        where.push(`${col} BETWEEN ${next(f.column, lo)} AND ${next(f.column, hi)}`);
        break;
      }
      default:
        throw new DriverError('E_VALIDATION', '筛选操作符不受支持');
    }
  }

  if (req.search && req.searchColumns.length > 0) {
    const kw = `%${escapeLike(req.search)}%`;
    // 大小写敏感 LIKE：与契约内存基准（JS includes）一致；关键字非列定位值，不经 encodeParam
    where.push(`(${req.searchColumns.map((c) => `${quotePgIdentifier(c)} LIKE ${raw(kw)}`).join(' OR ')})`);
  }

  const userWhere = req.whereSql?.trim();
  if (userWhere) {
    where.push(`(${userWhere})`);
  }
  if (where.length > 0) {
    sql += ` WHERE ${where.join(' AND ')}`;
  }

  const orderParts = (req.sorts ?? []).map(
    (s) => `${quotePgIdentifier(s.column)} ${s.dir === 'desc' ? 'DESC' : 'ASC'}`,
  );
  const userOrder = req.orderBySql?.trim();
  if (userOrder) {
    orderParts.push(userOrder);
  }
  for (const t of req.tailSorts ?? []) {
    orderParts.push(`${quotePgIdentifier(t.column)} ${t.dir === 'desc' ? 'DESC' : 'ASC'}`);
  }
  if (orderParts.length > 0) {
    sql += ` ORDER BY ${orderParts.join(', ')}`;
  }
  sql += ` LIMIT ${raw(req.limit)}`;
  if (req.offset !== undefined) {
    sql += ` OFFSET ${raw(req.offset)}`;
  }
  return { sql, params };
}

/** PG 类型 → NormalizedType（驱动规范 §5.2；dataType 为 format_type 原文） */
export function normalizePgType(dataType: string): NormalizedType {
  const t = dataType.toLowerCase();
  if (t.endsWith('[]')) {
    return 'json'; // 数组 → JSON 数组
  }
  if (/^(smallint|int2|int4|integer|int)$/.test(t) || t === 'bigint' || t === 'int8') {
    return 'integer';
  }
  if (t === 'numeric' || t.startsWith('numeric(') || t === 'decimal' || t.startsWith('decimal(')) {
    return 'decimal';
  }
  if (t === 'real' || t === 'float4' || t === 'double precision' || t === 'float8') {
    return 'float';
  }
  if (t === 'boolean' || t === 'bool') {
    return 'boolean';
  }
  if (t === 'date') return 'date';
  if (t === 'time' || t === 'time without time zone' || t === 'timetz' || t === 'time with time zone') return 'time';
  if (t === 'timestamp' || t.startsWith('timestamp(') || t === 'timestamp without time zone' || t === 'timestamptz' || t === 'timestamp with time zone') {
    return 'datetime';
  }
  if (t === 'json' || t === 'jsonb') return 'json';
  if (t === 'uuid') return 'uuid';
  if (t === 'bytea') return 'binary';
  if (/^(character|bpchar|varchar|char|text|name|citext)/.test(t)) {
    return 'string';
  }
  return 'unknown';
}

// ── pg 类型解析器（会话内覆写，禁用 JS Date 转换防时区漂移；驱动规范 §5.2）──────────────

/** pg 类型 OID（仅本驱动消费的子集） */
export const PG_OID = {
  BOOL: 16,
  INT8: 20,
  INT2: 21,
  INT4: 23,
  TEXT: 25,
  FLOAT4: 700,
  FLOAT8: 701,
  BYTEA: 17,
  NAME: 19,
  CHAR: 18,
  VARCHAR: 1043,
  DATE: 1082,
  TIME: 1083,
  TIMETZ: 1266,
  TIMESTAMP: 1114,
  TIMESTAMPTZ: 1184,
  NUMERIC: 1700,
  UUID: 2950,
  JSON: 114,
  JSONB: 3802,
} as const;

/** query() 结果列的类型推断（fetchRows 走 listColumns 的元数据，无需此表） */
const OID_TYPES: Record<number, NormalizedType> = {
  [PG_OID.BOOL]: 'boolean',
  [PG_OID.INT8]: 'integer',
  [PG_OID.INT2]: 'integer',
  [PG_OID.INT4]: 'integer',
  [PG_OID.NUMERIC]: 'decimal',
  [PG_OID.FLOAT4]: 'float',
  [PG_OID.FLOAT8]: 'float',
  [PG_OID.CHAR]: 'string',
  [PG_OID.NAME]: 'string',
  [PG_OID.TEXT]: 'string',
  [PG_OID.VARCHAR]: 'string',
  [PG_OID.DATE]: 'date',
  [PG_OID.TIME]: 'time',
  [PG_OID.TIMETZ]: 'time',
  [PG_OID.TIMESTAMP]: 'datetime',
  [PG_OID.TIMESTAMPTZ]: 'datetime',
  [PG_OID.JSON]: 'json',
  [PG_OID.JSONB]: 'json',
  [PG_OID.UUID]: 'uuid',
  [PG_OID.BYTEA]: 'binary',
};

export function oidToNormalizedType(oid: number, sample: unknown): NormalizedType {
  if (OID_TYPES[oid]) {
    return OID_TYPES[oid];
  }
  if (Array.isArray(sample)) return 'json'; // 数组类型 OID 无固定映射，按值判定
  if (typeof sample === 'number') return 'float';
  if (typeof sample === 'boolean') return 'boolean';
  if (sample !== null && typeof sample === 'object') return 'json';
  if (typeof sample === 'string') return 'string';
  return 'unknown';
}

const DATE_TIME_RE = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d+))?/;
const TIME_RE = /^(\d{2}:\d{2}:\d{2})(?:\.(\d+))?/;

/** 小数位规范化到毫秒（截断微秒；缺省补 .000） */
function normalizeFraction(base: string, frac: string | undefined): string {
  return `${base}.${(frac ?? '').padEnd(3, '0').slice(0, 3)}`;
}

/** timestamp（无时区）→ 'YYYY-MM-DD HH:mm:ss.SSS'，按服务端原文 */
export function normalizeTimestampText(v: string): string {
  const m = DATE_TIME_RE.exec(v);
  if (!m) return v;
  return normalizeFraction(`${m[1]} ${m[2]}`, m[3]);
}

/** timestamptz：服务端按会话时区渲染，剥去尾部偏移量保留墙上时间（概要 §4.4） */
export function normalizeTimestamptzText(v: string): string {
  const stripped = v.replace(/\s*(?:[+-]\d{2}(?::?\d{2})?|[A-Z]{2,5})$/, '');
  return normalizeTimestampText(stripped);
}

/** time → 'HH:mm:ss.SSS'；timetz 剥偏移 */
export function normalizeTimeText(v: string): string {
  const stripped = v.replace(/\s*(?:[+-]\d{2}(?::?\d{2})?|[A-Z]{2,5})$/, '');
  const m = TIME_RE.exec(stripped);
  if (!m) return v;
  return normalizeFraction(m[1], m[2]);
}

/** int8 安全转数值：|v| ≤ 2^53 → number（integer），超限保留字符串（decimal） */
export function isSafeIntString(v: string): boolean {
  return /^-?\d+$/.test(v) && Number.isSafeInteger(Number(v));
}

/** 值编码契约（概要设计 §4.4）：Buffer → base64；integer 列的 int8 字符串安全转数值 */
export function encodeCell(v: unknown, type: NormalizedType): unknown {
  if (v === null || v === undefined) {
    return null;
  }
  if (Buffer.isBuffer(v)) {
    return v.toString('base64');
  }
  if (type === 'integer' && typeof v === 'string' && isSafeIntString(v)) {
    return Number(v);
  }
  return v;
}
