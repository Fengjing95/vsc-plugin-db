import './prismShim';
import 'prismjs/components/prism-sql';
import Prism from 'prismjs';

/**
 * SQL → 语法高亮 HTML（变更预览语句、DDL 等所有 SQL 展示统一入口）。
 * Prism.highlight 自带 HTML 转义（< 与 & 实体化），输出含 <span class="token …">；
 * 颜色由 styles/legacy.css 的 .sql-hl 规则映射语义 token（C-12 零硬编码）。
 * 返回值仅用于 dangerouslySetInnerHTML，不得插入属性位置。
 */
export function highlightSql(code: string): string {
  const grammar = (Prism.languages as unknown as Record<string, Prism.Grammar | undefined>).sql;
  if (!grammar) {
    // 防御：语言组件未挂载时退回转义纯文本，不抛错
    return code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  return Prism.highlight(code, grammar, 'sql');
}

/** 参数 → SQL 字面量（仅展示用；按 C-7 解码后的值还原为可读字面量） */
function sqlLiteral(v: unknown): string {
  if (v === null || v === undefined) {
    return 'NULL';
  }
  switch (typeof v) {
    case 'number':
      return Number.isFinite(v) ? String(v) : 'NULL';
    case 'bigint':
      return String(v);
    case 'boolean':
      return v ? 'TRUE' : 'FALSE';
    case 'string':
      return `'${v.replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;
    default: {
      // 对象/数组（C-7 JSON=已解析对象）：序列化为带引号字面量
      try {
        return `'${JSON.stringify(v).replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;
      } catch {
        return `'${String(v)}'`;
      }
    }
  }
}

/**
 * 将参数化 SQL 中的占位符回填为参数字面量（仅展示：预览语句可读性）。
 * 支持 ?（mysql/sqlite 顺序占位）与按序号取参的 $N（pg）/ :N（oracle）/ @pN（mssql）。
 * 字符串字面量内不替换（避免改写值内容，如 '比率 2:1'）；序号占位符按编号取参，
 * 越界保留原样（如 oracle RETURNING INTO 的 out 绑定占位符超出 params 长度）。
 * params 缺省/为空时原样返回。
 */
export function interpolateSqlParams(sql: string, params?: unknown[]): string {
  if (!params || params.length === 0) {
    return sql;
  }
  // 按字符串字面量切段：字面量段原样保留，非字面量段做占位符替换。
  // 单趟合并替换（? 与序号占位符同一遍）——两段式链式替换会把上一步产出的字面量
  // （如 '{"a":1}' 中的 :1）再当占位符改写
  const literalRe = /'(?:[^']|'')*'/g;
  let questionSeq = 0;
  const substitute = (segment: string): string =>
    segment.replace(/\?|(?:\$(\d+)|@p(\d+)|:(\d+))\b/g, (whole, d1, d2, d3) => {
      if (whole === '?') {
        return questionSeq < params.length ? sqlLiteral(params[questionSeq++]) : '?';
      }
      const n = Number([d1, d2, d3].find((v) => v !== undefined));
      return n >= 1 && n <= params.length ? sqlLiteral(params[n - 1]) : whole;
    });
  let last = 0;
  let out = '';
  for (const m of sql.matchAll(literalRe)) {
    out += substitute(sql.slice(last, m.index)) + m[0];
    last = m.index + m[0].length;
  }
  out += substitute(sql.slice(last));
  return out;
}
