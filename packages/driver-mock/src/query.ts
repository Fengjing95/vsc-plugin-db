import { DriverError, type ColumnMeta, type ResultSet } from '@db-explorer/core';
import { compileOrderBy, compileWhere } from './whereEval';

/**
 * M5 mock 驱动最小 SQL 执行（本地无真实库时的 Console 自测路径）：
 * SELECT（含 COUNT(*)）/ INSERT / UPDATE / DELETE 子集，WHERE/ORDER BY 复用
 * whereEval 求值器（与 fetchRows 同源语义），值编码遵循 C-7。其余语句 → E_UNSUPPORTED。
 * supportsMultiStatement=false，core 已按语句切分，这里只收单条语句。
 */

export interface TableRef {
  db?: string;
  table: string;
}

export type MockPlan =
  | {
      kind: 'select';
      ref: TableRef;
      projection: string[] | '*';
      countStar: boolean;
      where?: string;
      orderBy?: string;
      limit?: number;
      offset?: number;
    }
  | { kind: 'insert'; ref: TableRef; columns: string[]; tuples: unknown[][] }
  | { kind: 'update'; ref: TableRef; sets: Array<{ column: string; value: unknown }>; where?: string }
  | { kind: 'delete'; ref: TableRef; where?: string };

export function parseMockStatement(rawSql: string): MockPlan {
  const sql = rawSql.trim().replace(/;\s*$/, '').trim();
  const head = firstKeyword(sql);
  switch (head) {
    case 'SELECT':
      return parseSelect(sql);
    case 'INSERT':
      return parseInsert(sql);
    case 'UPDATE':
      return parseUpdate(sql);
    case 'DELETE':
      return parseDelete(sql);
    default:
      throw new DriverError(
        'E_UNSUPPORTED',
        `mock 驱动仅支持基础 SELECT/INSERT/UPDATE/DELETE（收到 ${head || '空语句'}）`,
      );
  }
}

function firstKeyword(sql: string): string {
  const m = /^[A-Za-z]+/.exec(sql);
  return m ? m[0].toUpperCase() : '';
}

/** 关键字定位：返回 { index, length }（length 取实际匹配文本，容忍空白差异） */
function findClause(text: string, re: RegExp): { index: number; length: number } | undefined {
  const m = re.exec(text);
  return m ? { index: m.index, length: m[0].length } : undefined;
}

/** [start, end) 段文本（end 缺省到串尾），trim 后返回 */
function segment(text: string, start: number, end?: number): string {
  return text.slice(start, end ?? text.length).trim();
}

// ── 表引用 ───────────────────────────────────────────────────

const TABLE_REF = /^([`"]?)([\w$]+)\1(?:\s*\.\s*([`"]?)([\w$]+)\1)?\s*$/;

function parseTableRef(text: string): TableRef {
  const m = TABLE_REF.exec(text.trim());
  if (!m) {
    throw new DriverError('E_VALIDATION', `mock 驱动无法解析表名 "${text.trim()}"`);
  }
  return m[4] !== undefined ? { db: m[2], table: m[4] } : { table: m[2] };
}

// ── SELECT ───────────────────────────────────────────────────

function parseSelect(sql: string): MockPlan {
  const from = findClause(sql, /\bfrom\b/i);
  if (!from) {
    throw new DriverError('E_VALIDATION', 'mock 驱动：SELECT 缺少 FROM 子句');
  }
  const projectionText = segment(sql, 'select'.length, from.index);
  const rest = sql.slice(from.index + from.length);

  const where = findClause(rest, /\bwhere\b/i);
  const order = findClause(rest, /\border\s+by\b/i);
  const limit = findClause(rest, /\blimit\b/i);

  // 表名段 = FROM 后到第一个子句关键字
  const clauseStarts = [where?.index, order?.index, limit?.index].filter((i): i is number => i !== undefined);
  const tableEnd = clauseStarts.length > 0 ? Math.min(...clauseStarts) : rest.length;
  const ref = parseTableRef(rest.slice(0, tableEnd));

  const afterOf = (mark: { index: number } | undefined): number | undefined => {
    if (!mark) {
      return undefined;
    }
    const later = clauseStarts.filter((i) => i > mark.index);
    return later.length > 0 ? Math.min(...later) : undefined;
  };

  const whereText = where ? segment(rest, where.index + where.length, afterOf(where)) : undefined;
  const orderText = order ? segment(rest, order.index + order.length, afterOf(order)) : undefined;
  const limitText = limit ? segment(rest, limit.index + limit.length, afterOf(limit)) : undefined;
  const { limitNum, offsetNum } = parseLimit(limitText);

  return {
    kind: 'select',
    ref,
    ...parseProjection(projectionText),
    where: whereText,
    orderBy: orderText,
    limit: limitNum,
    offset: offsetNum,
  };
}

function parseProjection(text: string): { projection: string[] | '*'; countStar: boolean } {
  const normalized = text.trim();
  if (normalized === '*') {
    return { projection: '*', countStar: false };
  }
  const countStar = /^count\s*\(\s*\*\s*\)$/i.test(normalized);
  if (countStar) {
    return { projection: '*', countStar: true };
  }
  const parts = normalized.split(',').map((p) => p.trim().replace(/^[`"]/, '').replace(/[`"]$/, ''));
  if (parts.some((p) => p === '' || /[*,\s]/.test(p))) {
    throw new DriverError('E_VALIDATION', `mock 驱动不支持该 SELECT 投影 "${normalized}"`);
  }
  return { projection: parts, countStar: false };
}

function parseLimit(text: string | undefined): { limitNum?: number; offsetNum?: number } {
  if (!text) {
    return {};
  }
  // LIMIT n [OFFSET m] | LIMIT offset, n（MySQL 形式）
  let m = /^(\d+)(?:\s+offset\s+(\d+))$/i.exec(text);
  if (m) {
    return { limitNum: Number(m[1]), offsetNum: Number(m[2]) };
  }
  m = /^(\d+)\s*,\s*(\d+)$/i.exec(text);
  if (m) {
    return { offsetNum: Number(m[1]), limitNum: Number(m[2]) };
  }
  m = /^(\d+)$/i.exec(text);
  if (m) {
    return { limitNum: Number(m[1]) };
  }
  throw new DriverError('E_VALIDATION', `mock 驱动无法解析 LIMIT "${text}"`);
}

// ── INSERT / UPDATE / DELETE ─────────────────────────────────

function parseInsert(sql: string): MockPlan {
  const m = /^insert\s+into\s+([\s\S]+?)\s*\(([^)]*)\)\s*values\s*([\s\S]+)$/i.exec(sql);
  if (!m) {
    throw new DriverError('E_VALIDATION', 'mock 驱动 INSERT 形式：INSERT INTO t (c1, c2) VALUES (...), (...)');
  }
  const ref = parseTableRef(m[1]);
  const columns = splitTopLevel(m[2]).map((c) => stripQuotes(c.trim()));
  if (columns.some((c) => !c)) {
    throw new DriverError('E_VALIDATION', 'mock 驱动 INSERT 列名解析失败');
  }
  const tuples = splitTuples(m[3]).map((tuple) => splitTopLevel(tuple).map((v) => parseLiteral(v.trim())));
  for (const tuple of tuples) {
    if (tuple.length !== columns.length) {
      throw new DriverError('E_VALIDATION', 'mock 驱动 INSERT：值个数与列数不一致');
    }
  }
  return { kind: 'insert', ref, columns, tuples };
}

function parseUpdate(sql: string): MockPlan {
  const m = /^update\s+([\s\S]+?)\s+set\s+([\s\S]+?)(?:\s+where\s+([\s\S]+))?$/i.exec(sql);
  if (!m) {
    throw new DriverError('E_VALIDATION', 'mock 驱动无法解析 UPDATE 语句');
  }
  const ref = parseTableRef(m[1]);
  const sets = splitTopLevel(m[2]).map((pair) => {
    const eq = pair.indexOf('=');
    if (eq <= 0) {
      throw new DriverError('E_VALIDATION', `mock 驱动 UPDATE SET 解析失败 "${pair.trim()}"`);
    }
    return {
      column: stripQuotes(pair.slice(0, eq).trim()),
      value: parseLiteral(pair.slice(eq + 1).trim()),
    };
  });
  return { kind: 'update', ref, sets, where: m[3]?.trim() };
}

function parseDelete(sql: string): MockPlan {
  const m = /^delete\s+from\s+([\s\S]+?)(?:\s+where\s+([\s\S]+))?$/i.exec(sql);
  if (!m) {
    throw new DriverError('E_VALIDATION', 'mock 驱动无法解析 DELETE 语句');
  }
  return { kind: 'delete', ref: parseTableRef(m[1]), where: m[2]?.trim() };
}

// ── 字面量解析（值编码 C-7：数字/字符串/布尔/NULL）─────────────

function parseLiteral(text: string): unknown {
  if (/^null$/i.test(text)) {
    return null;
  }
  if (/^true$/i.test(text)) {
    return true;
  }
  if (/^false$/i.test(text)) {
    return false;
  }
  if (/^-?\d+(\.\d+)?$/.test(text)) {
    return Number(text);
  }
  if (/^'[\s\S]*'$/.test(text)) {
    // '' 与 \' 转义还原
    return text
      .slice(1, -1)
      .replace(/\\'/g, "'")
      .replace(/''/g, "'");
  }
  throw new DriverError('E_VALIDATION', `mock 驱动不支持该字面量 "${text}"`);
}

function stripQuotes(text: string): string {
  return text.replace(/^[`"]/, '').replace(/[`"]$/, '');
}

/** 顶层逗号切分（引号内的逗号不切） */
function splitTopLevel(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let inString = false;
  let current = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\' && current.endsWith('\\') === false) {
        current += ch;
        continue;
      }
      if (ch === "'") {
        if (text[i + 1] === "'") {
          current += "''";
          i++;
          continue;
        }
        inString = false;
      }
      current += ch;
      continue;
    }
    if (ch === "'") {
      inString = true;
      current += ch;
      continue;
    }
    if (ch === '(') {
      depth++;
    }
    if (ch === ')') {
      depth--;
    }
    if (ch === ',' && depth === 0) {
      out.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  out.push(current);
  return out;
}

/** VALUES 后的元组序列切分：(...),(...) */
function splitTuples(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed.startsWith('(')) {
    throw new DriverError('E_VALIDATION', 'mock 驱动 INSERT：VALUES 后应为 (…)');
  }
  const out: string[] = [];
  let depth = 0;
  let inString = false;
  let current = '';
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (inString) {
      if (ch === "'") {
        if (trimmed[i + 1] === "'") {
          current += "''";
          i++;
          continue;
        }
        inString = false;
      }
      current += ch;
      continue;
    }
    if (ch === "'") {
      inString = true;
      current += ch;
      continue;
    }
    if (ch === '(') {
      depth++;
      if (depth === 1) {
        continue; // 元组开始，不含外括号
      }
    }
    if (ch === ')') {
      depth--;
      if (depth === 0) {
        out.push(current);
        current = '';
        continue;
      }
    }
    if (depth === 0 && (ch === ',' || /\s/.test(ch))) {
      continue; // 元组之间的逗号与空白
    }
    if (depth < 1) {
      throw new DriverError('E_VALIDATION', 'mock 驱动 INSERT：VALUES 中有多余内容');
    }
    current += ch;
  }
  if (out.length === 0) {
    throw new DriverError('E_VALIDATION', 'mock 驱动 INSERT：VALUES 为空');
  }
  return out;
}

// ── SELECT 执行（过滤 / 排序 / 投影，与 fetchRows 同语义）───────

function cellToString(v: unknown): string {
  return v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
}

function toNum(v: unknown): number | undefined {
  if (typeof v === 'number') {
    return v;
  }
  if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) {
    return Number(v);
  }
  return undefined;
}

function valCmp(a: unknown, b: unknown): number {
  const na = toNum(a);
  const nb = toNum(b);
  if (na !== undefined && nb !== undefined) {
    return na - nb;
  }
  const sa = cellToString(a);
  const sb = cellToString(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

export interface MockQueryTable {
  columns: ColumnMeta[];
  rows: unknown[][];
}

/** SELECT 执行：输入表的列与行快照，输出单个结果集 */
export function executeMockSelect(
  plan: Extract<MockPlan, { kind: 'select' }>,
  table: MockQueryTable,
  startMs: number,
): ResultSet {
  const { columns } = table;
  let rows = table.rows;

  if (plan.where) {
    const pred = compileWhere(plan.where, columns);
    if (pred) {
      rows = rows.filter(pred);
    }
  }
  if (plan.orderBy) {
    const terms = compileOrderBy(plan.orderBy, columns);
    rows = [...rows].sort((a, b) => {
      for (const t of terms) {
        const av = a[t.index];
        const bv = b[t.index];
        // MySQL NULL 序：ASC 最前、DESC 最后
        const aNull = av === null || av === undefined;
        const bNull = bv === null || bv === undefined;
        let cmp: number;
        if (aNull && bNull) cmp = 0;
        else if (aNull) cmp = -1;
        else if (bNull) cmp = 1;
        else cmp = valCmp(av, bv);
        if (cmp !== 0) return t.dir === 'asc' ? cmp : -cmp;
      }
      return 0;
    });
  }

  if (plan.countStar) {
    const value = rows.length;
    return {
      columns: [{ name: 'COUNT(*)', type: 'integer' }],
      rows: [[value]],
      rowCount: 1,
      executionMs: Math.max(Date.now() - startMs, 1),
    };
  }

  const outColumns =
    plan.projection === '*'
      ? columns
      : plan.projection.map((name) => {
          const c = columns.find((x) => x.name.toLowerCase() === name.toLowerCase());
          if (!c) {
            throw new DriverError('E_VALIDATION', `mock 驱动：未知列 "${name}"`);
          }
          return c;
        });

  const offset = plan.offset ?? 0;
  const limited = plan.limit !== undefined ? rows.slice(offset, offset + plan.limit) : rows.slice(offset);
  const outRows = limited.map((row) => outColumns.map((c) => row[columns.indexOf(c)]));

  return {
    columns: outColumns.map((c) => ({ name: c.name, type: c.normalizedType })),
    rows: outRows,
    rowCount: outRows.length,
    executionMs: Math.max(Date.now() - startMs, 1),
  };
}
