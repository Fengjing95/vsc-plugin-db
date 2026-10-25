/**
 * 查询状态 → RPC 参数（table.fetchRows / export.run 共用形状）。
 * 纯函数：筛选/排序/投影/分页的编码与页码计算集中在此，便于单测。
 */
import { t } from './i18n';

export interface QueryUiState {
  connId: string;
  db: string;
  obj: string;
  page: number;
  pageSize: number;
  /** 用户手写 WHERE / ORDER BY 片段（v0.1.3 取代筛选构造器，空串 = 无；
   *  排序只走 orderBySql 一路——与列头排序双向联动后不再下发结构化 sorts） */
  where: string;
  orderBy: string;
  search: string;
  /** null = 全部列（不下发投影） */
  visibleColumns: string[] | null;
  /** 分页模型（M7 cursor 透传）：'cursor' 下发游标并省略 offset；'none'/缺省按 offset 处理 */
  pagination?: 'offset' | 'cursor' | 'none';
  /** 当前页取数游标（cursor 模式；cursors[0] = undefined 首页） */
  cursor?: string;
}

export const PAGE_SIZES = [50, 100, 200, 500] as const;

/** fetchRows/export 共用的取数形状；offset 模式 offset = page × pageSize；
 *  cursor 模式（M7 透传）下发游标且省略 offset（两者互斥，驱动以游标为唯一位置语义） */
export function buildQueryParams(state: QueryUiState) {
  const cursorMode = state.pagination === 'cursor';
  return {
    connId: state.connId,
    db: state.db,
    obj: state.obj,
    limit: state.pageSize,
    offset: cursorMode ? undefined : state.page * state.pageSize,
    cursor: cursorMode && state.cursor ? state.cursor : undefined,
    columns: state.visibleColumns ?? undefined,
    search: state.search !== '' ? state.search : undefined,
    whereSql: state.where !== '' ? state.where : undefined,
    orderBySql: state.orderBy !== '' ? state.orderBy : undefined,
  };
}

/**
 * 游标栈推进（cursor 分页，M7）：cursors[page] = 该页取数游标（cursors[0] = undefined 首页）。
 * 成功取到 nextCursor 时记录为下一页游标；返回新数组（不可变更新，zustand set 用）。
 * 仅在「连续翻页」路径推进——跳过式 page 变更由调用方 clamp 到已探明深度（maxExploredPage）。
 */
export function updateCursorStack(
  cursors: ReadonlyArray<string | undefined>,
  page: number,
  nextCursor?: string,
): Array<string | undefined> {
  const next = cursors.slice(0, Math.max(cursors.length, page + 2));
  while (next.length < page + 2) {
    next.push(undefined);
  }
  next[page + 1] = nextCursor;
  return next;
}

/** 已探明的最大页深度（cursor 模式页码跳转/跳至的可达上界）：cursors.length - 1 */
export function maxExploredPage(cursors: ReadonlyArray<string | undefined>): number {
  return Math.max(0, cursors.length - 1);
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
    return t('table.page.rangeOfTotal', [from, to, opts.totalCount]);
  }
  if (opts.rowEstimate !== undefined && opts.rowEstimate > 0) {
    return t('table.page.rangeEstimate', [from, to, formatEstimate(opts.rowEstimate)]);
  }
  return t('table.page.range', [from, to]);
}
