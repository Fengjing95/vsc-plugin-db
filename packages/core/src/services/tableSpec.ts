import type { ColumnMeta, ColumnSpec, IndexMeta, KeyMeta, TableSpec } from '../model/meta';

/**
 * 表结构编辑器的基线派生（概要 §5.9）：库内当前结构（listColumns 结果）→ TableSpec。
 * Host 在 ddl.load / ddl.execute 前实时调用（DDL 无乐观锁，执行必须基于最新基线）；
 * driver-conformance 的 runDdlChecks 与 extension ddlService 同源复用。
 * 纯函数，零依赖，有单测。
 */

export function specFromColumns(obj: string, metas: ColumnMeta[], tableComment?: string): TableSpec {
  return {
    name: obj,
    comment: tableComment,
    columns: metas.map((m) => ({
      name: m.name,
      dataType: m.dataType,
      nullable: m.nullable,
      isPrimaryKey: m.isPrimaryKey,
      autoIncrement: m.autoIncrement,
      defaultValue: m.defaultValue,
      comment: m.comment,
      ordinal: m.ordinal,
    })),
  };
}

/**
 * 基线全量派生（表设计器批次 B，交互稿 §12.7 红线）：列之外把 listKeys/listIndexes 回读进
 * spec——不回读则 alter 会把库内既有键/外键/索引当「用户删除」误删。keys/indexes 缺省
 * （驱动未实现）时相关字段缺省，驱动 diff 只增不删（安全方向）。
 * 两个口径：① MySQL 的 FK 在 listKeys 里按列逐行返回（同名多行）——按约束名合并；
 * ② MySQL 同名唯一键会同时出现在 listIndexes——按 UNIQUE 键名去重，索引 Tab 不双入口管理。
 */
export function specFromTable(
  obj: string,
  metas: ColumnMeta[],
  tableComment?: string,
  keys?: KeyMeta[],
  indexes?: IndexMeta[],
): TableSpec {
  const spec = specFromColumns(obj, metas, tableComment);
  if (keys) {
    spec.uniqueKeys = keys
      .filter((k) => k.kind === 'UNIQUE' && k.name)
      .map((k) => ({ name: k.name!, columns: [...k.columns] }));
    const fkByName = new Map<string, { columns: string[]; refTable: string; refColumns: string[] }>();
    for (const k of keys) {
      if (k.kind !== 'FK' || !k.name || !k.refTable) {
        continue;
      }
      const merged = fkByName.get(k.name) ?? { columns: [], refTable: k.refTable, refColumns: [] };
      merged.columns.push(...k.columns);
      merged.refColumns.push(...(k.refColumns ?? []));
      fkByName.set(k.name, merged);
    }
    spec.foreignKeys = [...fkByName.entries()].map(([name, fk]) => ({
      name,
      columns: fk.columns,
      refTable: fk.refTable,
      refColumns: fk.refColumns,
    }));
    const ukNames = new Set(spec.uniqueKeys.map((u) => u.name));
    if (indexes) {
      spec.indexes = indexes
        .filter((i) => i.name && !ukNames.has(i.name))
        .map((i) => ({ name: i.name!, columns: [...i.columns], unique: i.unique, type: i.type }));
    }
  }
  return spec;
}

// ── 键/外键/索引 diff 共用纯函数（表设计器批次 B；四个 SQL 驱动与 mock 同源复用）──────

/** 命名键条目最小形状（UniqueKeySpec/ForeignKeySpec/IndexSpec 共有字段） */
export interface NamedKeySpec {
  name?: string;
  columns: string[];
}

/** 约束/索引名自动生成（交互稿 §12.7 命名口径）：前缀_表名_序号，截断 63 字符内，与既有名去重 */
export function generateKeyName(prefix: 'uk' | 'fk' | 'idx', tableName: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const base = `${prefix}_${tableName}`;
  for (let i = 1; ; i++) {
    const name = `${base}_${i}`.slice(0, 63);
    if (!used.has(name)) {
      return name;
    }
  }
}

/** 形状指纹（不含 name）：同名异形即 DROP+ADD 重建 */
function keyShapeFingerprint(k: NamedKeySpec): string {
  const rest = { ...(k as NamedKeySpec & Record<string, unknown>) };
  delete rest.name;
  return JSON.stringify(rest);
}

/** 按名对齐 diff（交互稿 §12.7 红线）：added = spec 新有/未命名；dropped = 基线有名而 spec 移除；
 *  changed = 同名异形。基线无名条目不参与 DROP（无法安全定位，禁止生成删除语句） */
export function diffKeyEntries<T extends NamedKeySpec>(
  target: readonly T[] | undefined,
  current: readonly T[] | undefined,
): { added: T[]; dropped: T[]; changed: T[] } {
  const curByName = new Map((current ?? []).filter((x) => x.name).map((x) => [x.name!, x]));
  const tgtByName = new Map((target ?? []).filter((x) => x.name).map((x) => [x.name!, x]));
  const added = (target ?? []).filter((x) => !x.name || !curByName.has(x.name));
  const dropped = [...curByName.values()].filter((x) => !tgtByName.has(x.name!));
  const changed = (target ?? []).filter(
    (x) => x.name !== undefined && curByName.has(x.name) && keyShapeFingerprint(x) !== keyShapeFingerprint(curByName.get(x.name)!),
  );
  return { added, dropped, changed };
}

/** 外键动作子句（方言中立；未设置的动作不生成） */
export function foreignKeyActionSuffix(fk: { onDelete?: string; onUpdate?: string }): string {
  return `${fk.onDelete ? ` ON DELETE ${fk.onDelete}` : ''}${fk.onUpdate ? ` ON UPDATE ${fk.onUpdate}` : ''}`;
}

/** ColumnSpec 数组按 ordinal 排序（编辑器展示与驱动 diff 的稳定序） */
export function sortSpecColumns(columns: ColumnSpec[]): ColumnSpec[] {
  return [...columns].sort((a, b) => a.ordinal - b.ordinal);
}
