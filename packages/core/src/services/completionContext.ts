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
  /** 片段插入体（vscode.SnippetString 语法 $1/${1:placeholder}；仅 kind=snippet） */
  insert?: string;
}

/** 未绑定连接的文档给关键字 + 常用函数级补全（评审 P1-1；不含库/表等连接元数据） */
export const BASE_KEYWORDS = [
  'SELECT', 'FROM', 'WHERE', 'GROUP BY', 'ORDER BY', 'HAVING', 'LIMIT', 'OFFSET',
  'FETCH FIRST', 'INSERT INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE FROM', 'TRUNCATE TABLE',
  'JOIN', 'INNER JOIN', 'LEFT JOIN', 'RIGHT JOIN', 'FULL JOIN', 'CROSS JOIN', 'ON', 'USING',
  'AND', 'OR', 'NOT', 'IN', 'NOT IN', 'EXISTS', 'NOT EXISTS', 'LIKE', 'NOT LIKE', 'BETWEEN',
  'IS NULL', 'IS NOT NULL', 'DISTINCT', 'AS', 'ASC', 'DESC', 'NULLS FIRST', 'NULLS LAST',
  'UNION', 'UNION ALL', 'INTERSECT', 'EXCEPT', 'WITH', 'RECURSIVE', 'OVER', 'PARTITION BY',
  'WINDOW', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'NULL', 'TRUE', 'FALSE', 'FOR UPDATE',
  'BEGIN', 'COMMIT', 'ROLLBACK', 'CREATE TABLE', 'CREATE INDEX', 'CREATE VIEW',
  'ALTER TABLE', 'DROP TABLE', 'DROP VIEW', 'DROP INDEX', 'PRIMARY KEY', 'FOREIGN KEY',
  'UNIQUE', 'REFERENCES', 'CONSTRAINT', 'DEFAULT', 'ADD COLUMN', 'DROP COLUMN',
  'ALTER COLUMN', 'ADD CONSTRAINT', 'USE', 'SHOW', 'DESCRIBE', 'EXPLAIN', 'EXPLAIN ANALYZE',
  // 常用数据类型（DDL 场景）
  'INT', 'BIGINT', 'SMALLINT', 'DECIMAL', 'NUMERIC', 'VARCHAR', 'CHAR', 'TEXT', 'BOOLEAN',
  'DATE', 'TIME', 'TIMESTAMP', 'INTERVAL', 'JSON', 'UUID', 'BLOB',
];

/** 未绑定文档的常用 SQL 标准函数（不含方言私有函数——绑定后由驱动提供全量） */
export const BASE_FUNCTIONS = [
  'COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'COALESCE', 'NULLIF', 'GREATEST', 'LEAST', 'CAST',
  'CONCAT', 'SUBSTRING', 'UPPER', 'LOWER', 'TRIM', 'LENGTH', 'REPLACE', 'ROUND', 'ABS',
  'FLOOR', 'CEIL', 'MOD', 'NOW', 'CURRENT_DATE', 'CURRENT_TIMESTAMP', 'EXTRACT',
];

/** 未绑定文档的通用 SQL 片段（绑定后驱动片段与其合并） */
export const GENERIC_SNIPPETS: Array<{ label: string; body: string; description?: string }> = [
  {
    label: 'SELECT * FROM (模板)',
    body: 'SELECT * FROM ${1:table} LIMIT ${2:100};',
    description: '基础查询（带 LIMIT）',
  },
  {
    label: 'SELECT 列 WHERE ORDER (模板)',
    body: 'SELECT ${1:columns} FROM ${2:table} WHERE ${3:condition} ORDER BY ${4:id} DESC;',
    description: '条件查询 + 排序',
  },
  {
    label: 'JOIN (模板)',
    body: 'SELECT t.*, o.* FROM ${1:table} t JOIN ${2:other} o ON o.${3:id} = t.${4:other_id};',
    description: '内连接',
  },
  {
    label: 'COUNT (模板)',
    body: 'SELECT COUNT(*) FROM ${1:table};',
    description: '计数',
  },
  {
    label: 'UPDATE WHERE (模板)',
    body: 'UPDATE ${1:table} SET ${2:column} = ${3:value} WHERE ${4:condition};',
    description: '条件更新',
  },
  {
    label: 'DELETE WHERE (模板)',
    body: 'DELETE FROM ${1:table} WHERE ${2:condition};',
    description: '条件删除',
  },
  {
    label: 'INSERT VALUES (模板)',
    body: 'INSERT INTO ${1:table} (${2:columns}) VALUES (${3:values});',
    description: '插入行',
  },
  {
    label: 'WITH CTE (模板)',
    body: 'WITH ${1:cte} AS (\n\t${2:SELECT ...}\n)\nSELECT * FROM ${1:cte};',
    description: '公用表表达式',
  },
  {
    label: '分页 LIMIT/OFFSET (模板)',
    body: 'SELECT * FROM ${1:table} ORDER BY ${2:id} LIMIT ${3:20} OFFSET ${4:0};',
    description: '稳定分页（带 ORDER BY）',
  },
  {
    label: 'EXPLAIN ANALYZE (模板)',
    body: 'EXPLAIN ANALYZE ${1:SELECT ...};',
    description: '执行计划',
  },
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
      // 关键字殿后：FROM/WHERE/AND 等恰恰多在列位书写（SELECT … FRO|、FROM t WHE|、x=1 AN|），
      // 缺位会让最高频书写位置关键字无提示；前缀过滤保证有词缀时不污染列列表
      for (const k of source.keywords) {
        push(k, 'keyword');
      }
      break;
    case 'any':
    default:
      // 上下文优先级：表/列（元数据）→ 片段 → 函数 → 库 → 关键字殿后（extension 侧按序号生成
      // sortText，VSCode 不再按字母重排——体感上"要补的"总在前面）
      for (const t of source.tables) {
        push(t.name, 'table', t.comment);
      }
      columnsOf();
      for (const s of source.snippets ?? []) {
        out.push({ label: s.label, kind: 'snippet', detail: s.description ?? s.body, insert: s.body });
      }
      for (const f of source.functions) {
        push(f, 'function', '函数');
      }
      for (const d of source.databases) {
        push(d, 'database', '数据库');
      }
      for (const k of source.keywords) {
        push(k, 'keyword');
      }
      break;
  }
  return out;
}
