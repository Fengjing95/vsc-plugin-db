/**
 * SQL 脚本切分（概要设计 5.5.2「语句切分」/ 交互稿 §7.2）：
 * 按 `;` 智能切分，忽略字符串 / 注释内的分号。纯函数、零依赖。
 *
 * 注：设计条文提到 node-sql-parser——其 AST 解析不提供语句在原文中的范围映射，
 * 无法支撑 Ctrl+Enter「定位光标所在语句」；此处用扫描器实现同一目标
 * （字符串/注释内分号不切分），node-sql-parser 仅用于危险判定（sqlDanger.ts）。
 */

export interface SqlStatement {
  /** 语句原文（去掉尾部分号与首尾空白） */
  text: string;
  /** 在脚本中的起止偏移（start 指向首个非空白字符；end 指向分号后） */
  start: number;
  end: number;
}

/** 逐字符扫描：字符串（'' 转义与反斜杠转义）、反引号/双引号标识符、-- 与 # 行注释、块注释 */
export function splitSqlStatements(sql: string): SqlStatement[] {
  const out: SqlStatement[] = [];
  let statementStart = 0;
  let i = 0;
  const n = sql.length;

  const push = (endExclusive: number): void => {
    const raw = sql.slice(statementStart, endExclusive);
    const trimmed = raw.trim();
    if (trimmed) {
      // start 对齐到首个非空白字符（光标定位精度依赖它）
      const firstNonWs = raw.search(/\S/);
      out.push({
        text: trimmed.replace(/;\s*$/, '').trim(),
        start: statementStart + (firstNonWs < 0 ? 0 : firstNonWs),
        end: endExclusive,
      });
    }
    statementStart = endExclusive;
  };

  while (i < n) {
    const ch = sql[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      i = skipQuoted(sql, i, ch);
      continue;
    }
    if (ch === '-' && sql[i + 1] === '-') {
      i = skipLineComment(sql, i + 2);
      continue;
    }
    if (ch === '#') {
      i = skipLineComment(sql, i + 1);
      continue;
    }
    if (ch === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      i = end < 0 ? n : end + 2;
      continue;
    }
    if (ch === ';') {
      push(i);
      statementStart = i + 1; // 分号本身归前一条语句的终结符，下一段从其后开始
      i++;
      continue;
    }
    i++;
  }
  push(n);
  return out;
}

/** 返回引号闭合后的下一个位置；未闭合时返回文本末尾（宁可整段不切，不在字符串中间断开） */
function skipQuoted(sql: string, start: number, quote: string): number {
  let i = start + 1;
  while (i < sql.length) {
    const ch = sql[i];
    if (ch === '\\' && quote !== '`') {
      i += 2; // MySQL 方言反斜杠转义
      continue;
    }
    if (ch === quote) {
      if (sql[i + 1] === quote && quote !== '`') {
        i += 2; // '' / "" 转义
        continue;
      }
      return i + 1;
    }
    i++;
  }
  return sql.length;
}

function skipLineComment(sql: string, start: number): number {
  const end = sql.indexOf('\n', start);
  return end < 0 ? sql.length : end + 1;
}

/** 语句首个关键字（跳过注释与左括号，如 (SELECT …)） */
export function leadingKeyword(text: string): string {
  const stripped = text
    .replace(/--[^\n]*/g, ' ')
    .replace(/#[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .trim();
  const m = /^(\(|\s)*([A-Za-z]+)/.exec(stripped);
  return m ? m[2].toUpperCase() : '';
}

/**
 * 会话状态语句识别（P1-5）：`SET @x` / `SET NAMES/SESSION/TRANSACTION` / `USE` /
 * 临时表 DDL。此类语句的效果绑定在执行连接的会话上；supportsMultiStatement=false
 * 的驱动逐条执行会用不同池连接，会话状态对后续语句不可见 → 调用方应合并发送或拒绝。
 */
export function isSessionStateStatement(text: string): boolean {
  const kw = leadingKeyword(text);
  if (kw === 'USE') {
    return true;
  }
  if (kw === 'SET') {
    return true; // SET @x / SET NAMES / SET SESSION / SET TRANSACTION …（保守：一律视为会话状态）
  }
  if (kw === 'CREATE' || kw === 'DROP') {
    return /\bTEMPORARY\b|\bTEMP\b/i.test(strippedKeywordBody(text));
  }
  return false;
}

/** DDL 识别（概要设计 7.5：Console 执行 DDL 后失效该库元数据缓存并联动树刷新） */
export function isDdlStatement(text: string): boolean {
  return ['CREATE', 'ALTER', 'DROP', 'TRUNCATE', 'RENAME', 'COMMENT'].includes(leadingKeyword(text));
}

function strippedKeywordBody(text: string): string {
  return text.replace(/--[^\n]*/g, ' ').replace(/#[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ');
}

/**
 * 定位光标所在语句（交互稿 §7.2 Ctrl+Enter）：offset 落在语句 [start, end) 内即命中；
 * 落在语句之间的空白处时取其前一条（光标停在分号后应执行刚写完的语句）。
 * offset 在第一条语句之前时返回第一条。
 */
export function statementAtOffset(statements: SqlStatement[], offset: number): SqlStatement | undefined {
  if (statements.length === 0) {
    return undefined;
  }
  for (const stmt of statements) {
    if (offset >= stmt.start && offset < stmt.end) {
      return stmt;
    }
  }
  const before = statements.filter((s) => s.end <= offset);
  return before.length > 0 ? before[before.length - 1] : statements[0];
}
