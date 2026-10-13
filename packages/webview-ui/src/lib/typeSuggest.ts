import type { DataTypeOptionPayload } from '@db-explorer/protocol';

/**
 * 表结构编辑器列 Tab「类型建议下拉」纯层（表设计器批次 A，交互稿 §12.3）：
 * 过滤 / 回填值 / 回填后光标位。建议不是白名单——过滤无命中或词表为空时输入框照常手输。
 */

/** 按输入子串大小写不敏感过滤（对 value 匹配）；输入为空给全量 */
export function filterDataTypeOptions(items: DataTypeOptionPayload[], input: string): DataTypeOptionPayload[] {
  const kw = input.trim().toLowerCase();
  if (kw === '') {
    return items;
  }
  return items.filter((t) => t.value.toLowerCase().includes(kw));
}

/** 回填值：带形参项用模板（VARCHAR() / DECIMAL(,)），无参项用 value 原文 */
export function fillValueOf(item: DataTypeOptionPayload): string {
  return item.template ?? item.value;
}

/** 回填后光标位：形参位优先（模板内第一个逗号），否则落在右括号前（形参缺省形态），无括号落末尾 */
export function caretPosFor(fill: string): number {
  const comma = fill.indexOf(',');
  if (comma > -1) {
    return comma;
  }
  if (fill.endsWith(')')) {
    return fill.length - 1;
  }
  return fill.length;
}

/** 高亮移动：↑/↓ 循环（count ≤ 0 时原样返回） */
export function movedHighlight(current: number, delta: number, count: number): number {
  if (count <= 0) {
    return current;
  }
  const next = (current + delta) % count;
  return next < 0 ? next + count : next;
}
