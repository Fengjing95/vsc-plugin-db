import type { FilterOpPayload as FilterOp } from '@db-explorer/protocol';
import type { FilterConditionPayload } from '@db-explorer/protocol';
import { t } from './i18n';

/**
 * 筛选构造器规则（交互稿 §4.4）：操作符按列类型过滤，值按类型编码
 * （值编码契约：整数/浮点 → number，DECIMAL → string 原样，其余 → 字符串）。
 */

export type ColumnType = string;

/** 行式构造器的一行（未应用态，value 为原始字符串） */
export interface FilterDraft {
  id: string;
  column: string;
  op: FilterOp;
  value: string;
  /** between 的第二值 */
  value2: string;
}

export const OPS_BY_TYPE: Record<string, FilterOp[]> = {
  string: ['eq', 'ne', 'like', 'notLike', 'in', 'notIn', 'isNull', 'isNotNull'],
  integer: ['eq', 'ne', 'gt', 'ge', 'lt', 'le', 'in', 'notIn', 'between', 'isNull', 'isNotNull'],
  float: ['eq', 'ne', 'gt', 'ge', 'lt', 'le', 'in', 'notIn', 'between', 'isNull', 'isNotNull'],
  decimal: ['eq', 'ne', 'gt', 'ge', 'lt', 'le', 'between', 'isNull', 'isNotNull'],
  boolean: ['eq', 'ne', 'isNull', 'isNotNull'],
  date: ['eq', 'ne', 'gt', 'ge', 'lt', 'le', 'between', 'isNull', 'isNotNull'],
  time: ['eq', 'ne', 'gt', 'ge', 'lt', 'le', 'between', 'isNull', 'isNotNull'],
  datetime: ['eq', 'ne', 'gt', 'ge', 'lt', 'le', 'between', 'isNull', 'isNotNull'],
  uuid: ['eq', 'ne', 'like', 'in', 'notIn', 'isNull', 'isNotNull'],
  json: ['eq', 'isNull', 'isNotNull'],
  binary: ['isNull', 'isNotNull'],
  unknown: ['eq', 'isNull', 'isNotNull'],
};

export function opsForType(type: ColumnType): FilterOp[] {
  return OPS_BY_TYPE[type] ?? OPS_BY_TYPE.unknown;
}

/** 操作符标签（i18n：调用时经 t() 解析，随注入词典语言） */
export function opLabels(): Record<FilterOp, string> {
  return {
    eq: '=',
    ne: '≠',
    gt: '>',
    ge: '≥',
    lt: '<',
    le: '≤',
    like: t('table.op.like'),
    notLike: t('table.op.notLike'),
    in: t('table.op.in'),
    notIn: t('table.op.notIn'),
    isNull: t('table.op.isNull'),
    isNotNull: t('table.op.isNotNull'),
    between: t('table.op.between'),
  };
}

/** ops 是否需要单值输入 / 双值（between）/ 多值（in） */
export function opValueShape(op: FilterOp): 'none' | 'single' | 'double' | 'multi' {
  if (op === 'isNull' || op === 'isNotNull') return 'none';
  if (op === 'between') return 'double';
  if (op === 'in' || op === 'notIn') return 'multi';
  return 'single';
}

/** 值编码：类型化输入 → 传输值（无单位字符串原样传递，驱动负责方言转换） */
export function encodeScalar(type: ColumnType, raw: string): unknown {
  if (type === 'integer' || type === 'float') {
    const n = Number(raw);
    return Number.isNaN(n) ? raw : n;
  }
  return raw;
}

/** in/notIn：换行或逗号分隔的多值 → 数组（交互稿 §4.4：支持粘贴多行） */
export function encodeMultiValues(type: ColumnType, raw: string): unknown[] {
  return raw
    .split(/[\n,，]/)
    .map((s) => s.trim())
    .filter((s) => s !== '')
    .map((s) => encodeScalar(type, s));
}

/** 行式构造器草稿 → 下推条件；非法行返回 null（值缺失） */
export function draftToCondition(
  draft: FilterDraft,
  columns: Array<{ name: string; type: string }>,
): FilterConditionPayload | null {
  const col = columns.find((c) => c.name === draft.column);
  if (!col) {
    return null;
  }
  const shape = opValueShape(draft.op);
  if (shape === 'none') {
    return { column: draft.column, op: draft.op };
  }
  if (shape === 'double') {
    const lo = encodeScalar(col.type, draft.value);
    const hi = encodeScalar(col.type, draft.value2);
    return { column: draft.column, op: draft.op, values: [lo, hi] };
  }
  if (shape === 'multi') {
    const values = encodeMultiValues(col.type, draft.value);
    return values.length > 0 ? { column: draft.column, op: draft.op, values } : null;
  }
  if (draft.value === '') {
    return null;
  }
  return { column: draft.column, op: draft.op, value: encodeScalar(col.type, draft.value) };
}

/** 草稿是否有未应用改动（应用按钮蓝点提示，交互稿 §4.4） */
export function draftsDirty(a: FilterDraft[], b: FilterDraft[]): boolean {
  const key = (list: FilterDraft[]) =>
    list.map((d) => `${d.column}|${d.op}|${d.value}|${d.value2}`).join(';;');
  return key(a) !== key(b);
}
