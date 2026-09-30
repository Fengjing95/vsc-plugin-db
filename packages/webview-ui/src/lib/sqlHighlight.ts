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
 * 将参数化 SQL 中的 ? 占位符按序回填为参数字面量（仅展示：预览语句可读性）。
 * 驱动生成的语句中 ? 只作占位符；若原文注释里含 ? 会被一并替换（展示层可接受）。
 * params 缺省/为空时原样返回；占位符多于参数时多余的 ? 保留。
 */
export function interpolateSqlParams(sql: string, params?: unknown[]): string {
  if (!params || params.length === 0) {
    return sql;
  }
  let i = 0;
  return sql.replace(/\?/g, () => (i < params.length ? sqlLiteral(params[i++]) : '?'));
}
