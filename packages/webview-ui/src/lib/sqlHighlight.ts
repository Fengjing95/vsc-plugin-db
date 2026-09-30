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
