import type { ColumnMeta, ColumnSpec, TableSpec } from '../model/meta';

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

/** ColumnSpec 数组按 ordinal 排序（编辑器展示与驱动 diff 的稳定序） */
export function sortSpecColumns(columns: ColumnSpec[]): ColumnSpec[] {
  return [...columns].sort((a, b) => a.ordinal - b.ordinal);
}
