/**
 * 危险语句与只读判定（概要设计 §5.8 DangerGuard「Console 语句」检测点 / 交互稿 §7.4）：
 * - AST 解析（node-sql-parser）：无 WHERE 的 UPDATE/DELETE、DROP、TRUNCATE、ALTER…DROP
 * - 解析失败降级为正则匹配（宁可误报不漏报）
 * - 只读连接 fail-closed：无法证明语句是读（AST 失败且正则不可判）时一律拒绝
 * 纯函数，驱动方言经 database 参数注入。
 */
import { Parser } from 'node-sql-parser';

export interface DangerAssessment {
  dangerous: boolean;
  reasons: string[];
  /** true = AST 解析失败，结论来自正则降级（调用方可用于日志/提示） */
  parseFailed: boolean;
}

/** 支持的方言 → node-sql-parser database 参数；未知方言按 mysql 通用语法判定 */
export function toParserDatabase(dialectId?: string): string {
  switch (dialectId) {
    case 'postgresql':
    case 'postgres':
      return 'postgresql';
    case 'mssql':
      return 'transactsql';
    default:
      return 'mysql';
  }
}

// 单例 Parser（无状态，astify 可复用）
const parser = new Parser();

export function assessStatementDanger(sql: string, dialectId?: string): DangerAssessment {
  const database = toParserDatabase(dialectId);
  try {
    const ast = parser.astify(sql, { database }) as NodeAst | NodeAst[];
    const first = Array.isArray(ast) ? ast[0] : ast;
    return assessAst(first);
  } catch {
    return assessByRegex(sql);
  }
}

interface NodeAst {
  type?: string;
  where?: unknown;
  expr?: unknown;
  keyword?: string;
  table?: unknown;
}

function assessAst(ast: NodeAst | undefined): DangerAssessment {
  if (!ast || typeof ast.type !== 'string') {
    // AST 形状不可识别：按解析失败处理（宁可误报）
    return { dangerous: false, reasons: [], parseFailed: true };
  }
  const reasons: string[] = [];
  switch (ast.type) {
    case 'update':
      if (!ast.where) {
        reasons.push('UPDATE 语句没有 WHERE 条件，将影响全表行');
      }
      break;
    case 'delete':
      if (!ast.where) {
        reasons.push('DELETE 语句没有 WHERE 条件，将清空全表');
      }
      break;
    case 'drop':
      reasons.push(`DROP 语句将删除数据库对象（${describeTable(ast.table)}）`);
      break;
    case 'truncate':
      reasons.push('TRUNCATE 语句将清空全表且不可回滚');
      break;
    case 'alter': {
      if (hasDropAction(ast.expr)) {
        reasons.push('ALTER 语句包含 DROP 子句，将删除列/约束/索引');
      }
      break;
    }
    default:
      break;
  }
  return { dangerous: reasons.length > 0, reasons, parseFailed: false };
}

function hasDropAction(expr: unknown): boolean {
  const actions = Array.isArray(expr) ? expr : expr ? [expr] : [];
  return actions.some(
    (a) => typeof a === 'object' && a !== null && (a as { action?: string }).action === 'drop',
  );
}

function describeTable(table: unknown): string {
  const first = Array.isArray(table) ? table[0] : table;
  if (typeof first === 'object' && first !== null) {
    const t = first as { table?: unknown };
    return t.table ? String(t.table) : '未知对象';
  }
  return first ? String(first) : '未知对象';
}

/** 正则降级（宁可误报不漏报） */
function assessByRegex(sql: string): DangerAssessment {
  const reasons: string[] = [];
  const hasWhere = /\bwhere\b/i.test(sql);
  if (/\bupdate\b/i.test(sql) && !hasWhere) {
    reasons.push('UPDATE 语句没有 WHERE 条件（正则降级判定），将影响全表行');
  }
  if (/\bdelete\b\s+from\b/i.test(sql) && !hasWhere) {
    reasons.push('DELETE 语句没有 WHERE 条件（正则降级判定），将清空全表');
  }
  if (/\bdrop\b/i.test(sql)) {
    reasons.push('DROP 语句将删除数据库对象（正则降级判定）');
  }
  if (/\btruncate\s+table\b/i.test(sql)) {
    reasons.push('TRUNCATE 语句将清空全表且不可回滚（正则降级判定）');
  }
  if (/\balter\b/i.test(sql) && /\bdrop\b/i.test(sql)) {
    reasons.push('ALTER 语句包含 DROP 子句（正则降级判定）');
  }
  return { dangerous: reasons.length > 0, reasons, parseFailed: true };
}

/**
 * 只读连接的 fail-closed 判定（概要设计 §5.8）：能否证明语句是读。
 * AST 可解析 → 按 AST 类型；解析失败 → 正则白名单（SELECT/SHOW/DESC/EXPLAIN）。
 * 多语句文本一律不可证明为读（调用方必须先切分，此处再兜底）。
 * 返回 false 时调用方必须拒绝（E_READONLY）。
 */
export function isReadStatement(sql: string, dialectId?: string): boolean {
  const trimmed = sql.trim();
  // 除结尾分号外还含分号 = 多语句 → 不可证明为读
  const single = trimmed.replace(/;\s*$/, '');
  if (single.includes(';')) {
    return false;
  }
  const database = toParserDatabase(dialectId);
  try {
    const ast = parser.astify(single, { database }) as NodeAst | NodeAst[];
    const list = Array.isArray(ast) ? ast : [ast];
    if (list.length > 1) {
      return false;
    }
    const first = list[0];
    if (first && typeof first.type === 'string') {
      return ['select', 'show', 'describe', 'desc', 'explain'].includes(first.type);
    }
    return false;
  } catch {
    // 正则白名单：不可判定一律视为写（fail-closed，防注释混淆/方言特性绕过）
    return /^\s*\(?\s*(select|show|describe|desc|explain)\b/i.test(single);
  }
}
