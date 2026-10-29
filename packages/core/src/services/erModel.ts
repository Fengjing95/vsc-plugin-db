import type { ColumnMeta, KeyMeta, ObjectMeta } from '../model/meta';
import { DriverError } from '../driver/errors';
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

export type ErGraphScope =
  | { kind: 'all' }
  | { kind: 'selection'; tables: string[] }
  | /** @since v0.9.0（ER P2 / ADR D-28）：以表为中心的邻接展开（BFS 沿 FK 边无向可达，
     *  depth 1..ER_MAX_NEIGHBOR_DEPTH，缺省 1）；树 table 节点「以该表为中心展开」入口 */
  { kind: 'neighbors'; table: string; depth?: number };

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

/** FK 关系边：source = FK 所在子表，target = 被引用父表；复合 FK 按约束名合并为单边且列序对齐。
 *  onDelete/onUpdate（@since v0.9.0 / D-28）= KeyMeta 动作原文（未显式声明时 undefined 或
 *  引擎默认 'NO ACTION'，如实透传；边 tooltip 原文直显，C-17 detail 口径） */
export interface ErEdgeSummary {
  name?: string;
  sourceTable: string;
  sourceColumns: string[];
  targetTable: string;
  targetColumns: string[];
  onDelete?: string;
  onUpdate?: string;
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
/** 邻接展开度数上限（@since v0.9.0 / D-28；树入口首批固定 1 度，协议开放到 3 度） */
export const ER_MAX_NEIGHBOR_DEPTH = 3;

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
  const allTableNames = objs.filter((o) => o.kind === 'table').map((o) => o.name);

  if (scope.kind === 'neighbors') {
    return collectNeighborsGraph(src, db, scope, objs, allTableNames);
  }

  let names = allTableNames;
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
        onDelete: fk.onDelete,
        onUpdate: fk.onUpdate,
      });
    }
  });

  return { tables, edges, hiddenEdges };
}

/**
 * 邻接展开（@since v0.9.0 / ADR D-28）：以 focus 表为中心沿 FK 边无向 BFS depth 度。
 * 子表方向（谁引用我）无法只扫 focus 表得到——keys 需全表扫描（与 all 模式的 keys 扫描同量级，
 * 均为字典查询）；columns 只取邻接集（扫描面最小化）。边仅收「集合内表指出、引用目标也在集合内」
 * 的 FK；集合内表指向集合外 → hiddenEdges++（与 selection 口径一致：只统计已绘制表的出边）。
 * 自引用不参与邻接扩展（环），但 focus 表自身的自引用边照常绘制。
 */
async function collectNeighborsGraph(
  src: ErMetadataSource,
  db: string,
  scope: { kind: 'neighbors'; table: string; depth?: number },
  objs: ObjectMeta[],
  allTableNames: string[],
): Promise<RelationGraphModel> {
  const depth = Math.min(Math.max(scope.depth ?? 1, 1), ER_MAX_NEIGHBOR_DEPTH);
  const focus = scope.table;
  if (!allTableNames.includes(focus)) {
    throw new DriverError('E_NOT_FOUND', `邻接展开的表不存在：${focus}`);
  }

  const keysPerAll =
    typeof src.listKeys === 'function'
      ? await mapLimited(allTableNames, ER_SCAN_CONCURRENCY, (name) => src.listKeys!(db, name))
      : allTableNames.map(() => []);

  // 无向邻接表（FK 子表 ↔ 父表）：邻接展开是关系近似，不区分方向（父表 focus 也应收子表）；
  // 自引用不入表（环不扩展），悬挂引用（refTable 非本库表）不扩展
  const adjacency = new Map<string, Set<string>>();
  allTableNames.forEach((name, i) => {
    for (const fk of mergeForeignKeyRows(keysPerAll[i])) {
      if (fk.refTable === name || !allTableNames.includes(fk.refTable)) {
        continue;
      }
      if (!adjacency.has(name)) {
        adjacency.set(name, new Set());
      }
      adjacency.get(name)!.add(fk.refTable);
      if (!adjacency.has(fk.refTable)) {
        adjacency.set(fk.refTable, new Set());
      }
      adjacency.get(fk.refTable)!.add(name);
    }
  });

  const inSet = new Set([focus]);
  let frontier = [focus];
  for (let d = 0; d < depth; d++) {
    const next: string[] = [];
    for (const table of frontier) {
      for (const neighbor of adjacency.get(table) ?? []) {
        if (!inSet.has(neighbor)) {
          inSet.add(neighbor);
          next.push(neighbor);
        }
      }
    }
    frontier = next;
  }

  const names = allTableNames.filter((n) => inSet.has(n));
  const columnsPerTable = await mapLimited(names, ER_SCAN_CONCURRENCY, (name) => src.listColumns(db, name));
  const keysPerTable = names.map((name) => keysPerAll[allTableNames.indexOf(name)]);

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
        onDelete: fk.onDelete,
        onUpdate: fk.onUpdate,
      });
    }
  });

  return { tables, edges, hiddenEdges };
}
