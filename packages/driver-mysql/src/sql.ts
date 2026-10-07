import { DriverError, type FilterCondition, type NormalizedType } from '@db-explorer/core';

/**
 * 纯函数层：SQL 构建 / 类型归一 / 错误映射。
 * 与连接实现分离，便于无数据库环境下的契约级单测。
 */
export function quoteMysqlIdentifier(name: string): string {
  return '`' + name.replace(/`/g, '``') + '`';
}

/** LIKE 通配符转义由驱动负责（驱动开发规范 §4） */
/** 字符串字面量剥除后做整词匹配——判断用户片段是否已引用某列（忽略大小写） */
export function fragmentHasColumn(sql: string, column: string): boolean {
  const stripped = sql.replace(/'(?:[^']|'')*'/g, ' ');
  return new RegExp(`\\b${column.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(stripped);
}

export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
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
  /** 追加在 orderBySql 之后的兜底排序（如主键升序，保证翻页稳定 P-10） */
  tailSorts?: Array<{ column: string; dir: 'asc' | 'desc' }>;
  searchColumns: string[];
  limit: number;
  offset?: number;
}

export interface BuiltSelect {
  sql: string;
  params: unknown[];
}

/** 结构化筛选 → 参数化 SELECT（强制占位符，禁止值拼接，概要设计 §8） */
export function buildSelect(req: SelectParts): BuiltSelect {
  const params: unknown[] = [];
  const cols = req.columns && req.columns.length > 0 ? req.columns : null;
  const selectList = cols ? cols.map(quoteMysqlIdentifier).join(', ') : '*';
  let sql = `SELECT ${selectList} FROM ${quoteMysqlIdentifier(req.db)}.${quoteMysqlIdentifier(req.obj)}`;

  const where: string[] = [];
  for (const f of req.filters ?? []) {
    const col = quoteMysqlIdentifier(f.column);
    switch (f.op) {
      case 'eq':
        where.push(`${col} = ?`);
        params.push(f.value);
        break;
      case 'ne':
        where.push(`${col} <> ?`);
        params.push(f.value);
        break;
      case 'gt':
        where.push(`${col} > ?`);
        params.push(f.value);
        break;
      case 'ge':
        where.push(`${col} >= ?`);
        params.push(f.value);
        break;
      case 'lt':
        where.push(`${col} < ?`);
        params.push(f.value);
        break;
      case 'le':
        where.push(`${col} <= ?`);
        params.push(f.value);
        break;
      case 'like':
        where.push(`${col} LIKE ?`);
        params.push(`%${escapeLike(String(f.value ?? ''))}%`);
        break;
      case 'notLike':
        where.push(`${col} NOT LIKE ?`);
        params.push(`%${escapeLike(String(f.value ?? ''))}%`);
        break;
      case 'in': {
        const vals = f.values ?? [];
        if (vals.length === 0) {
          where.push('1 = 0');
          break;
        }
        where.push(`${col} IN (${vals.map(() => '?').join(', ')})`);
        params.push(...vals);
        break;
      }
      case 'notIn': {
        const vals = f.values ?? [];
        if (vals.length === 0) break;
        where.push(`${col} NOT IN (${vals.map(() => '?').join(', ')})`);
        params.push(...vals);
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
        where.push(`${col} BETWEEN ? AND ?`);
        params.push(lo, hi);
        break;
      }
      default:
        throw new DriverError('E_VALIDATION', `筛选操作符不受支持`);
    }
  }

  if (req.search && req.searchColumns.length > 0) {
    const kw = `%${escapeLike(req.search)}%`;
    where.push(
      `(${req.searchColumns.map((c) => `${quoteMysqlIdentifier(c)} LIKE ?`).join(' OR ')})`,
    );
    req.searchColumns.forEach(() => params.push(kw));
  }

  const userWhere = req.whereSql?.trim();
  if (userWhere) {
    // 用户自撰 SQL 片段（驱动规范 §4）：括号包裹保持 AND 语义，原样拼接不转义
    where.push(`(${userWhere})`);
  }
  if (where.length > 0) {
    sql += ` WHERE ${where.join(' AND ')}`;
  }
  const orderParts = (req.sorts ?? []).map(
    (s) => `${quoteMysqlIdentifier(s.column)} ${s.dir === 'desc' ? 'DESC' : 'ASC'}`,
  );
  const userOrder = req.orderBySql?.trim();
  if (userOrder) {
    orderParts.push(userOrder);
  }
  for (const t of req.tailSorts ?? []) {
    orderParts.push(`${quoteMysqlIdentifier(t.column)} ${t.dir === 'desc' ? 'DESC' : 'ASC'}`);
  }
  if (orderParts.length > 0) {
    sql += ` ORDER BY ${orderParts.join(', ')}`;
  }
  sql += ` LIMIT ?`;
  params.push(req.limit);
  if (req.offset !== undefined) {
    sql += ` OFFSET ?`;
    params.push(req.offset);
  }
  return { sql, params };
}

/** MySQL 类型 → NormalizedType（驱动开发规范 §5.1） */
export function normalizeMysqlType(dataType: string): NormalizedType {  const t = dataType.toLowerCase();
  if (t.startsWith('tinyint') || t.startsWith('smallint') || t.startsWith('mediumint') || t.startsWith('int') || t.startsWith('bigint')) {
    return 'integer';
  }
  if (t.startsWith('decimal') || t.startsWith('numeric')) {
    return 'decimal';
  }
  if (t.startsWith('float') || t.startsWith('double')) {
    return 'float';
  }
  if (t === 'boolean' || t === 'bool') {
    return 'boolean';
  }
  if (t === 'date') return 'date';
  if (t === 'time') return 'time';
  if (t.startsWith('datetime') || t.startsWith('timestamp')) return 'datetime';
  if (t === 'json') return 'json';
  if (t === 'uuid') return 'uuid';
  if (
    t.startsWith('binary') ||
    t.startsWith('varbinary') ||
    t.includes('blob') ||
    t.startsWith('geometry') ||
    GEOMETRY_TYPES.has(t)
  ) {
    return 'binary';
  }
  if (
    t.startsWith('char') ||
    t.startsWith('varchar') ||
    t.startsWith('text') ||
    t.startsWith('enum') ||
    t.startsWith('set')
  ) {
    return 'string';
  }
  return 'unknown';
}

/** 值编码契约（概要设计 4.4）：二进制 → base64；其余交由 mysql2 配置保证 */
export function encodeValue(v: unknown): unknown {
  if (Buffer.isBuffer(v)) {
    return v.toString('base64');
  }
  return v;
}

/** MySQL 系统库（SHOW DATABASES 结果过滤；连接表单列库建议，驱动规范 §3 @since v0.1.4） */
const MYSQL_SYSTEM_DATABASES = new Set(['information_schema', 'mysql', 'performance_schema', 'sys']);

export function filterMysqlDatabases(names: string[]): string[] {
  return names.filter((n) => !MYSQL_SYSTEM_DATABASES.has(n.toLowerCase()));
}

/** MySQL geometry 子类（WKB 存储，按二进制展示） */
const GEOMETRY_TYPES = new Set([
  'point',
  'linestring',
  'polygon',
  'multipoint',
  'multilinestring',
  'multipolygon',
  'geomcollection',
  'geometrycollection',
]);

const CONN_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'ETIMEDOUT',
  'EPIPE',
  'EHOSTUNREACH',
  'PROTOCOL_CONNECTION_LOST',
  'ERR_SOCKET_BAD_PORT',
]);

/** 原生错误 → DriverError 映射（驱动开发规范 §6） */
export function toDriverError(err: unknown): DriverError {
  if (DriverError.is(err)) {
    return err;
  }
  const e = err as { code?: string; sqlMessage?: string; message?: string };
  const raw = e.sqlMessage ?? e.message ?? String(err);
  const detail = [e.code, raw].filter(Boolean).join(' ');

  switch (e.code) {
    case 'ER_ACCESS_DENIED_ERROR':
      return new DriverError('E_AUTH', '认证失败：请检查用户名/密码', { detail });
    case 'ER_BAD_DB_ERROR':
      return new DriverError('E_NOT_FOUND', '数据库不存在', { detail });
    case 'ER_NO_SUCH_TABLE':
      return new DriverError('E_NOT_FOUND', '表不存在，可能已被删除', { detail });
    case 'ER_PARSE_ERROR':
      return new DriverError('E_SYNTAX', 'SQL 语法错误', { detail });
    case 'ER_DUP_ENTRY':
    case 'ER_BAD_NULL_ERROR':
    case 'ER_NO_REFERENCED_ROW':
    case 'ER_NO_REFERENCED_ROW_2':
    case 'ER_ROW_IS_REFERENCED':
    case 'ER_ROW_IS_REFERENCED_2':
      return new DriverError('E_CONSTRAINT', raw, { detail });
    case 'ER_NOT_SUPPORTED_YET':
      return new DriverError('E_UNSUPPORTED', '该语句/特性不被当前服务器支持', { detail });
    case 'ER_LOCK_WAIT_TIMEOUT':
      return new DriverError('E_TIMEOUT', '锁等待超时，事务可能被其他会话占用', { detail });
    default:
      if (e.code !== undefined && CONN_CODES.has(e.code)) {
        return new DriverError('E_CONN', '无法连接到数据库服务器（网络不可达或拒绝连接）', {
          detail,
        });
      }
      return new DriverError('E_INTERNAL', raw, { detail });
  }
}
