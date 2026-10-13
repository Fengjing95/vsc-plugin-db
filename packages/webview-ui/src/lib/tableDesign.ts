import type { ColumnSpecPayload, DdlStatementPayload, TableSpecPayload } from '@db-explorer/protocol';

/**
 * 表结构编辑器视图推导（M8-B2，交互稿 §12）：纯函数，与 store 分离便于单测。
 * 权威语句集始终由驱动 diff（概要 §5.9）；此处的变更统计仅供预览前参考。
 */

export interface ColumnRow {
  /** 本地稳定 key（React 渲染用），不随 ordinal 重排变化 */
  rowId: string;
  col: ColumnSpecPayload;
  /** 删除标记：红底展示可撤销（§12.2） */
  deleted?: boolean;
}

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
