/**
 * Console 补全上下文解析（概要设计 5.5.3 / D-04 单库范围）：
 * 光标上下文 → 补全类别（表 / 列 / 库 / 混合），纯函数零 vscode 依赖。
 * 上下文感知规则（概要 5.5.3 表）：FROM/JOIN 后 → 表名；SELECT/WHERE 后 → 列名+函数；
 * `别名.` 后 → 该别名对应表的所有列；USE 后 → 库名。
 */
import type { CompletionSource } from '../model/rows';

export type CompletionKind = 'table' | 'column' | 'database' | 'any';

export interface CompletionContext {
  kind: CompletionKind;
  /** kind=column 时优先补全该表的列（FROM 表 / 别名解析结果）；缺省 = 不限表 */
  table?: string;
}

export interface CompletionItemDescriptor {
  label: string;
  kind: 'keyword' | 'function' | 'database' | 'table' | 'column' | 'snippet';
  /** 展示细节（表注释 / 列所属表） */
  detail?: string;
}

/** 未绑定连接的文档仅给关键字级补全（评审 P1-1） */
export const BASE_KEYWORDS = [
  'SELECT', 'FROM', 'WHERE', 'GROUP BY', 'ORDER BY', 'HAVING', 'LIMIT', 'OFFSET',
  'INSERT INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE FROM', 'JOIN', 'LEFT JOIN',
  'INNER JOIN', 'ON', 'AND', 'OR', 'NOT', 'NULL', 'IS NULL', 'IS NOT NULL',
  'IN', 'NOT IN', 'LIKE', 'BETWEEN', 'DISTINCT', 'AS', 'ASC', 'DESC', 'UNION',
  'COUNT(*)', 'CREATE TABLE', 'ALTER TABLE', 'DROP TABLE', 'TRUNCATE TABLE', 'EXPLAIN',
];

const IDENT_CHARS = /[A-Za-z0-9_$\u4e00-\u9fa5]/;

/** FROM/JOIN 后可能出现的保留字——不能当作别名 */
const RESERVED_AFTER_TABLE =
  /^(on|where|group|order|having|limit|offset|union|left|right|inner|outer|cross|full|join|as|set|values|select|and|or|not|use)$/i;

export function resolveCompletionContext(fullText: string, offset: number): CompletionContext {
  const before = fullText.slice(0, offset);
  // 光标前的词前缀（补全触发词；不含引号内文本——引号内不触发也无妨）
  let wordStart = offset;
  while (wordStart > 0 && IDENT_CHARS.test(before[wordStart - 1] ?? '')) {
    wordStart--;
  }

  // `x.` 限定：先解析别名/表名 → 该表的列；解析不到退回 any
  if (wordStart > 0 && before[wordStart - 1] === '.') {
    const owner = precedingIdentifier(before, wordStart - 1);
    if (owner) {
      // 别名可能定义在光标之后（SELECT u. FROM users u）：在整个语句范围内解析
      const stmt = statementAround(fullText, offset);
      const table = resolveTableName(stmt.before + stmt.after, owner);
      if (table) {
        return { kind: 'column', table };
      }
    }
    return { kind: 'any' };
  }

  // 尾部归一化：符号（* , ( 等）视作分隔，关键字只按词序判定
  const rawTail = before.slice(0, wordStart);
  const tailNorm = rawTail.replace(/[^\w\s]+/g, ' ');

  // USE 后 → 库名
  if (/\bUSE\s+$/i.test(tailNorm)) {
    return { kind: 'database' };
  }

  // FROM / JOIN / INTO / UPDATE 等后 → 表名（或库名）
  if (/\b(FROM|JOIN|INTO|UPDATE|TABLE|DESCRIBE|EXPLAIN)\s+$/i.test(tailNorm)) {
    return { kind: 'table' };
  }

  // SELECT / WHERE / 运算上下文后 → 列名 + 函数
  if (
    /\b(SELECT|WHERE|HAVING|ON|AND|OR|NOT|BY|IN|LIKE|BETWEEN|SET|WHEN|THEN|ELSE|DISTINCT|TOP)\s+$/i.test(tailNorm) ||
    /[,(\s]$/i.test(rawTail)
  ) {
    // 语句上下文里的 FROM 表（SELECT 列表补全时 FROM 可能在光标之后）
    const stmt = statementAround(fullText, offset);
    const fromTable = firstFromTable(stmt.before + stmt.after);
    return { kind: 'column', table: fromTable ?? undefined };
  }

  // 关键字后紧跟标识符的普通位置：按当前语句上下文给列，兜底 any
  if (tailNorm.trim() === '' || /\b(SELECT|FROM|WHERE)\b/.test(tailNorm)) {
    return { kind: 'any' };
  }
  const stmt = statementAround(fullText, offset);
  if (/\bFROM\b/i.test(stmt.before)) {
    return { kind: 'column', table: firstFromTable(stmt.before) ?? undefined };
  }
  return { kind: 'any' };
}

function precedingIdentifier(text: string, endIndex: number): string {
  const end = endIndex;
  let start = end;
  while (start > 0 && IDENT_CHARS.test(text[start - 1] ?? '')) {
    start--;
  }
  return text.slice(start, end);
}

/** 别名 → 表名 映射（来自 FROM/JOIN 子句；含 `t AS a` 与 `t a` 两种形式） */
function aliasMapOf(text: string): Map<string, string> {
  const map = new Map<string, string>();
  const re = /\b(?:from|join)\s+([`"#[]?[\w$]+[`"\]]?)(?:\s+(?:as\s+)?([`"#[]?[\w$]+[`"\]]?))?/gi;
  for (const m of text.matchAll(re)) {
    const table = unquoteIdent(m[1]);
    const aliasRaw = m[2];
    if (!table) {
      continue;
    }
    if (aliasRaw) {
      const alias = unquoteIdent(aliasRaw);
      if (alias && !RESERVED_AFTER_TABLE.test(alias)) {
        map.set(alias.toLowerCase(), table);
        continue;
      }
    }
    // 表名自引用：`users.` 补 users 的列
    map.set(table.toLowerCase(), table);
  }
  return map;
}

function resolveTableName(textBeforeCursor: string, owner: string): string | undefined {
  const map = aliasMapOf(textBeforeCursor);
  return map.get(owner.toLowerCase());
}

function unquoteIdent(s: string | undefined): string | undefined {
  if (!s) {
    return undefined;
  }
  return s.replace(/^[`"#[]/, '').replace(/[`"#\]]$/, '');
}

/** 光标所在语句（分号界定；补全不需要精确切分，粗界即可） */
function statementAround(text: string, offset: number): { before: string; after: string } {
  const prev = text.lastIndexOf(';', Math.max(0, offset - 1));
  const next = text.indexOf(';', offset);
  return {
    before: text.slice(prev < 0 ? 0 : prev + 1, offset),
    after: text.slice(offset, next < 0 ? text.length : next),
  };
}

/** 语句中第一个 FROM 表（供 SELECT 列表 / WHERE 的列上下文） */
function firstFromTable(stmtText: string): string | undefined {
  const m = /\bFROM\s+([`"#[]?[\w$]+[`"\]]?)/i.exec(stmtText);
  const name = m ? unquoteIdent(m[1]) : undefined;
  return name && !RESERVED_AFTER_TABLE.test(name) ? name : undefined;
}

/** 补全数据 → 描述符列表（vscode CompletionItem 的映射在 extension 侧完成） */
export function buildCompletionDescriptors(source: CompletionSource, ctx: CompletionContext): CompletionItemDescriptor[] {
  const out: CompletionItemDescriptor[] = [];
  const push = (label: string, kind: CompletionItemDescriptor['kind'], detail?: string): void => {
    if (label) {
      out.push({ label, kind, detail });
    }
  };

  const columnsOf = (table?: string): void => {
    const cols = source.columns.filter((c) => (table ? c.table.toLowerCase() === table.toLowerCase() : true));
    const seen = new Set<string>();
    for (const c of cols) {
      const key = `${c.table}.${c.name}`;
      if (!seen.has(key)) {
        seen.add(key);
        push(c.name, 'column', c.comment ?? c.table);
      }
    }
  };

  switch (ctx.kind) {
    case 'table':
      for (const t of source.tables) {
        push(t.name, 'table', t.comment);
      }
      for (const d of source.databases) {
        push(d, 'database', '数据库');
      }
      break;
    case 'database':
      for (const d of source.databases) {
        push(d, 'database', '数据库');
      }
      break;
    case 'column':
      columnsOf(ctx.table);
      for (const f of source.functions) {
        push(f, 'function', '函数');
      }
      break;
    case 'any':
    default:
      for (const k of source.keywords) {
        push(k, 'keyword');
      }
      for (const f of source.functions) {
        push(f, 'function', '函数');
      }
      for (const t of source.tables) {
        push(t.name, 'table', t.comment);
      }
      columnsOf();
      for (const d of source.databases) {
        push(d, 'database', '数据库');
      }
      for (const s of source.snippets ?? []) {
        out.push({ label: s.label, kind: 'snippet', detail: s.description ?? s.body });
      }
      break;
  }
  return out;
}
