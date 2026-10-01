import type { SortSpecPayload } from '@db-explorer/protocol';

/**
 * ORDER BY 片段 ↔ 结构化排序列表互转（交互稿 §4.4 v0.1.3 双向联动）。
 * "规范"片段 = 仅由 `列引用 [ASC|DESC]` 逗号分隔组成（无括号/函数/表达式），
 * 且列引用能解析到实际列名——只有规范片段才可与列头排序双向联动。
 * 纯函数，供 store（联动）与表头指示器共用。
 */

export interface OrderTerm {
  /** 解析到的实际列名 */
  name: string;
  dir: 'asc' | 'desc';
}

export interface ParsedOrder {
  canonical: boolean;
  terms: OrderTerm[];
}

const PLAIN_NAME = /^[A-Za-z0-9_$\u4e00-\u9fa5]+$/;

/** 剥掉引号（反引号/双引号）后的列引用文本 */
function unquoteRef(ref: string): string {
  const t = ref.trim();
  if ((t.startsWith('`') && t.endsWith('`') && t.length >= 2) || (t.startsWith('"') && t.endsWith('"') && t.length >= 2)) {
    return t.slice(1, -1);
  }
  return t;
}

/**
 * 解析 ORDER BY 片段。
 * canonical=false 的情形：空格内的括号/函数调用/无法解析到实际列的引用等——
 * 此类片段仍会原样下发执行，只是不参与列头联动、不显示指示器。
 */
export function parseOrderTerms(text: string, columnNames: string[]): ParsedOrder {
  const trimmed = text.trim();
  if (trimmed === '') {
    return { canonical: true, terms: [] };
  }
  if (/[()]/.test(trimmed)) {
    return { canonical: false, terms: [] };
  }
  const lowerMap = new Map(columnNames.map((n) => [n.toLowerCase(), n]));
  const terms: OrderTerm[] = [];
  for (const rawTerm of trimmed.split(',')) {
    const term = rawTerm.trim();
    if (term === '') {
      return { canonical: false, terms: [] };
    }
    const m = /^(`[^`]+`|"[^"]+"|[A-Za-z0-9_$\u4e00-\u9fa5]+)(?:\s+(asc|desc))?$/i.exec(term);
    if (!m) {
      return { canonical: false, terms: [] };
    }
    const name = lowerMap.get(unquoteRef(m[1]).toLowerCase());
    if (name === undefined) {
      return { canonical: false, terms: [] };
    }
    terms.push({ name, dir: (m[2]?.toLowerCase() as 'asc' | 'desc') ?? 'asc' });
  }
  return { canonical: true, terms };
}

/** 结构化列表 → 规范片段文本（含非普通字符的列名用双引号引用） */
export function termsToText(terms: Array<{ name: string; dir: 'asc' | 'desc' }>): string {
  return terms
    .map(({ name, dir }) => (PLAIN_NAME.test(name) ? name : `"${name}"`) + (dir === 'desc' ? ' DESC' : ''))
    .join(', ');
}

/** 三态切换：无 → asc → desc → 移除（其余项保留） */
export function toggleTerm(
  terms: OrderTerm[],
  column: string,
): OrderTerm[] {
  const idx = terms.findIndex((t) => t.name === column);
  if (idx < 0) {
    return [...terms, { name: column, dir: 'asc' }];
  }
  if (terms[idx].dir === 'asc') {
    return terms.map((t, i) => (i === idx ? { ...t, dir: 'desc' as const } : t));
  }
  return terms.filter((_, i) => i !== idx);
}

/** 列头点击的完整动作：解析 → 三态 → 新片段文本；自由表达式时返回 null（联动停用） */
export function headerSortToText(
  text: string,
  column: string,
  columnNames: string[],
): string | null {
  const parsed = parseOrderTerms(text, columnNames);
  if (!parsed.canonical) {
    return null;
  }
  return termsToText(toggleTerm(parsed.terms, column));
}

/** 解析结果 → 表头指示器/下推参数用的规格（canonical=false 时为空） */
export function orderTermsToSpecs(text: string, columnNames: string[]): SortSpecPayload[] {
  const parsed = parseOrderTerms(text, columnNames);
  if (!parsed.canonical) {
    return [];
  }
  return parsed.terms.map((t) => ({ column: t.name, dir: t.dir }));
}
