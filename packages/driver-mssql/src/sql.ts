import { DriverError, type FilterCondition, type NormalizedType } from '@db-explorer/core';

/**
 * 纯函数层：SQL 构建 / 类型归一 / 值编码 / 时间文本规范化。
 * 与连接实现分离，便于无数据库环境下的契约级单测（同 driver-mysql/pg 口径）。
 * db 参数语义（ADR D-21，D-15 同构）：db = schema 名，SQL 中对象引用一律 [schema].[obj] 显式限定。
 */

/** T-SQL 标识符引用：方括号（SSMS 惯例），] 翻倍转义 */
export function quoteMssqlIdentifier(name: string): string {
  return '[' + name.replace(/]/g, ']]') + ']';
}

/** LIKE 通配符转义由驱动负责（驱动规范 §4）；T-SQL LIKE 默认无转义符，语句侧配 ESCAPE '\' */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/** 字符串字面量剥除后做整词匹配——判断用户片段是否已引用某列（忽略大小写） */
export function fragmentHasColumn(sql: string, column: string): boolean {
  const stripped = sql.replace(/'(?:[^']|'')*'/g, ' ');
  return new RegExp(`\\b${column.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(stripped);
}

/** 系统固定架构（sys.schemas 硬过滤，@since v0.1.12 同款口径）：9 个 db_* 角色架构 + sys/information_schema/guest */
const SYSTEM_SCHEMAS = new Set([
  'sys',
  'information_schema',
  'guest',
  'db_accessadmin',
  'db_backupoperator',
  'db_datareader',
  'db_datawriter',
  'db_ddladmin',
  'db_denydatareader',
  'db_denydatawriter',
  'db_owner',
  'db_securityadmin',
]);

export function filterMssqlSchemas(names: string[]): string[] {
  return names.filter((n) => !SYSTEM_SCHEMAS.has(n.toLowerCase()));
}

export interface MssqlColumnMetaInput {
  /** sys.types.name，如 nvarchar / decimal / datetime2 */
  typeName: string;
  /** sys.columns.max_length（字节；nvarchar/nchar 半宽按字符计；-1 = MAX） */
  maxLength: number;
  precision: number;
  scale: number;
}

/** sys.columns 元数据 → 方言类型原文（listColumns 的 dataType；与格式化精度相关的类型按元数据组装） */
export function formatMssqlDataType(m: MssqlColumnMetaInput): string {
  const t = m.typeName.toLowerCase();
  if (t === 'nvarchar' || t === 'nchar') {
    return m.maxLength === -1 ? `${t}(max)` : `${t}(${Math.floor(m.maxLength / 2)})`;
  }
  if (t === 'varchar' || t === 'char' || t === 'varbinary' || t === 'binary') {
    return m.maxLength === -1 ? `${t}(max)` : `${t}(${m.maxLength})`;
  }
  if (t === 'decimal' || t === 'numeric') {
    return `${t}(${m.precision}, ${m.scale})`;
  }
  if (t === 'datetime2' || t === 'datetimeoffset' || t === 'time') {
    return `${t}(${m.scale})`;
  }
  return t;
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
  /** 值编码 → 原生参数转换（§5：编辑回传 datetime 文本，驱动绑定前转 TypedDate 等） */
  encodeParam?: (column: string, value: unknown) => unknown;
}

export interface BuiltSelect {
  sql: string;
  params: unknown[];
}

/**
 * 结构化筛选 → 参数化 SELECT（@pN 占位符，禁止值拼接，概要设计 §8）。
 * T-SQL 无 LIMIT：OFFSET n ROWS FETCH NEXT m ROWS ONLY——FETCH 必须带 OFFSET（缺省补 0），
 * 且二者必须存在 ORDER BY（无排序时补 ORDER BY (SELECT NULL)）。
 */
export function buildSelect(req: SelectParts): BuiltSelect {
  const params: unknown[] = [];
  const enc = req.encodeParam ?? ((_column: string, value: unknown) => value);
  const next = (column: string, value: unknown): string => `@p${params.push(enc(column, value))}`;
  const raw = (value: unknown): string => `@p${params.push(value)}`;
  const cols = req.columns && req.columns.length > 0 ? req.columns : null;
  const selectList = cols ? cols.map(quoteMssqlIdentifier).join(', ') : '*';
  let sql = `SELECT ${selectList} FROM ${quoteMssqlIdentifier(req.db)}.${quoteMssqlIdentifier(req.obj)}`;

  const where: string[] = [];
  for (const f of req.filters ?? []) {
    const col = quoteMssqlIdentifier(f.column);
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
    const kw = `%${escapeLike(req.search)}%`;
    // 大小写敏感 LIKE：与契约内存基准（JS includes）一致；关键字非列定位值，不经 encodeParam
    where.push(`(${req.searchColumns.map((c) => `${quoteMssqlIdentifier(c)} LIKE ${raw(kw)} ESCAPE '\\'`).join(' OR ')})`);
  }

  const userWhere = req.whereSql?.trim();
  if (userWhere) {
    where.push(`(${userWhere})`);
  }
  if (where.length > 0) {
    sql += ` WHERE ${where.join(' AND ')}`;
  }

  const orderParts = (req.sorts ?? []).map(
    (s) => `${quoteMssqlIdentifier(s.column)} ${s.dir === 'desc' ? 'DESC' : 'ASC'}`,
  );
  const userOrder = req.orderBySql?.trim();
  if (userOrder) {
    orderParts.push(userOrder);
  }
  for (const t of req.tailSorts ?? []) {
    orderParts.push(`${quoteMssqlIdentifier(t.column)} ${t.dir === 'desc' ? 'DESC' : 'ASC'}`);
  }
  // T-SQL 硬性要求：OFFSET/FETCH 必须有 ORDER BY
  sql += ` ORDER BY ${orderParts.length > 0 ? orderParts.join(', ') : '(SELECT NULL)'}`;
  sql += ` OFFSET ${req.offset === undefined ? 0 : raw(req.offset)} ROWS FETCH NEXT ${raw(req.limit)} ROWS ONLY`;
  return { sql, params };
}

/** SQL Server 类型 → NormalizedType（驱动规范 §5.6；dataType 为 sys.types 归一原文） */
export function normalizeMssqlType(dataType: string): NormalizedType {
  const t = dataType.toLowerCase();
  if (/^(tinyint|smallint|int|bigint)$/.test(t)) {
    return 'integer';
  }
  if (/^(decimal|numeric|money|smallmoney)$/.test(t) || /^(decimal|numeric)\(/.test(t)) {
    return 'decimal';
  }
  if (t === 'float' || t === 'real') {
    return 'float';
  }
  if (t === 'bit') {
    return 'boolean';
  }
  if (t === 'date') return 'date';
  if (t === 'time' || t.startsWith('time(')) return 'time';
  if (/^(datetime|datetime2|smalldatetime|datetimeoffset)/.test(t)) {
    return 'datetime';
  }
  if (t === 'uniqueidentifier') return 'uuid';
  if (/^(binary|varbinary|image|rowversion|timestamp)/.test(t)) {
    return 'binary';
  }
  if (/^(char|nchar|varchar|nvarchar|text|ntext|xml)/.test(t)) {
    return 'string';
  }
  return 'unknown';
}

/** int 字符串安全转数值：|v| ≤ 2^53 → number（integer），超限保留字符串（decimal，C-7 不丢精度） */
export function isSafeIntString(v: string): boolean {
  return /^-?\d+$/.test(v) && Number.isSafeInteger(Number(v));
}

// ── Date → §5 文本（tedious 按 UTC 组件解析 TDS 时间，读侧统一用 getUTC* 还原墙上时间）──

const pad = (n: number, w = 2): string => String(n).padStart(w, '0');

export function formatUtcDate(d: Date): string {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

export function formatUtcTime(d: Date): string {
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}.${pad(d.getUTCMilliseconds(), 3)}`;
}

export function formatUtcDateTime(d: Date): string {
  return `${formatUtcDate(d)} ${formatUtcTime(d)}`;
}

/** 值编码契约（概要设计 §4.4）：Buffer → base64；Date 按列类型格式化；整数字符串安全转数值 */
export function encodeCell(v: unknown, type: NormalizedType): unknown {
  if (v === null || v === undefined) {
    return null;
  }
  if (Buffer.isBuffer(v)) {
    return v.toString('base64');
  }
  if (v instanceof Date) {
    if (type === 'date') return formatUtcDate(v);
    if (type === 'time') return formatUtcTime(v);
    if (type === 'datetime') return formatUtcDateTime(v);
    return v;
  }
  if (type === 'integer' && typeof v === 'string' && isSafeIntString(v)) {
    return Number(v);
  }
  return v;
}

// ── §5 编辑回传 → 原生绑定参数（tedious 语义）────────────────────────────────

const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_ONLY_RE = /^(\d{2}):(\d{2})(?::(\d{2}))?(?:\.(\d+))?$/;
const DATETIME_RE = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?(?:\.(\d+))?$/;

/**
 * 原生绑定参数：日期时间走 tedious 原生类型（DateTime2/Date/Time，毫秒级精度——
 * 字符串直传 NVarChar 依赖会话 DATEFORMAT 的隐式转换，非确定性），二进制走 VarBinary Buffer。
 * kind 由连接层 bindParam 翻译为 mssql.TYPES.* 显式绑定。
 */
export class TypedDateParam {
  constructor(
    readonly kind: 'date' | 'time' | 'datetime',
    readonly value: Date,
  ) {}
}

/** 二进制列的 NULL 绑定标记：mssql 对 null 参数自动推断为 NVarChar，而 nvarchar→varbinary
 *  是 CONVERT-only（无隐式转换，T-SQL 转换表）——含 varbinary 列的 NULL 绑定（新增行留空/
 *  清空单元格/契约全 NULL 行）必须经 bindParams 翻译为显式 VarBinary 类型（CI mssql 契约首跑抓到） */
export class TypedNullParam {}

/** §5 文本 → Date（UTC 组件，tedious 读侧 getUTC* 对称）；格式非法返回 null（调用方回落原样值） */
export function parseUtcDate(text: string, kind: 'date' | 'time' | 'datetime'): Date | null {
  if (kind === 'date') {
    const m = DATE_ONLY_RE.exec(text);
    if (!m) return null;
    return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  }
  if (kind === 'time') {
    const m = TIME_ONLY_RE.exec(text);
    if (!m) return null;
    return new Date(Date.UTC(1970, 0, 1, Number(m[1]), Number(m[2]), Number(m[3] ?? 0), fracToMs(m[4])));
  }
  const m = DATETIME_RE.exec(text);
  if (!m) return null;
  return new Date(
    Date.UTC(
      Number(m[1]), Number(m[2]) - 1, Number(m[3]),
      Number(m[4]), Number(m[5]), Number(m[6] ?? 0), fracToMs(m[7]),
    ),
  );
}

function fracToMs(frac: string | undefined): number {
  if (!frac) return 0;
  return Number(frac.padEnd(3, '0').slice(0, 3));
}

/**
 * JS 对象/数组 → JSON 文本（C-7 的 JSON=已解析对象在 mssql 绑定边界收口，P-53 同族：
 * 对象参数直传 tedious 无原生映射，NVARCHAR 存 JSON 文本是 SQL Server 的事实口径）。
 * TypedDateParam/Buffer 透传。
 */
export function toMssqlParam(value: unknown): unknown {
  if (value !== null && typeof value === 'object' && !Buffer.isBuffer(value) && !(value instanceof TypedDateParam) && !(value instanceof TypedNullParam) && !(value instanceof Date)) {
    return JSON.stringify(value);
  }
  return value;
}

/** §5 编辑回传 → 原生绑定值：datetime/date/time 文本 → TypedDateParam；binary base64 → Buffer；
 *  binary 列的 null → TypedNullParam（显式 VarBinary 绑定）；其余收口 */
export function toNativeParam(
  column: string,
  value: unknown,
  typeByName: Map<string, NormalizedType>,
): unknown {
  const type = typeByName.get(column);
  if (value === null || value === undefined) {
    return type === 'binary' ? new TypedNullParam() : value;
  }
  if (type === 'binary' && typeof value === 'string') {
    return Buffer.from(value, 'base64');
  }
  if (typeof value === 'string') {
    if (type === 'date' || type === 'time' || type === 'datetime') {
      const parsed = parseUtcDate(value, type);
      if (parsed) {
        return new TypedDateParam(type, parsed);
      }
    }
    if (type === 'integer' && isSafeIntString(value)) {
      return Number(value); // 整型列的数字字符串转 number（tedious Int 绑定语义）
    }
  }
  return toMssqlParam(value);
}

/** sys.default_constraints.definition 去括号/去引号 roundtrip（P-49 同款口径）：
 *  '((0))' → '0'，"(N'anon')" / "('anon')" → 'anon'，'(getdate())' → 'getdate()'；NULL 无默认 → undefined */
export function stripMssqlColumnDefault(raw: string | null | undefined): string | undefined {
  if (raw === null || raw === undefined) {
    return undefined;
  }
  let s = raw.trim();
  // 逐层剥外层括号：((0)) → 0，(N'anon') → N'anon'，(getdate()) → getdate()
  while (s.length >= 2 && s.startsWith('(') && s.endsWith(')')) {
    s = s.slice(1, -1).trim();
  }
  // 字符串字面量去 N 前缀与单引号（'' 翻倍还原）
  if (s.length >= 3 && /^N'/.test(s) && s.endsWith("'")) {
    s = s.slice(1);
  }
  if (s.length >= 2 && s.startsWith("'") && s.endsWith("'")) {
    return s.slice(1, -1).replace(/''/g, "'");
  }
  return s;
}
