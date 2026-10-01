import type { SortSpecPayload } from '@db-explorer/protocol';

/**
 * 查询状态 → RPC 参数（table.fetchRows / export.run 共用形状）。
 * 纯函数：筛选/排序/投影/分页的编码与页码计算集中在此，便于单测。
 */

export interface QueryUiState {
  connId: string;
  db: string;
  obj: string;
  page: number;
  pageSize: number;
  sorts: SortSpecPayload[];
  /** 用户手写 WHERE / ORDER BY 片段（v0.1.3 取代筛选构造器，空串 = 无） */
  where: string;
  orderBy: string;
  search: string;
  /** null = 全部列（不下发投影） */
  visibleColumns: string[] | null;
}

export const PAGE_SIZES = [50, 100, 200, 500] as const;

/** fetchRows/export 共用的取数形状；offset = page × pageSize */
export function buildQueryParams(state: QueryUiState) {
  return {
    connId: state.connId,
    db: state.db,
    obj: state.obj,
    limit: state.pageSize,
    offset: state.page * state.pageSize,
    columns: state.visibleColumns ?? undefined,
    sorts: state.sorts.length > 0 ? state.sorts : undefined,
    search: state.search !== '' ? state.search : undefined,
    whereSql: state.where !== '' ? state.where : undefined,
    orderBySql: state.orderBy !== '' ? state.orderBy : undefined,
  };
}

/** 列头点击的三态循环：无 → asc → desc → 无（保留其他列的排序，多列下推） */
export function nextSort(
  current: SortSpecPayload[],
  column: string,
): SortSpecPayload[] {
  const existing = current.find((s) => s.column === column);
  if (!existing) {
    return [...current, { column, dir: 'asc' }];
  }
  if (existing.dir === 'asc') {
    return current.map((s) => (s.column === column ? { ...s, dir: 'desc' as const } : s));
  }
  return current.filter((s) => s.column !== column);
}

/** “约 N 行”：≥1 万显示 k 单位（交互稿 §4.7：“约”字必须带，由调用方拼接） */
export function formatEstimate(n: number): string {
  if (n >= 10000) {
    return `${(n / 1000).toFixed(n % 1000 === 0 ? 0 : 1)}k`;
  }
  return String(n);
}

/** 分页栏左侧文案；totalCount 缺省时附行估算 */
export function paginationLabel(opts: {
  page: number;
  pageSize: number;
  loadedRows: number;
  totalCount?: number;
  rowEstimate?: number;
}): string {
  const from = opts.page * opts.pageSize + 1;
  const to = opts.page * opts.pageSize + opts.loadedRows;
  if (opts.totalCount !== undefined) {
    return `第 ${from}-${to} 行 / 共 ${opts.totalCount} 行`;
  }
  if (opts.rowEstimate !== undefined && opts.rowEstimate > 0) {
    return `第 ${from}-${to} 行 · 约 ${formatEstimate(opts.rowEstimate)} 行`;
  }
  return `第 ${from}-${to} 行`;
}
