/**
 * 编辑覆盖层（Webview 本地镜像，权威副本在 Host——ADR D-06）：
 * 行身份一律 RowKey（主键值映射，禁止行号——概要设计 §4.5）；
 * 无主键表（allowNoPrimaryKey 全列匹配模式）以全行原值作 RowKey（D-03）。
 * 纯函数，便于单测。
 */
import type { ChangeSetSnapshot, RowKeyPayload } from '@db-explorer/protocol';

export interface RowColumns {
  name: string;
  type: string;
}

/** RowKey → 稳定字符串键（键序无关） */
export function rowKeyString(rowKey: RowKeyPayload): string {
  const keys = Object.keys(rowKey).sort();
  return JSON.stringify(keys.map((k) => [k, rowKey[k]]));
}

/** 从结果行抽取 RowKey；无主键时用全行原值（全列匹配模式） */
export function rowKeyOfRow(
  row: unknown[],
  columns: RowColumns[],
  primaryKey: string[],
): RowKeyPayload {
  if (primaryKey.length > 0) {
    const key: RowKeyPayload = {};
    for (const name of primaryKey) {
      const i = columns.findIndex((c) => c.name === name);
      if (i >= 0) {
        key[name] = row[i];
      }
    }
    return key;
  }
  const key: RowKeyPayload = {};
  columns.forEach((c, i) => {
    key[c.name] = row[i];
  });
  return key;
}

/** 单行覆盖：column → 新值（仅存与原值不同的列） */
export interface RowOverlay {
  /** 乐观锁基线：定位键 + 被改列首次原值 */
  original: RowKeyPayload;
  cells: Record<string, { old: unknown; new: unknown }>;
}

/** 行级编辑状态（渲染视觉与统计的单一来源） */
export interface RowEditState {
  kind: 'normal' | 'updated' | 'deleted' | 'inserted';
  overlay?: RowOverlay;
  insert?: { tempId: string; values: Record<string, unknown> };
}

/**
 * 合并 setCell 到覆盖层：同格反复编辑保留最初 old；
 * 新值等于最初原值 → 消项；全部消项 → 移除该行覆盖。
 * 返回 null 表示无变化（或已消空）。
 */
export function mergeSetCell(
  overlay: RowOverlay | undefined,
  rowKey: RowKeyPayload,
  column: string,
  old: unknown,
  newValue: unknown,
): RowOverlay | null {
  const base = overlay ?? { original: { ...rowKey }, cells: {} };
  const prev = base.cells[column];
  const baselineOld = prev ? prev.old : old;
  if (valuesEqual(newValue, baselineOld)) {
    if (!prev) {
      return overlay ?? null; // 首改即原值：无变化
    }
    delete base.cells[column];
    return Object.keys(base.cells).length > 0 ? base : null;
  }
  base.cells[column] = { old: baselineOld, new: newValue };
  base.original = { ...base.original, ...(column in base.original ? {} : { [column]: old }) };
  return base;
}

export function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === 'object' && typeof b === 'object' && a !== null && b !== null) {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return false;
}

/** 变更集快照 → 覆盖层（握手回放） */
export function overlayFromSnapshot(
  snapshot: ChangeSetSnapshot,
): {
  updates: Record<string, RowOverlay>;
  deletes: Record<string, true>;
  inserts: Array<{ tempId: string; values: Record<string, unknown> }>;
} {
  const updates: Record<string, RowOverlay> = {};
  for (const u of snapshot.updates) {
    updates[rowKeyString(u.rowKey)] = {
      original: u.original,
      cells: Object.fromEntries(Object.entries(u.changes).map(([col, ch]) => [col, ch])),
    };
  }
  const deletes: Record<string, true> = {};
  for (const d of snapshot.deletes) {
    deletes[rowKeyString(d.rowKey)] = true;
  }
  return { updates, deletes, inserts: snapshot.inserts.map((i) => ({ ...i })) };
}

/** 应用覆盖层到服务端行（渲染用；不改输入数组） */
export function applyOverlay(
  row: unknown[],
  columns: RowColumns[],
  overlay: RowOverlay | undefined,
): unknown[] {
  if (!overlay || Object.keys(overlay.cells).length === 0) {
    return row;
  }
  const out = [...row];
  for (const [colName, ch] of Object.entries(overlay.cells)) {
    const i = columns.findIndex((c) => c.name === colName);
    if (i >= 0) {
      out[i] = ch.new;
    }
  }
  return out;
}

/** 插入行 → 数组行（列序对齐；未填列 = null） */
export function insertRowToArray(
  values: Record<string, unknown>,
  columns: RowColumns[],
): unknown[] {
  return columns.map((c) => (c.name in values ? values[c.name] : null));
}

/** 全量变更计数 */
export function countEdits(state: {
  updates: Record<string, unknown>;
  deletes: Record<string, unknown>;
  inserts: unknown[];
}): { total: number; inserts: number; updates: number; deletes: number } {
  const updates = Object.keys(state.updates).length;
  const deletes = Object.keys(state.deletes).length;
  return {
    inserts: state.inserts.length,
    updates,
    deletes,
    total: state.inserts.length + updates + deletes,
  };
}

/** 取数列 = 投影列 ∪ 主键列（编辑定位依赖主键，P-7）；无主键时强制全列（D-03 全列匹配） */
export function effectiveFetchColumns(
  visibleColumns: string[] | null,
  primaryKey: string[],
  allColumns: RowColumns[],
): string[] | undefined {
  if (primaryKey.length === 0) {
    return undefined; // 全列匹配模式必须取全行
  }
  if (!visibleColumns) {
    return undefined;
  }
  const set = new Set([...visibleColumns, ...primaryKey]);
  return allColumns.map((c) => c.name).filter((n) => set.has(n));
}
