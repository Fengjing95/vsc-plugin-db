import { DriverError, type FilterCondition, type NormalizedType } from '@db-explorer/core';

/**
 * 纯函数层：SQL 构建 / 类型归一 / 值编码 / 时间文本规范化 / fetchInfo 装配。
 * 与连接实现分离，便于无数据库环境下的契约级单测（同 driver-mysql/pg/mssql 口径）。
 * db 参数语义（ADR D-23，D-15/D-21 同构）：db = schema 名，对象引用一律 "schema"."obj" 显式限定。
 * thin 模式取回语义（实测）：NUMBER 默认转 JS number（>2^53 丢精度）→ fetchInfo 按列 STRING 取回；
 * DATE/TIMESTAMP → JS Date 按客户端进程本地时区解释（无视会话 TIME_ZONE）→ 驱动按本地组件格式化。
 */

/** Oracle 标识符引用：双引号，内嵌双引号翻倍转义（fail-closed 的逃逸封死，P-58 口径） */
export function quoteOracleIdentifier(name: string): string {
  return '"' + name.replace(/"/g, '""') + '"';
}

/** LIKE 通配符转义由驱动负责（驱动规范 §4）；Oracle LIKE 默认无转义符，语句侧配 ESCAPE '\' */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/** 字符串字面量剥除后做整词匹配——判断用户 ORDER BY 片段是否已引用某列（忽略大小写） */
export function fragmentHasColumn(sql: string, column: string): boolean {
  const stripped = sql.replace(/'(?:[^']|'')*'/g, ' ');
  return new RegExp(`\\b${column.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(stripped);
}

// ── 建连描述符（ADR D-23 岔口 2：serviceName 寻址 + connectString 覆盖 + 建连死线）──────────

/**
 * 组装 connectString：用户显式 connectString 原样透传（EZConnect/完整描述符/tnsalias）；
 * 否则按 host/port/serviceName 组装完整描述符——携带 CONNECT_TIMEOUT/RETRY_*（P-30 同族：
 * thin 建连必须有死线，EZConnect 形态无法携带）。
 * 描述符参数注入防护：host/port/serviceName 经严格字符集校验（描述符不是 SQL，括号即逃逸路径），
 * 非法字符 → E_VALIDATION fail-closed。
 */
export function buildConnectString(opts: {
  connectString?: string;
  host?: string;
  port?: number;
  serviceName?: string;
  connectTimeoutMs?: number;
}): string {
  const custom = opts.connectString?.trim();
  if (custom) {
    return custom;
  }
  const host = opts.host ?? '';
  const port = Number(opts.port ?? 1521);
  const service = opts.serviceName ?? '';
  if (!host || !service) {
    throw new DriverError('E_VALIDATION', '缺少主机或服务名（或在高级选项中填写连接串）');
  }
  // 描述符值字符集：host 允许字母数字.-_（IPv6 场景用 connectString 直填），service 允许域形态
  if (!/^[A-Za-z0-9._-]+$/.test(host) || !/^[A-Za-z0-9._+-]+$/.test(service)) {
    throw new DriverError('E_VALIDATION', '主机/服务名含描述符不支持字符（请改用高级选项的连接串）');
  }
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new DriverError('E_VALIDATION', '端口非法');
  }
  const timeoutSec = Math.max(1, Math.ceil(Number(opts.connectTimeoutMs ?? 15_000) / 1000));
  return (
    `(DESCRIPTION=` +
    `(CONNECT_TIMEOUT=${timeoutSec})(RETRY_COUNT=1)(RETRY_DELAY=1)` +
    `(ADDRESS_LIST=(ADDRESS=(PROTOCOL=TCP)(HOST=${host})(PORT=${port})))` +
    `(CONNECT_DATA=(SERVICE_NAME=${service})))`
  );
}

// ── 参数化 SELECT（OFFSET/FETCH，12c+；ADR D-23 岔口 7）──────────────────────────────────

export interface SelectParts {
  db: string;
  obj: string;
  columns?: string[];
  filters?: FilterCondition[];
  sorts?: Array<{ column: string; dir: 'asc' | 'desc' }>;
  search?: string;
  /** 用户手写 WHERE 片段（驱动规范 §4：原样拼接，括号包裹保持 AND 语义；C-10 唯一例外） */
  whereSql?: string;
  /** 用户手写 ORDER BY 片段（追加在列头排序之后） */
  orderBySql?: string;
  /** 追加在 orderBySql 之后的兜底排序（主键升序，保证翻页稳定 P-10） */
  tailSorts?: Array<{ column: string; dir: 'asc' | 'desc' }>;
  searchColumns: string[];
  limit: number;
  offset?: number;
  /** 值编码 → 原生参数转换（§5：编辑回传 datetime 文本，绑定前转 Date；applyChanges 传，preview 不传） */
  encodeParam?: (column: string, value: unknown) => unknown;
}

export interface BuiltSelect {
  sql: string;
  params: unknown[];
}

/**
 * 结构化筛选 → 参数化 SELECT（:N 位置占位符，禁止值拼接）。
 * Oracle 12c+ 分页：OFFSET n ROWS FETCH NEXT m ROWS ONLY（必须带 ORDER BY，
 * 无排序时补 ORDER BY 1——常量表达式，语义中立）。
 */
export function buildSelect(req: SelectParts): BuiltSelect {
  const params: unknown[] = [];
  const enc = req.encodeParam ?? ((_column: string, value: unknown) => value);
  const next = (column: string, value: unknown): string => `:${params.push(enc(column, value))}`;
  const raw = (value: unknown): string => `:${params.push(value)}`;
  const cols = req.columns && req.columns.length > 0 ? req.columns : null;
  const selectList = cols ? cols.map(quoteOracleIdentifier).join(', ') : '*';
  let sql = `SELECT ${selectList} FROM ${quoteOracleIdentifier(req.db)}.${quoteOracleIdentifier(req.obj)}`;

  const where: string[] = [];
  for (const f of req.filters ?? []) {
    const col = quoteOracleIdentifier(f.column);
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
    where.push(`(${req.searchColumns.map((c) => `${quoteOracleIdentifier(c)} LIKE ${raw(kw)} ESCAPE '\\'`).join(' OR ')})`);
  }

  const userWhere = req.whereSql?.trim();
  if (userWhere) {
    where.push(`(${userWhere})`);
  }
  if (where.length > 0) {
    sql += ` WHERE ${where.join(' AND ')}`;
  }

  const orderParts = (req.sorts ?? []).map(
    (s) => `${quoteOracleIdentifier(s.column)} ${s.dir === 'desc' ? 'DESC' : 'ASC'}`,
  );
  const userOrder = req.orderBySql?.trim();
  if (userOrder) {
    orderParts.push(userOrder);
  }
  for (const t of req.tailSorts ?? []) {
    orderParts.push(`${quoteOracleIdentifier(t.column)} ${t.dir === 'desc' ? 'DESC' : 'ASC'}`);
  }
  // OFFSET/FETCH 硬性要求 ORDER BY（无排序补常量序）
  sql += ` ORDER BY ${orderParts.length > 0 ? orderParts.join(', ') : '1'}`;
  sql += ` OFFSET ${req.offset === undefined ? 0 : raw(req.offset)} ROWS FETCH NEXT ${raw(req.limit)} ROWS ONLY`;
  return { sql, params };
}

// ── 类型归一与元数据整形 ──────────────────────────────────────────────────────────────────

export interface OracleColumnMetaInput {
  /** all_tab_columns.data_type，如 VARCHAR2 / NUMBER / TIMESTAMP(6) 的基名 */
  dataType: string;
  /** all_tab_columns.data_precision（NUMBER/FLOAT；null = 未定精度 NUMBER） */
  precision: number | null;
  /** all_tab_columns.data_scale（NUMBER scale；TIMESTAMP 族 = 小数秒精度；null = 未定） */
  scale: number | null;
  /** all_tab_columns.char_length（字符语义长度） */
  charLength: number | null;
  /** all_tab_columns.char_used：'C' = CHAR 语义 / 'B' = BYTE 语义 */
  charUsed: string | null;
}

/** all_tab_columns 元数据 → 方言类型原文（listColumns 的 dataType；驱动规范 §5.7 roundtrip 口径） */
export function formatOracleDataType(m: OracleColumnMetaInput): string {
  const t = m.dataType.toUpperCase();
  if (t === 'NUMBER') {
    if (m.precision === null && m.scale === null) return 'NUMBER';
    const s = m.scale ?? 0;
    return s === 0 ? `NUMBER(${m.precision})` : `NUMBER(${m.precision}, ${s})`;
  }
  if (t === 'FLOAT') {
    return m.precision !== null ? `FLOAT(${m.precision})` : 'FLOAT';
  }
  if (t === 'VARCHAR2' || t === 'CHAR') {
    const unit = m.charUsed === 'C' ? ' CHAR' : '';
    return `${t}(${m.charLength ?? 0}${unit})`;
  }
  if (t === 'NVARCHAR2' || t === 'NCHAR' || t === 'RAW') {
    return `${t}(${m.charLength ?? 0})`;
  }
  if (t === 'TIMESTAMP' || t === 'TIMESTAMP WITH TIME ZONE' || t === 'TIMESTAMP WITH LOCAL TIME ZONE') {
    const fs = m.scale ?? 6;
    return fs === 6 ? t : `${t}(${fs})`;
  }
  return t;
}

/** 方言类型原文 → NormalizedType（驱动规范 §5.7；空串恒为 NULL 的引擎语义见 §5 注记） */
export function normalizeOracleType(dataType: string): NormalizedType {
  const t = dataType.toUpperCase();
  if (/^NUMBER(\(.+\))?$/.test(t)) {
    // scale 已并入 dataType 原文（NUMBER(9) → integer；NUMBER(12, 2) / 裸 NUMBER → decimal）
    if (/^NUMBER\(\s*\d+\s*\)$/.test(t)) return 'integer';
    return 'decimal';
  }
  if (t === 'FLOAT' || t === 'BINARY_DOUBLE' || t === 'BINARY_FLOAT') return 'float';
  if (t === 'DATE' || t.startsWith('TIMESTAMP')) return 'datetime';
  if (/^(VARCHAR2|NVARCHAR2|CHAR|NCHAR|CLOB|NCLOB|LONG|ROWID|UROWID)(\(|$)/.test(t)) return 'string';
  if (/^(RAW|BLOB|BFILE|LONG RAW)(\(|$)/.test(t)) return 'binary';
  return 'unknown';
}

/** int 字符串安全转数值：|v| ≤ 2^53 → number（integer），超限保留字符串（decimal，C-7 不丢精度） */
export function isSafeIntString(v: string): boolean {
  return /^-?\d+$/.test(v) && Number.isSafeInteger(Number(v));
}

// ── Date ↔ §5 文本（thin 把 DATE/TIMESTAMP 转为按客户端本地时区解释的 JS Date——
//    读侧取本地组件格式化、写侧按本地组件解析，两侧对称即往返稳定；ADR D-23 值编码表）──

const pad = (n: number, w = 2): string => String(n).padStart(w, '0');

export function formatLocalDate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function formatLocalTime(d: Date): string {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

export function formatLocalDateTime(d: Date): string {
  return `${formatLocalDate(d)} ${formatLocalTime(d)}`;
}

const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_ONLY_RE = /^(\d{2}):(\d{2})(?::(\d{2}))?(?:\.(\d+))?$/;
const DATETIME_RE = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?(?:\.(\d+))?$/;

/** §5 文本 → Date（本地组件，与读侧 formatLocal* 对称）；格式非法返回 null（调用方回落原样值） */
export function parseLocalDate(text: string, kind: 'date' | 'time' | 'datetime'): Date | null {
  if (kind === 'date') {
    const m = DATE_ONLY_RE.exec(text);
    if (!m) return null;
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  }
  if (kind === 'time') {
    const m = TIME_ONLY_RE.exec(text);
    if (!m) return null;
    return new Date(2000, 0, 1, Number(m[1]), Number(m[2]), Number(m[3] ?? 0), fracToMs(m[4]));
  }
  const m = DATETIME_RE.exec(text);
  if (!m) return null;
  return new Date(
    Number(m[1]), Number(m[2]) - 1, Number(m[3]),
    Number(m[4]), Number(m[5]), Number(m[6] ?? 0), fracToMs(m[7]),
  );
}

function fracToMs(frac: string | undefined): number {
  if (!frac) return 0;
  return Number(frac.padEnd(3, '0').slice(0, 3));
}

/** 值编码契约（概要设计 §4.4）：Buffer → base64；Date 按列类型以本地组件格式化；
 *  integer 列的数字字符串安全转数值（fetchInfo STRING 取回后的整形） */
export function encodeCell(v: unknown, type: NormalizedType): unknown {
  if (v === null || v === undefined) {
    return null;
  }
  if (Buffer.isBuffer(v)) {
    return v.toString('base64');
  }
  if (v instanceof Date) {
    if (type === 'date' || type === 'time') return formatLocalDate(v);
    return formatLocalDateTime(v);
  }
  if (type === 'integer' && typeof v === 'string' && isSafeIntString(v)) {
    return Number(v);
  }
  return v;
}

// ── fetchInfo 装配（ADR D-23 岔口 6：thin 下唯一不污染进程的按列取回控制面）────────────────

/** fetchRows 路径按列装配 fetchInfo：NUMBER → STRING（保精度，整形在 encodeCell）、
 *  CLOB/NCLOB → STRING、BLOB → BUFFER；键 = Oracle 返回列名（未引号列大写——listColumns 已是存储形态）。
 *  otype 常量由连接层传入（避免纯函数层 import oracledb） */
export function buildFetchInfo<T>(
  columns: Array<{ name: string; dataType: string }>,
  otypes: { STRING: T; BUFFER: T },
): Record<string, { type: T }> {
  const info: Record<string, { type: T }> = {};
  for (const c of columns) {
    const t = c.dataType.toUpperCase();
    if (/^NUMBER/.test(t)) {
      info[c.name] = { type: otypes.STRING };
    } else if (t === 'CLOB' || t === 'NCLOB') {
      info[c.name] = { type: otypes.STRING };
    } else if (t === 'BLOB') {
      info[c.name] = { type: otypes.BUFFER };
    }
  }
  return info;
}

/** query（Console）路径：metaData.dbTypeName → NormalizedType（列集执行前未知，NUMBER 按
 *  JS number 展示——>2^53 失真为 README 已知限制，ADR D-23 岔口 6） */
export function oracleDbTypeToNormalized(dbTypeName: string | undefined): NormalizedType {
  const t = (dbTypeName ?? '').toUpperCase();
  if (t === 'NUMBER' || t === 'INTEGER') return 'integer';
  if (t === 'FLOAT' || t === 'BINARY_DOUBLE' || t === 'BINARY_FLOAT') return 'float';
  if (t === 'DATE' || t.startsWith('TIMESTAMP')) return 'datetime';
  if (t === 'RAW' || t === 'BLOB' || t === 'BFILE' || t === 'LONG RAW') return 'binary';
  if (/CHAR|CLOB|LONG|ROWID/.test(t)) return 'string';
  return 'unknown';
}

// ── §5 编辑回传 → 原生绑定参数 ────────────────────────────────────────────────────────────

/** JS 对象/数组 → JSON 文本（P-53 同族收口：19c 无原生 JSON 类型，CLOB/VARCHAR2 文本承载） */
export function toOracleParam(value: unknown): unknown {
  if (value !== null && typeof value === 'object' && !Buffer.isBuffer(value) && !(value instanceof Date)) {
    return JSON.stringify(value);
  }
  return value;
}

/** §5 编辑回传 → 原生绑定值：datetime/date/time 文本 → Date（本地组件，与读侧对称）；
 *  binary base64 → Buffer；integer 列数字字符串 → number；对象/数组 → JSON 文本；其余原样 */
export function toNativeParam(
  column: string,
  value: unknown,
  typeByName: Map<string, NormalizedType>,
): unknown {
  const type = typeByName.get(column);
  if (value === null || value === undefined) {
    return value;
  }
  if (type === 'binary' && typeof value === 'string') {
    return Buffer.from(value, 'base64');
  }
  if (typeof value === 'string') {
    if (type === 'datetime') {
      const parsed = parseLocalDate(value, 'datetime');
      if (parsed) return parsed;
    }
    if (type === 'date') {
      const parsed = parseLocalDate(value, 'date');
      if (parsed) return parsed;
    }
    if (type === 'time') {
      const parsed = parseLocalDate(value, 'time');
      if (parsed) return parsed;
    }
    if (type === 'integer' && isSafeIntString(value)) {
      return Number(value);
    }
  }
  return toOracleParam(value);
}

/** all_tab_columns.data_default 去引号 roundtrip（P-49 同款口径）：
 *  "'abc'" → 'abc'（'' 翻倍还原）、'42' → '42'、'SYSDATE' 原样；null（无默认）→ undefined */
export function stripOracleColumnDefault(raw: string | null | undefined): string | undefined {
  if (raw === null || raw === undefined) {
    return undefined;
  }
  let s = raw.trim();
  while (s.length >= 2 && s.startsWith('(') && s.endsWith(')')) {
    s = s.slice(1, -1).trim();
  }
  if (s.length >= 2 && s.startsWith("'") && s.endsWith("'")) {
    return s.slice(1, -1).replace(/''/g, "'");
  }
  if (/^null$/i.test(s)) {
    return undefined;
  }
  return s;
}
