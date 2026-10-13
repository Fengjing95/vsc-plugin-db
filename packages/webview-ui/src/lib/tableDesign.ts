import type {
  ColumnSpecPayload,
  DdlStatementPayload,
  ForeignKeySpecPayload,
  IndexSpecPayload,
  TableSpecPayload,
  UniqueKeySpecPayload,
} from '@db-explorer/protocol';

/**
 * 表结构编辑器视图推导（M8-B2，交互稿 §12；键/外键/索引为表设计器批次 B §12.4~12.7）：
 * 纯函数，与 store 分离便于单测。权威语句集始终由驱动 diff（概要 §5.9）；
 * 此处的变更统计仅供预览前参考。
 */

export interface ColumnRow {
  /** 本地稳定 key（React 渲染用），不随 ordinal 重排变化 */
  rowId: string;
  col: ColumnSpecPayload;
  /** 删除标记：红底展示可撤销（§12.2） */
  deleted?: boolean;
}

/** 键/外键/索引编辑行（本地稳定 key + 删除标记，与列行同构） */
export interface KeyRow<T> {
  rowId: string;
  spec: T;
  deleted?: boolean;
}

export type UkRow = KeyRow<UniqueKeySpecPayload>;
export type FkRow = KeyRow<ForeignKeySpecPayload>;
export type IdxRow = KeyRow<IndexSpecPayload>;

export interface SpecDiffSummary {
  added: number;
  removed: number;
  modified: number;
}

/** 变更统计：基线（ddl.load 返回）与编辑中列集对比（按列名对齐；仅 alter 态调用） */
export function diffSpecSummary(baseline: TableSpecPayload | null, rows: ColumnRow[]): SpecDiffSummary {
  if (!baseline) {
    return { added: 0, removed: 0, modified: 0 };
  }
  const baseByName = new Map(baseline.columns.map((c) => [c.name, c]));
  const rowNames = new Set(rows.filter((r) => !r.deleted).map((r) => r.col.name));
  let added = 0;
  let modified = 0;
  for (const r of rows) {
    if (r.deleted) {
      continue;
    }
    const base = baseByName.get(r.col.name);
    if (!base) {
      added++;
    } else if (columnDiffers(base, r.col)) {
      modified++;
    }
  }
  const removed = baseline.columns.filter((c) => !rowNames.has(c.name)).length;
  return { added, removed, modified };
}

function columnDiffers(a: ColumnSpecPayload, b: ColumnSpecPayload): boolean {
  return (
    a.dataType.trim() !== b.dataType.trim() ||
    a.nullable !== b.nullable ||
    Boolean(a.autoIncrement) !== Boolean(b.autoIncrement) ||
    (a.defaultValue ?? '') !== (b.defaultValue ?? '') ||
    (a.comment ?? '') !== (b.comment ?? '')
  );
}

/** 变更统计文案（§12.2）：全 0 返回 undefined（状态行不显示） */
export function diffSummaryText(summary: SpecDiffSummary): string | undefined {
  const parts: string[] = [];
  if (summary.added > 0) {
    parts.push(`新增 ${summary.added} 列`);
  }
  if (summary.removed > 0) {
    parts.push(`删除 ${summary.removed} 列`);
  }
  if (summary.modified > 0) {
    parts.push(`修改 ${summary.modified} 列`);
  }
  return parts.length > 0 ? parts.join(' · ') : undefined;
}

/** 预览汇总：destructive 语句数（红条提示用） */
export function destructiveCount(statements: DdlStatementPayload[]): number {
  return statements.filter((s) => s.destructive).length;
}

/** 前端即时校验（§12.3：字符合法性由驱动 fail-closed 兜底，此处仅提示）：
 *  错误按字段归属拆分——列名错误与类型错误分别渲染在各自输入框正下方（错误位预留，行高恒定） */
export function columnNameError(row: ColumnRow, allRows: ColumnRow[]): string | undefined {
  if (row.deleted) {
    return undefined;
  }
  const name = row.col.name.trim();
  if (!name) {
    return '列名不能为空';
  }
  const sameName = allRows.filter((r) => !r.deleted && r.rowId !== row.rowId && r.col.name.trim() === name);
  if (sameName.length > 0) {
    return `列名 "${name}" 重复`;
  }
  return undefined;
}

export function columnTypeError(row: ColumnRow): string | undefined {
  if (row.deleted) {
    return undefined;
  }
  if (!row.col.dataType.trim()) {
    return '类型不能为空';
  }
  return undefined;
}

/** 行级聚合（状态行汇总用）：列名错误优先于类型错误 */
export function columnRowError(row: ColumnRow, allRows: ColumnRow[]): string | undefined {
  return columnNameError(row, allRows) ?? columnTypeError(row);
}

/** 表级校验：返回错误文案（执行按钮禁用条件）；undefined = 可执行 */
export function tableSpecError(kind: 'create' | 'alter', tableName: string, rows: ColumnRow[]): string | undefined {
  const activeRows = rows.filter((r) => !r.deleted);
  if (!tableName.trim()) {
    return '表名不能为空';
  }
  if (activeRows.length === 0) {
    return '表至少需要一列';
  }
  for (const r of activeRows) {
    const err = columnRowError(r, rows);
    if (err) {
      return err;
    }
  }
  if (kind === 'create' && activeRows.every((r) => !r.col.isPrimaryKey)) {
    // 建表无主键：允许（无主键表只读编辑是 D-03 的事），但提示一次
    return undefined;
  }
  return undefined;
}

/** 下一 ordinal：现有最大值 +1（删除行占用的 ordinal 不复用冲突） */
export function nextOrdinal(rows: ColumnRow[]): number {
  return rows.reduce((max, r) => Math.max(max, r.col.ordinal), 0) + 1;
}

// ── 键 / 外键 / 索引（表设计器批次 B，§12.4~12.7）─────────────────────────

/** 唯一键行校验：列 ≥1、名称行内唯一（名称允许空 = 驱动自动生成） */
export function ukRowError(row: UkRow, allRows: UkRow[]): string | undefined {
  if (row.deleted) {
    return undefined;
  }
  if (row.spec.columns.length === 0) {
    return '唯一键至少需要一列';
  }
  const name = (row.spec.name ?? '').trim();
  if (name && allRows.some((r) => !r.deleted && r.rowId !== row.rowId && (r.spec.name ?? '').trim() === name)) {
    return `唯一键名 "${name}" 重复`;
  }
  return undefined;
}

/** 外键行校验：本表列 ≥1、引用表/引用列非空、引用列数与本地一致、名称行内唯一 */
export function fkRowError(row: FkRow, allRows: FkRow[]): string | undefined {
  if (row.deleted) {
    return undefined;
  }
  if (row.spec.columns.length === 0) {
    return '外键至少需要一列';
  }
  if (!row.spec.refTable.trim()) {
    return '引用表不能为空';
  }
  if (row.spec.refColumns.length === 0) {
    return '引用列不能为空';
  }
  if (row.spec.refColumns.length !== row.spec.columns.length) {
    return '引用列数须与本地列数一致';
  }
  const name = (row.spec.name ?? '').trim();
  if (name && allRows.some((r) => !r.deleted && r.rowId !== row.rowId && (r.spec.name ?? '').trim() === name)) {
    return `外键名 "${name}" 重复`;
  }
  return undefined;
}

/** 索引行校验：列 ≥1、名称行内唯一 */
export function idxRowError(row: IdxRow, allRows: IdxRow[]): string | undefined {
  if (row.deleted) {
    return undefined;
  }
  if (row.spec.columns.length === 0) {
    return '索引至少需要一列';
  }
  const name = (row.spec.name ?? '').trim();
  if (name && allRows.some((r) => !r.deleted && r.rowId !== row.rowId && (r.spec.name ?? '').trim() === name)) {
    return `索引名 "${name}" 重复`;
  }
  return undefined;
}

/** 命名键条目 diff 计数（变更统计用；按名对齐——未命名视为新增；形状变化计为修改） */
function keyDiffCounts<T extends { name?: string }>(baseline: readonly T[] | undefined, current: readonly T[]): { added: number; removed: number; modified: number } {
  const baseByName = new Map((baseline ?? []).filter((x) => x.name).map((x) => [x.name!, x]));
  let added = 0;
  let modified = 0;
  for (const x of current) {
    if (!x.name || !baseByName.has(x.name)) {
      added++;
    } else if (JSON.stringify({ ...x, name: undefined }) !== JSON.stringify({ ...baseByName.get(x.name)!, name: undefined })) {
      modified++;
    }
  }
  const curNames = new Set(current.filter((x) => x.name).map((x) => x.name!));
  const removed = (baseline ?? []).filter((x) => x.name && !curNames.has(x.name)).length;
  return { added, removed, modified };
}

/** 变更统计扩展（§12.7）：列 + 唯一键/外键/索引合并计数；全 0 返回 undefined */
export function diffSummaryTextExtended(
  baseline: TableSpecPayload | null,
  rows: ColumnRow[],
  ukRows: UkRow[],
  fkRows: FkRow[],
  idxRows: IdxRow[],
): string | undefined {
  const parts: string[] = [];
  const colSummary = baseline ? diffSpecSummary(baseline, rows) : undefined;
  if (colSummary) {
    const t = diffSummaryText(colSummary);
    if (t) {
      parts.push(t);
    }
  }
  if (baseline) {
    const groups: Array<[string, ReturnType<typeof keyDiffCounts>]> = [
      ['唯一键', keyDiffCounts(baseline.uniqueKeys, ukRows.filter((r) => !r.deleted).map((r) => r.spec))],
      ['外键', keyDiffCounts(baseline.foreignKeys, fkRows.filter((r) => !r.deleted).map((r) => r.spec))],
      ['索引', keyDiffCounts(baseline.indexes, idxRows.filter((r) => !r.deleted).map((r) => r.spec))],
    ];
    for (const [label, c] of groups) {
      if (c.added) parts.push(`新增 ${c.added} ${label}`);
      if (c.removed) parts.push(`删除 ${c.removed} ${label}`);
      if (c.modified) parts.push(`修改 ${c.modified} ${label}`);
    }
  }
  return parts.length > 0 ? parts.join(' · ') : undefined;
}
