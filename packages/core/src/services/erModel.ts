import type { ColumnMeta, KeyMeta, ObjectMeta } from '../model/meta';
import { mergeForeignKeyRows } from './tableSpec';

/**
 * ER 关系收集层（M8-ER，概要 §5.11 / ADR D-22）：给定库 → 表/列/FK 关系模型。
 * 只消费既有自省面（listObjects/listColumns/listKeys，零新增驱动方法）；不触数据行
 * （C-9 无涉）。纯服务、无 vscode 依赖——driver-conformance 直传 IConnection（结构兼容），
 * extension erService 传 MetadataCache 包装的加载器（TTL 与失效联动，概要 §7.5）。
 *
 * 口径：只入 kind='table'（视图/collection 不入图）；边方向 source = FK 子表（多端）、
 * target = 被引用父表（一端）；端点不全（selection 裁剪 / 引用目标缺失）的边不绘制、
 * 计入 hiddenEdges；单表元数据读取失败整体失败（不半出图，交互稿 §13.7）。
 */

/** 最小元数据源（IConnection 的自省子集；erService 可注入缓存包装实现） */
export interface ErMetadataSource {
  listObjects(db: string): Promise<ObjectMeta[]>;
  listColumns(db: string, obj: string): Promise<ColumnMeta[]>;
  listKeys?(db: string, obj: string): Promise<KeyMeta[]>;
}

export type ErGraphScope = { kind: 'all' } | { kind: 'selection'; tables: string[] };

export interface ErColumnSummary {
  name: string;
  dataType: string;
  isPrimaryKey: boolean;
}

export interface ErTableSummary {
  name: string;
  comment?: string;
  columns: ErColumnSummary[];
  /** 列超上限（ER_MAX_COLUMNS）被截断的数量 */
  columnsTruncated: number;
}

/** FK 关系边：source = FK 所在子表，target = 被引用父表；复合 FK 按约束名合并为单边且列序对齐 */
export interface ErEdgeSummary {
  name?: string;
  sourceTable: string;
  sourceColumns: string[];
  targetTable: string;
  targetColumns: string[];
}

export interface RelationGraphModel {
  tables: ErTableSummary[];
  edges: ErEdgeSummary[];
  /** 端点不全未绘制的 FK 边数（selection 裁剪 / 引用目标不在表集） */
  hiddenEdges: number;
}

/** 单表列显式上限（协议 schema 同口径；超出截断计数，不整体失败） */
export const ER_MAX_COLUMNS = 256;
/** 库级全量出图表数硬上限（超限由打开引导转选择表模式；erService 防御性双检） */
export const ER_MAX_TABLES = 300;
/** 元数据扫描并发上界（百表库瞬时风暴防护） */
export const ER_SCAN_CONCURRENCY = 8;

/** 有界并发 map（结果保持输入序；任一失败整体失败） */
async function mapLimited<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) {
        return;
      }
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

export async function collectRelationGraph(
  src: ErMetadataSource,
  db: string,
  scope: ErGraphScope = { kind: 'all' },
): Promise<RelationGraphModel> {
  const objs: ObjectMeta[] = await src.listObjects(db);
  let names = objs.filter((o) => o.kind === 'table').map((o) => o.name);
  if (scope.kind === 'selection') {
    // 选择表模式：按 listObjects 序保留（视图内表清单同序），范围内过滤
    const included = new Set(scope.tables);
    names = names.filter((n) => included.has(n));
  }
  const inSet = new Set(names);

  const columnsPerTable = await mapLimited(names, ER_SCAN_CONCURRENCY, (name) => src.listColumns(db, name));
  const keysPerTable =
    typeof src.listKeys === 'function'
      ? await mapLimited(names, ER_SCAN_CONCURRENCY, (name) => src.listKeys!(db, name))
      : names.map(() => []);

  const tables = names.map((name, i) => {
    const meta: ObjectMeta | undefined = objs.find((o) => o.name === name);
    const cols = [...columnsPerTable[i]].sort((a, b) => a.ordinal - b.ordinal);
    return {
      name,
      comment: meta?.comment,
      columns: cols.slice(0, ER_MAX_COLUMNS).map((c) => ({
        name: c.name,
        dataType: c.dataType,
        isPrimaryKey: c.isPrimaryKey,
      })),
      columnsTruncated: Math.max(0, cols.length - ER_MAX_COLUMNS),
    };
  });

  const edges: ErEdgeSummary[] = [];
  let hiddenEdges = 0;
  names.forEach((name, i) => {
    for (const fk of mergeForeignKeyRows(keysPerTable[i])) {
      if (!inSet.has(fk.refTable)) {
        hiddenEdges++;
        continue;
      }
      edges.push({
        name: fk.name,
        sourceTable: name,
        sourceColumns: fk.columns,
        targetTable: fk.refTable,
        targetColumns: fk.refColumns,
      });
    }
  });

  return { tables, edges, hiddenEdges };
}
