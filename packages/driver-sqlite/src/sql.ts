import { DriverError, type FilterCondition, type NormalizedType } from '@db-explorer/core';

/**
 * 纯函数层：SQL 构建 / 类型归一 / 值编码 / 语句判定。
 * 与连接实现分离，便于无数据库环境下的契约级单测（同 driver-mysql/driver-postgres 口径）。
 * db 语义（D-16）：单文件单库，db 参数恒 'main'，SQL 中对象引用为裸名（双引号引用）。
 */

export function quoteIdentifier(name: string): string {
  return '"' + name.replace(/"/g, '""') + '"';
}

/** SQL 字符串字面量（'' 翻倍转义）——sqlite_master/PRAGMA 查询的谓词用 */
export function quoteStringLiteral(value: string): string {
  return "'" + value.replace(/'/g, "''") + "'";
}

/** LIKE 通配符转义由驱动负责（驱动规范 §4）；SQLite LIKE 需显式 ESCAPE '\' 才有转义符 */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/** 字符串字面量剥除后做整词匹配——判断用户片段是否已引用某列（忽略大小写） */
export function fragmentHasColumn(sql: string, column: string): boolean {
  const stripped = sql.replace(/'(?:[^']|'')*'/g, ' ');
  return new RegExp(`\\b${column.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(stripped);
}

/** 只读语句前缀：SELECT/PRAGMA/EXPLAIN/VALUES 之外一律视为可能写库（WITH 可能是 CTE 写，保守归入）。
 *  用于 sql.js 引擎的脏标记（DDL 不计入 changes()，需语句形状判定）与只读连接写入拒绝。 */
const READ_PREFIX_RE = /^\s*(SELECT|PRAGMA|EXPLAIN|VALUES)\b/i;

export function isMutatingSql(sql: string): boolean {
  return !READ_PREFIX_RE.test(sql);
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
  /** 值编码 → 原生参数转换（§5：编辑回传 base64 字符串，applyChanges 绑定前转 Uint8Array 等）；
   *  仅列定位值经此钩子（search 关键字与 LIMIT/OFFSET 不经列语义） */
  encodeParam?: (column: string, value: unknown) => unknown;
}

export interface BuiltSelect {
  sql: string;
  params: unknown[];
}

/** 结构化筛选 → 参数化 SELECT（? 占位符，禁止值拼接，概要设计 §8） */
export function buildSelect(req: SelectParts): BuiltSelect {
  const params: unknown[] = [];
  const enc = req.encodeParam ?? ((_column: string, value: unknown) => value);
  const next = (column: string, value: unknown): string => {
    params.push(enc(column, value));
    return '?';
  };
  const raw = (value: unknown): string => {
    params.push(value);
    return '?';
  };
  const cols = req.columns && req.columns.length > 0 ? req.columns : null;
  const selectList = cols ? cols.map(quoteIdentifier).join(', ') : '*';
  let sql = `SELECT ${selectList} FROM ${quoteIdentifier(req.obj)}`;

  const where: string[] = [];
  for (const f of req.filters ?? []) {
    const col = quoteIdentifier(f.column);
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
        where.push(`${col} LIKE ${raw(`%${escapeLike(String(f.value ?? ''))}%`)} ESCAPE '\\'`);
        break;
      case 'notLike':
        where.push(`${col} NOT LIKE ${raw(`%${escapeLike(String(f.value ?? ''))}%`)} ESCAPE '\\'`);
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
    // instr：大小写敏感子串匹配（与契约内存基准 includes 严格一致），无通配符语义、零转义风险（§5.4）
    where.push(`(${req.searchColumns.map((c) => `instr(${quoteIdentifier(c)}, ${raw(req.search)}) > 0`).join(' OR ')})`);
  }

  const userWhere = req.whereSql?.trim();
  if (userWhere) {
    where.push(`(${userWhere})`);
  }
  if (where.length > 0) {
    sql += ` WHERE ${where.join(' AND ')}`;
  }

  const orderParts = (req.sorts ?? []).map(
    (s) => `${quoteIdentifier(s.column)} ${s.dir === 'desc' ? 'DESC' : 'ASC'}`,
  );
  const userOrder = req.orderBySql?.trim();
  if (userOrder) {
    orderParts.push(userOrder);
  }
  for (const t of req.tailSorts ?? []) {
    orderParts.push(`${quoteIdentifier(t.column)} ${t.dir === 'desc' ? 'DESC' : 'ASC'}`);
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

/**
 * SQLite 声明类型 → NormalizedType（驱动规范 §5.4；dataType 为建表声明原文，SQLite 动态类型、
 * 列可为任意存储类——值编码另有存储类兜底）。匹配顺序：BOOL/JSON → 日期时间 → INT → TEXT 族 →
 * BLOB → REAL 族 → NUMERIC（DATETIME/TIMESTAMP 含 TIME 字样，须先于 TIME 判定）。
 */
export function normalizeSqliteType(dataType: string): NormalizedType {
  const t = (dataType ?? '').trim().toLowerCase();
  if (t === '') return 'unknown';
  if (t.includes('bool')) return 'boolean';
  if (t.includes('json')) return 'json';
  if (t.includes('datetime') || t.includes('timestamp')) return 'datetime';
  if (t.includes('date')) return 'date';
  if (t.includes('time')) return 'time';
  if (t.includes('int')) return 'integer';
  if (t.includes('char') || t.includes('clob') || t.includes('text')) return 'string';
  if (t.includes('blob')) return 'binary';
  if (t.includes('real') || t.includes('floa') || t.includes('doub')) return 'float';
  if (t.includes('num') || t.includes('dec')) return 'decimal';
  return 'unknown';
}

/** query() 结果列类型推断（fetchRows 走 listColumns 元数据，无需此函数；Console 结果按值样本判定） */
export function valueToNormalizedType(sample: unknown): NormalizedType {
  if (typeof sample === 'bigint') return 'integer';
  if (typeof sample === 'number') return Number.isInteger(sample) ? 'integer' : 'float';
  if (typeof sample === 'string') return 'string';
  if (sample instanceof Uint8Array) return 'binary';
  if (typeof sample === 'object' && sample !== null) return 'json';
  return 'unknown';
}

/** |v| ≤ 2^53 的整数字符串 → number（integer），否则保留字符串（decimal，C-7 不丢精度） */
export function isSafeIntString(v: string): boolean {
  return /^-?\d+$/.test(v) && Number.isSafeInteger(Number(v));
}

/**
 * 值编码契约（概要设计 §4.4 / 驱动规范 §5.4）：BLOB 存储 → base64；
 * BigInt 通道的整数 |v| ≤ 2^53 → number，超限 → 字符串；decimal 列数值 → 字符串；
 * boolean 列 0/1 → false/true；json 列文本 → JSON.parse（失败回落原文）。
 */
export function encodeCell(v: unknown, type: NormalizedType): unknown {
  if (v === null || v === undefined) {
    return null;
  }
  if (v instanceof Uint8Array) {
    return Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('base64');
  }
  // BOOLEAN 列整形先于 BigInt 通道（0n/1n → false/true，避免先被转成数字）
  if (type === 'boolean' && (v === 0 || v === 1 || v === 0n || v === 1n)) {
    return v === 1 || v === 1n; // BOOLEAN 惯例 0/1 存储（BigInt 通道读出为 0n/1n）
  }
  if (typeof v === 'bigint') {
    const n = Number(v);
    return Number.isSafeInteger(n) ? n : v.toString();
  }
  if (type === 'decimal' && typeof v === 'number') {
    return String(v);
  }
  if (type === 'json' && typeof v === 'string') {
    try {
      return JSON.parse(v) as unknown;
    } catch {
      return v;
    }
  }
  return v;
}

/**
 * §5 编辑回传 → 原生参数：boolean → 1/0（SQLite 无布尔）；binary 列 base64 → Uint8Array；
 * json 列对象/数组 → JSON.stringify；其余透传（超限整数字符串依赖列 affinity 转换）。
 * previewChanges 不经此钩子——预览 params 保持 §5 编码（Webview 回填展示依赖，P-22）。
 */
export function toNativeParam(column: string, value: unknown, typeByName: Map<string, NormalizedType>): unknown {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'boolean') {
    return value ? 1 : 0;
  }
  const type = typeByName.get(column);
  if (type === 'binary' && typeof value === 'string') {
    return Buffer.from(value, 'base64');
  }
  if (type === 'json' && typeof value === 'object') {
    return JSON.stringify(value);
  }
  if (typeof value === 'bigint') {
    return value.toString();
  }
  return value;
}

/** PRAGMA table_info 的 dflt_value → 值原文（ColumnSpec 契约：不含引号，'' 翻倍还原） */
export function unquoteDdlDefault(raw: unknown): string | undefined {
  if (raw === null || raw === undefined) {
    return undefined;
  }
  const s = String(raw);
  if (s.length >= 2 && s.startsWith("'") && s.endsWith("'")) {
    return s.slice(1, -1).replace(/''/g, "'");
  }
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    return s.slice(1, -1).replace(/""/g, '"');
  }
  return s;
}
