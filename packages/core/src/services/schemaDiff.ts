import type { ColumnMeta, IndexMeta, KeyMeta } from '../model/meta';

/**
 * 表结构对比（ADR D-29 / 交互稿 §17）：同连接两库的同名表结构 diff——只读展示，不生成 ALTER。
 * 纯函数（有单测）。输入 = 各驱动既有自省面（listColumns/listKeys/listIndexes），零新增驱动方法。
 *
 * 对齐口径（P-57① 精神）：列按名对齐；主键按列集；外键按「列+引用目标」**形状**对齐
 * （SQLite/Oracle 的约束名是引擎合成、两侧不同名不算差异）；二级索引先按名、余量按
 * （列集+唯一性）形状兜底——SQLite 具名 UNIQUE 落地为引擎合成的 sqlite_autoindex_*。
 */

export type DiffStatus = 'only-left' | 'only-right' | 'same' | 'changed';

export interface ColumnSide {
  dataType: string;
  nullable: boolean;
  defaultValue?: string;
  comment?: string;
}

export interface SchemaDiffColumn {
  name: string;
  status: DiffStatus;
  left?: ColumnSide;
  right?: ColumnSide;
  /** status=changed 时变化的字段名（dataType/nullable/defaultValue/comment） */
  changedFields?: string[];
}

export interface NamedShape {
  columns: string[];
  /** 附加标识：索引 = unique(+type)；外键 = refTable/refColumns */
  extra?: string;
}

export interface SchemaDiffNamed {
  /** 展示名（两侧名字不同时取左，无左取右） */
  name: string;
  status: DiffStatus;
  left?: NamedShape;
  right?: NamedShape;
}

export interface TableSchemaDiff {
  table: string;
  columns: SchemaDiffColumn[];
  primaryKey: SchemaDiffNamed | null;
  indexes: SchemaDiffNamed[];
  foreignKeys: SchemaDiffNamed[];
  /** 状态计数（列 + 主键 + 索引 + 外键条目级） */
  summary: { leftOnly: number; rightOnly: number; changed: number; same: number };
}

/** 单表基线（两侧同形输入） */
export interface TableBaseline {
  columns: ColumnMeta[];
  keys: KeyMeta[];
  indexes: IndexMeta[];
}

export interface TableDiffSummaryRow {
  table: string;
  status: DiffStatus;
  /** status=changed 的差异条目数（列/键/索引合计） */
  diffCount: number;
  leftRows?: number;
  rightRows?: number;
}

// ── 列 diff ─────────────────────────────────────────────

function columnSide(c: ColumnMeta): ColumnSide {
  return { dataType: c.dataType, nullable: c.nullable, defaultValue: c.defaultValue, comment: c.comment };
}

export function diffColumns(left: ColumnMeta[], right: ColumnMeta[]): SchemaDiffColumn[] {
  const byName = new Map<string, { l?: ColumnMeta; r?: ColumnMeta }>();
  for (const c of left) {
    byName.set(c.name, { l: c });
  }
  for (const c of right) {
    const e = byName.get(c.name) ?? {};
    e.r = c;
    byName.set(c.name, e);
  }
  const out: SchemaDiffColumn[] = [];
  for (const [name, e] of byName) {
    if (e.l && !e.r) {
      out.push({ name, status: 'only-left', left: columnSide(e.l) });
    } else if (!e.l && e.r) {
      out.push({ name, status: 'only-right', right: columnSide(e.r) });
    } else if (e.l && e.r) {
      const l = columnSide(e.l);
      const r = columnSide(e.r);
      const changedFields: string[] = [];
      if (l.dataType !== r.dataType) changedFields.push('dataType');
      if (l.nullable !== r.nullable) changedFields.push('nullable');
      if ((l.defaultValue ?? '') !== (r.defaultValue ?? '')) changedFields.push('defaultValue');
      if ((l.comment ?? '') !== (r.comment ?? '')) changedFields.push('comment');
      out.push(
        changedFields.length > 0
          ? { name, status: 'changed', left: l, right: r, changedFields }
          : { name, status: 'same', left: l, right: r },
      );
    }
  }
  return out;
}

// ── 形状工具（键/索引/外键对齐） ────────────────────────

function indexShape(i: IndexMeta): NamedShape {
  return { columns: [...i.columns], extra: `${i.unique ? 'unique' : 'index'}:${(i.type ?? '').toUpperCase()}` };
}

function fkShape(k: KeyMeta): NamedShape {
  // 动作入形状（§17.3：动作不同即差异；未显式声明与引擎默认 NO ACTION 形态归一——语义等价）
  const norm = (v: string | undefined): string => (v === undefined || v === 'NO ACTION' ? '' : v);
  return {
    columns: [...k.columns],
    extra: `fk:${k.refTable ?? ''}(${(k.refColumns ?? []).join(',')})|d:${norm(k.onDelete)}|u:${norm(k.onUpdate)}`,
  };
}

function uniqueShape(k: KeyMeta): NamedShape {
  return { columns: [...k.columns], extra: 'unique' };
}

/** 同名 + 形状全等 → same；同名异形 → changed；余量走形状池配对（两侧名不参与） */
function diffNamedPairs(
  left: Array<{ name: string; shape: NamedShape }>,
  right: Array<{ name: string; shape: NamedShape }>,
): SchemaDiffNamed[] {
  const out: SchemaDiffNamed[] = [];
  const rightByName = new Map(right.map((r) => [r.name, r]));
  const rightPool = new Set(right.map((r) => r.name));
  const usedRight = new Set<string>();

  for (const l of left) {
    const r = rightByName.get(l.name);
    if (r && rightPool.has(r.name)) {
      usedRight.add(r.name);
      const same = l.shape.columns.join(',') === r.shape.columns.join(',') && l.shape.extra === r.shape.extra;
      out.push({
        name: l.name,
        status: same ? 'same' : 'changed',
        left: l.shape,
        right: r.shape,
      });
    } else {
      // 形状池兜底（引擎合成名两侧不同——SQLite autoindex / Oracle FK 名）
      const match = right.find((x) => !usedRight.has(x.name) && x.shape.columns.join(',') === l.shape.columns.join(',') && x.shape.extra === l.shape.extra);
      if (match) {
        usedRight.add(match.name);
        out.push({ name: l.name, status: 'same', left: l.shape, right: match.shape });
      } else {
        out.push({ name: l.name, status: 'only-left', left: l.shape });
      }
    }
  }
  for (const r of right) {
    if (!usedRight.has(r.name)) {
      out.push({ name: r.name, status: 'only-right', right: r.shape });
    }
  }
  return out;
}

// ── 表级 diff ───────────────────────────────────────────

export function diffTable(table: string, left: TableBaseline, right: TableBaseline): TableSchemaDiff {
  const columns = diffColumns(left.columns, right.columns);

  const pkOf = (b: TableBaseline): SchemaDiffNamed | null => {
    const pkCols = b.columns.filter((c) => c.isPrimaryKey).map((c) => c.name);
    if (pkCols.length === 0) {
      return null;
    }
    const shape: NamedShape = { columns: pkCols };
    const rkCols = right.columns.filter((c) => c.isPrimaryKey).map((c) => c.name);
    if (pkCols.join(',') === rkCols.join(',')) {
      return { name: 'PRIMARY', status: 'same', left: shape, right: { columns: rkCols } };
    }
    return { name: 'PRIMARY', status: 'changed', left: shape, right: { columns: rkCols } };
  };

  const keysOf = (b: TableBaseline, kind: 'UNIQUE' | 'FK'): KeyMeta[] => b.keys.filter((k) => k.kind === kind);
  const uniquePairs = diffNamedPairs(
    keysOf(left, 'UNIQUE').map((k) => ({ name: k.name, shape: uniqueShape(k) })),
    keysOf(right, 'UNIQUE').map((k) => ({ name: k.name, shape: uniqueShape(k) })),
  );
  const fkPairs = diffNamedPairs(
    keysOf(left, 'FK').map((k) => ({ name: k.name, shape: fkShape(k) })),
    keysOf(right, 'FK').map((k) => ({ name: k.name, shape: fkShape(k) })),
  );
  const indexPairs = diffNamedPairs(
    left.indexes.filter((i) => !i.name.startsWith('sqlite_autoindex')).map((i) => ({ name: i.name, shape: indexShape(i) })),
    right.indexes.filter((i) => !i.name.startsWith('sqlite_autoindex')).map((i) => ({ name: i.name, shape: indexShape(i) })),
  );

  const named = [pkOf(left), ...uniquePairs, ...fkPairs, ...indexPairs].filter((x): x is SchemaDiffNamed => x !== null);
  const summary = { leftOnly: 0, rightOnly: 0, changed: 0, same: 0 };
  for (const item of [columns, named].flat()) {
    if (item.status === 'only-left') summary.leftOnly++;
    else if (item.status === 'only-right') summary.rightOnly++;
    else if (item.status === 'changed') summary.changed++;
    else summary.same++;
  }

  return { table, columns, primaryKey: pkOf(left), indexes: indexPairs, foreignKeys: fkPairs, summary };
}

/** 两库同名表清单（§17.2：有差异在前按差异项数降序，一致在后字典序；异名表不比对） */
export function diffTableSummaries(
  leftTables: Array<{ name: string; rowEstimate?: number }>,
  rightTables: Array<{ name: string; rowEstimate?: number }>,
  diffOf: (table: string) => TableSchemaDiff,
): TableDiffSummaryRow[] {
  const leftByName = new Map(leftTables.map((t) => [t.name, t]));
  const rightByName = new Map(rightTables.map((t) => [t.name, t]));
  const rows: TableDiffSummaryRow[] = [];
  for (const [name, l] of leftByName) {
    const r = rightByName.get(name);
    if (!r) {
      rows.push({ table: name, status: 'only-left', diffCount: 0, leftRows: l.rowEstimate });
      continue;
    }
    const d = diffOf(name);
    const diffCount = d.summary.leftOnly + d.summary.rightOnly + d.summary.changed;
    rows.push({
      table: name,
      status: diffCount > 0 ? 'changed' : 'same',
      diffCount,
      leftRows: l.rowEstimate,
      rightRows: r.rowEstimate,
    });
  }
  for (const [name, r] of rightByName) {
    if (!leftByName.has(name)) {
      rows.push({ table: name, status: 'only-right', diffCount: 0, rightRows: r.rowEstimate });
    }
  }
  rows.sort((a, b) => {
    const aDiff = a.status === 'changed' ? 1 : 0;
    const bDiff = b.status === 'changed' ? 1 : 0;
    if (aDiff !== bDiff) return bDiff - aDiff;
    if (aDiff === 1 && a.status === 'changed' && b.status === 'changed') return b.diffCount - a.diffCount;
    return a.table.localeCompare(b.table);
  });
  return rows;
}
