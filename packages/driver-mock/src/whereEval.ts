import { DriverError, type ColumnMeta } from '@db-explorer/core';

/**
 * 用户手写 WHERE / ORDER BY 片段的内存求值器（mock 驱动专用）。
 * 语法子集（驱动规范 §4）：比较（= <> != > >= < <=）、AND/OR/NOT、括号、
 * IS [NOT] NULL、[NOT] IN、[NOT] LIKE、BETWEEN、字符串/数字/布尔/NULL 字面量、
 * 标识符（裸名/反引号/双引号）。NULL 比较按 SQL 三值逻辑（unknown 排除该行，P-8 同源）。
 * 语法错误或未知列 → E_VALIDATION。
 */

// ── Tokenizer ────────────────────────────────────────────────

type TokKind = 'ident' | 'number' | 'string' | 'op' | 'punct';
interface Token {
  kind: TokKind;
  text: string;
  /** 大写形式（ident/op 用于关键字匹配） */
  upper: string;
  pos: number;
}

const OPERATORS = ['<>', '!=', '>=', '<=', '=', '>', '<', '(', ')', ','];

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i++;
      continue;
    }
    if (ch === '-' && src[i + 1] === '-') {
      const end = src.indexOf('\n', i);
      i = end < 0 ? src.length : end + 1;
      continue;
    }
    if (ch === "'" || ch === '"') {
      // 字符串（'' 转义）与双引号标识符
      const quote = ch;
      let text = '';
      let j = i + 1;
      while (j < src.length) {
        if (src[j] === quote) {
          if (src[j + 1] === quote && quote === "'") {
            text += quote;
            j += 2;
            continue;
          }
          break;
        }
        text += src[j];
        j++;
      }
      if (j >= src.length) {
        throw new DriverError('E_VALIDATION', `SQL 片段语法错误：第 ${i + 1} 个字符附近的字符串未闭合`);
      }
      tokens.push({ kind: quote === "'" ? 'string' : 'ident', text, upper: text.toUpperCase(), pos: i });
      i = j + 1;
      continue;
    }
    if (ch === '`') {
      const end = src.indexOf('`', i + 1);
      if (end < 0) {
        throw new DriverError('E_VALIDATION', `SQL 片段语法错误：第 ${i + 1} 个字符附近的反引号未闭合`);
      }
      const text = src.slice(i + 1, end);
      tokens.push({ kind: 'ident', text, upper: text.toUpperCase(), pos: i });
      i = end + 1;
      continue;
    }
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      let j = i;
      while (j < src.length && /[0-9.]/.test(src[j])) j++;
      const text = src.slice(i, j);
      tokens.push({ kind: 'number', text, upper: text, pos: i });
      i = j;
      continue;
    }
    if (/[A-Za-z_$\u4e00-\u9fa5]/.test(ch)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_$\u4e00-\u9fa5]/.test(src[j])) j++;
      const text = src.slice(i, j);
      tokens.push({ kind: 'ident', text, upper: text.toUpperCase(), pos: i });
      i = j;
      continue;
    }
    const two = src.slice(i, i + 2);
    const matched = OPERATORS.includes(two) ? two : OPERATORS.includes(ch) ? ch : null;
    if (matched === null) {
      throw new DriverError('E_VALIDATION', `SQL 片段语法错误：第 ${i + 1} 个字符附近有不支持的符号 "${ch}"`);
    }
    tokens.push({ kind: matched === '(' || matched === ')' || matched === ',' ? 'punct' : 'op', text: matched, upper: matched, pos: i });
    i += matched.length;
  }
  return tokens;
}

// ── 求值环境 ─────────────────────────────────────────────────

type Val = unknown;
/** 三值逻辑：true / false / null(unknown) */
type Bool3 = boolean | null;

interface EvalCtx {
  columns: ColumnMeta[];
  row: unknown[];
  /** 列名（小写）→ 下标缓存 */
  idxCache: Map<string, number>;
}

function resolveColumn(ctx: EvalCtx, name: string): number {
  const key = name.toLowerCase();
  let idx = ctx.idxCache.get(key);
  if (idx === undefined) {
    idx = ctx.columns.findIndex((c) => c.name.toLowerCase() === key);
    if (idx < 0) {
      throw new DriverError('E_VALIDATION', `SQL 片段引用了未知列 "${name}"`);
    }
    ctx.idxCache.set(key, idx);
  }
  return idx;
}

function cellToString(v: Val): string {
  return v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
}

/** 数值/字符串混合比较：数字可比数字，其余按字符串比较（与结构化筛选 valCmp 同源语义） */
function compare(a: Val, b: Val): number {
  const na = typeof a === 'number' ? a : typeof a === 'string' && a.trim() !== '' && !Number.isNaN(Number(a)) ? Number(a) : undefined;
  const nb = typeof b === 'number' ? b : typeof b === 'string' && b.trim() !== '' && !Number.isNaN(Number(b)) ? Number(b) : undefined;
  if (na !== undefined && nb !== undefined) return na === nb ? 0 : na < nb ? -1 : 1;
  const sa = cellToString(a);
  const sb = cellToString(b);
  return sa === sb ? 0 : sa < sb ? -1 : 1;
}

/** LIKE 通配符（% _）→ 正则；其余字符转义 */
function likeToRegex(pattern: string): RegExp {
  let re = '^';
  for (const ch of pattern) {
    if (ch === '%') re += '[\\s\\S]*';
    else if (ch === '_') re += '[\\s\\S]';
    else re += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(re + '$', 'i');
}

// ── Parser / Evaluator ───────────────────────────────────────

const KEYWORDS_TRUE = ['TRUE'];
const KEYWORDS_FALSE = ['FALSE'];
const KEYWORDS_NULL = ['NULL'];

class Parser {
  private pos = 0;
  constructor(
    private readonly tokens: Token[],
    private readonly ctx: EvalCtx,
  ) {}

  /** 解析并求值整段 WHERE（调用前 tokens 非空校验由调用方负责） */
  evaluate(): Bool3 {
    const v = this.parseOr();
    if (this.pos < this.tokens.length) {
      throw new DriverError('E_VALIDATION', `SQL 片段语法错误：第 ${this.tokens[this.pos].pos + 1} 个字符附近有多余内容 "${this.tokens[this.pos].text}"`);
    }
    return v;
  }

  /** 解析 ORDER BY 列表：列 [ASC|DESC], … */
  parseOrderBy(): Array<{ index: number; dir: 'asc' | 'desc' }> {
    const out: Array<{ index: number; dir: 'asc' | 'desc' }> = [];
    for (;;) {
      const t = this.peek();
      if (!t || t.kind !== 'ident') {
        throw new DriverError('E_VALIDATION', 'ORDER BY 片段语法错误：应为列名');
      }
      const index = resolveColumn(this.ctx, t.text);
      this.pos++;
      let dir: 'asc' | 'desc' = 'asc';
      const next = this.peek();
      if (next && next.kind === 'ident' && (next.upper === 'ASC' || next.upper === 'DESC')) {
        dir = next.upper === 'DESC' ? 'desc' : 'asc';
        this.pos++;
      }
      out.push({ index, dir });
      const comma = this.peek();
      if (comma && comma.kind === 'punct' && comma.text === ',') {
        this.pos++;
        continue;
      }
      break;
    }
    if (this.pos < this.tokens.length) {
      throw new DriverError('E_VALIDATION', `ORDER BY 片段语法错误：第 ${this.tokens[this.pos].pos + 1} 个字符附近有多余内容 "${this.tokens[this.pos].text}"`);
    }
    return out;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private expectPunct(text: string, what: string): void {
    const t = this.peek();
    if (!t || t.kind !== 'punct' || t.text !== text) {
      throw new DriverError('E_VALIDATION', `SQL 片段语法错误：${what} 附近应为 "${text}"`);
    }
    this.pos++;
  }

  private isKeyword(t: Token | undefined, ...words: string[]): boolean {
    return t !== undefined && t.kind === 'ident' && words.includes(t.upper);
  }

  private parseOr(): Bool3 {
    let left = this.parseAnd();
    while (this.isKeyword(this.peek(), 'OR')) {
      this.pos++;
      const right = this.parseAnd();
      left = boolOr(left, right);
    }
    return left;
  }

  private parseAnd(): Bool3 {
    let left = this.parseNot();
    while (this.isKeyword(this.peek(), 'AND')) {
      this.pos++;
      const right = this.parseNot();
      left = boolAnd(left, right);
    }
    return left;
  }

  private parseNot(): Bool3 {
    if (this.isKeyword(this.peek(), 'NOT')) {
      this.pos++;
      return boolNot(this.parseNot());
    }
    return this.parsePredicate();
  }

  private parsePredicate(): Bool3 {
    const t = this.peek();
    if (!t) {
      throw new DriverError('E_VALIDATION', 'SQL 片段语法错误：条件不完整');
    }
    // 括号 = 布尔子表达式分组（NOT (...) 经 parseNot 递归也落到这里）：
    // 直接返回其布尔结果，不再按标量谓词解析尾部
    if (t.kind === 'punct' && t.text === '(') {
      this.pos++;
      const inner = this.parseOr();
      this.expectPunct(')', '括号表达式');
      return inner;
    }
    const left = this.parseOperand();
    return this.parsePredicateTail(left);
  }

  /** 列/字面量后的谓词尾部：比较、IS [NOT] NULL、[NOT] IN/LIKE/BETWEEN */
  private parsePredicateTail(left: Val): Bool3 {
    const t = this.peek();
    if (!t) {
      throw new DriverError('E_VALIDATION', 'SQL 片段语法错误：条件不完整');
    }
    if (t.kind === 'op') {
      const cmp = t.text;
      this.pos++;
      const right = this.parseOperand();
      if (left === null || left === undefined || right === null || right === undefined) {
        return null; // 与 NULL 比较一律 unknown
      }
      const c = compare(left, right);
      switch (cmp) {
        case '=':
          return c === 0;
        case '<>':
        case '!=':
          return c !== 0;
        case '>':
          return c > 0;
        case '>=':
          return c >= 0;
        case '<':
          return c < 0;
        case '<=':
          return c <= 0;
        default:
          throw new DriverError('E_VALIDATION', `SQL 片段语法错误：不支持的比较符 "${cmp}"`);
      }
    }
    if (t.kind === 'ident') {
      if (t.upper === 'IS') {
        this.pos++;
        const neg = this.isKeyword(this.peek(), 'NOT');
        if (neg) this.pos++;
        const nul = this.peek();
        if (!nul || nul.kind !== 'ident' || nul.upper !== 'NULL') {
          throw new DriverError('E_VALIDATION', 'SQL 片段语法错误：IS 后应为 NULL');
        }
        this.pos++;
        const isNull = left === null || left === undefined;
        return neg ? !isNull : isNull;
      }
      if (t.upper === 'IN') {
        return this.parseStringPredicate(left, 'IN');
      }
      if (t.upper === 'LIKE' || t.upper === 'NOT' || t.upper === 'BETWEEN') {
        return this.parseStringPredicate(left, t.upper);
      }
    }
    throw new DriverError('E_VALIDATION', `SQL 片段语法错误：第 ${t.pos + 1} 个字符附近 "${t.text}" 不是完整的条件`);
  }

  /** IN / [NOT] IN / [NOT] LIKE / [NOT] BETWEEN；关键字（含前置 NOT）统一在此消费 */
  private parseStringPredicate(left: Val, kw: string): Bool3 {
    let negate = false;
    const head = this.peek();
    if (!head || head.kind !== 'ident' || !(head.upper === kw || head.upper === 'NOT')) {
      throw new DriverError('E_VALIDATION', `SQL 片段语法错误：应为 ${kw}`);
    }
    if (head.upper === 'NOT') {
      negate = true;
      this.pos++;
      const next = this.peek();
      if (!next || next.kind !== 'ident' || !['IN', 'LIKE', 'BETWEEN'].includes(next.upper)) {
        throw new DriverError('E_VALIDATION', 'SQL 片段语法错误：NOT 后应为 IN/LIKE/BETWEEN');
      }
      kw = next.upper;
    }
    this.pos++; // 消费关键字本身
    if (kw === 'IN') {
      this.expectPunct('(', 'IN');
      const list: Val[] = [];
      for (;;) {
        list.push(this.parseOperand());
        const comma = this.peek();
        if (comma && comma.kind === 'punct' && comma.text === ',') {
          this.pos++;
          continue;
        }
        break;
      }
      this.expectPunct(')', 'IN 列表');
      if (left === null || left === undefined) {
        return null; // 与 NULL 的 IN 比较一律 unknown
      }
      const hit = list.some((x) => x !== null && x !== undefined && compare(left, x) === 0);
      return negate ? !hit : hit;
    }
    if (kw === 'LIKE') {
      const pattern = this.parseStringLiteral('LIKE');
      if (left === null || left === undefined) return null;
      const hit = likeToRegex(pattern).test(cellToString(left));
      return negate ? !hit : hit;
    }
    // BETWEEN
    const lo = this.parseOperand();
    if (!this.isKeyword(this.peek(), 'AND')) {
      throw new DriverError('E_VALIDATION', 'SQL 片段语法错误：BETWEEN 缺少 AND');
    }
    this.pos++;
    const hi = this.parseOperand();
    if (left === null || left === undefined || lo === null || lo === undefined || hi === null || hi === undefined) {
      return null;
    }
    const hit = compare(left, lo) >= 0 && compare(left, hi) <= 0;
    return negate ? !hit : hit;
  }

  private parseStringLiteral(what: string): string {
    const t = this.peek();
    if (!t || t.kind !== 'string') {
      throw new DriverError('E_VALIDATION', `SQL 片段语法错误：${what} 后应为字符串字面量`);
    }
    this.pos++;
    return t.text;
  }

  /** 操作数：列引用或字面量 */
  private parseOperand(): Val {
    const t = this.peek();
    if (!t) {
      throw new DriverError('E_VALIDATION', 'SQL 片段语法错误：缺少操作数');
    }
    if (t.kind === 'number') {
      this.pos++;
      return Number(t.text);
    }
    if (t.kind === 'string') {
      this.pos++;
      return t.text;
    }
    if (t.kind === 'ident') {
      if (KEYWORDS_NULL.includes(t.upper)) {
        this.pos++;
        return null;
      }
      if (KEYWORDS_TRUE.includes(t.upper)) {
        this.pos++;
        return true;
      }
      if (KEYWORDS_FALSE.includes(t.upper)) {
        this.pos++;
        return false;
      }
      // 列引用（标识符；允许表名限定列？不支持，保持简单）
      this.pos++;
      return this.ctx.row[resolveColumn(this.ctx, t.text)] ?? null;
    }
    throw new DriverError('E_VALIDATION', `SQL 片段语法错误：第 ${t.pos + 1} 个字符附近 "${t.text}" 不是合法操作数`);
  }
}

function boolAnd(a: Bool3, b: Bool3): Bool3 {
  if (a === false || b === false) return false;
  if (a === null || b === null) return null;
  return true;
}

function boolOr(a: Bool3, b: Bool3): Bool3 {
  if (a === true || b === true) return true;
  if (a === null || b === null) return null;
  return false;
}

function boolNot(a: Bool3): Bool3 {
  return a === null ? null : !a;
}

/** 编译 WHERE 片段为行谓词（每次取数解析一次，行级求值） */
export function compileWhere(
  sql: string,
  columns: ColumnMeta[],
): ((row: unknown[]) => boolean) | null {
  const trimmed = sql.trim();
  if (!trimmed) return null;
  const tokens = tokenize(trimmed);
  if (tokens.length === 0) return null;
  const idxCache = new Map<string, number>();
  // 语法与列名在编译期校验一次（空行求值以暴露错误）
  new Parser(tokens, { columns, row: columns.map(() => null), idxCache }).evaluate();
  return (row: unknown[]) => {
    const v = new Parser(tokens, { columns, row, idxCache }).evaluate();
    return v === true; // unknown/false 均排除（三值逻辑）
  };
}

/** 解析 ORDER BY 片段为列下标排序规格 */
export function compileOrderBy(
  sql: string,
  columns: ColumnMeta[],
): Array<{ index: number; dir: 'asc' | 'desc' }> {
  const trimmed = sql.trim();
  if (!trimmed) return [];
  const tokens = tokenize(trimmed);
  return new Parser(tokens, { columns, row: [], idxCache: new Map<string, number>() }).parseOrderBy();
}
