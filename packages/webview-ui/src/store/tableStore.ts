import type { FilterConditionPayload, ResultSetPayload, SortSpecPayload } from '@db-explorer/protocol';
import { create } from 'zustand';
import { request, RpcError } from '../rpc/client';
import type { FilterDraft } from '../lib/filterOps';
import { buildQueryParams } from '../lib/queryState';
import { PAGE_SIZES } from '../lib/queryState';

/**
 * 表格视图状态（技术选型 T-08 Zustand）。
 * M3 只读范围：分页/排序/筛选/搜索/列投影均服务端下推；ChangeSet 编辑态属 M4。
 */
export type SortDir = 'asc' | 'desc';

export interface ExportProgress {
  rows: number;
  bytes: number;
}

interface TableState {
  connId: string;
  db: string;
  obj: string;
  readOnly: boolean;
  rowEstimate?: number;

  phase: 'loading' | 'ready' | 'error';
  errorMsg: string;
  errorCode?: string;
  fetching: boolean;

  columns: Array<{ name: string; type: string }>;
  rows: unknown[][];
  primaryKey: string[];
  totalCount?: number;
  executionMs: number;
  truncated: boolean;
  /** totalCount 缺省时：当前页满页 → 可能还有下一页 */
  hasMore: boolean;

  page: number;
  pageSize: number;
  sorts: SortSpecPayload[];
  appliedDrafts: FilterDraft[];
  searchApplied: string;
  visibleColumns: string[] | null;

  exportProgress: ExportProgress | null;

  init(opts: { connId: string; db: string; obj: string; rowEstimate?: number; readOnly?: boolean }): void;
  refresh(): Promise<void>;
  setPage(page: number): Promise<void>;
  setPageSize(size: number): Promise<void>;
  toggleSort(column: string): Promise<void>;
  applyFilters(drafts: FilterDraft[]): Promise<void>;
  clearFilters(): Promise<void>;
  applySearch(text: string): Promise<void>;
  setVisibleColumns(cols: string[] | null): Promise<void>;
  runExport(format: 'csv' | 'json', scope: 'page' | 'result'): Promise<void>;
  setExportProgress(p: ExportProgress | null): void;
}

let reqSeq = 0;

export const useTableStore = create<TableState>((set, get) => ({
  connId: '',
  db: '',
  obj: '',
  readOnly: false,

  phase: 'loading',
  errorMsg: '',
  fetching: false,

  columns: [],
  rows: [],
  primaryKey: [],
  executionMs: 0,
  truncated: false,
  hasMore: false,

  page: 0,
  pageSize: PAGE_SIZES[0],
  sorts: [],
  appliedDrafts: [],
  searchApplied: '',
  visibleColumns: null,

  exportProgress: null,

  init({ connId, db, obj, rowEstimate, readOnly }) {
    set({ connId, db, obj, rowEstimate, readOnly: readOnly ?? false, page: 0 });
    void get().refresh();
  },

  async refresh() {
    const s = get();
    const seq = ++reqSeq;
    set({ fetching: true });
    try {
      const params = buildQueryParams(
        {
          connId: s.connId,
          db: s.db,
          obj: s.obj,
          page: s.page,
          pageSize: s.pageSize,
          sorts: s.sorts,
          drafts: s.appliedDrafts,
          search: s.searchApplied,
          visibleColumns: s.visibleColumns,
        },
        s.columns,
      );
      const rs = await request<ResultSetPayload>('table.fetchRows', params);
      if (seq !== reqSeq) {
        return; // 已被更新的请求取代（竞态防护）
      }
      set({
        phase: 'ready',
        errorMsg: '',
        errorCode: undefined,
        fetching: false,
        columns: rs.columns,
        rows: rs.rows,
        primaryKey: rs.primaryKey ?? [],
        totalCount: rs.totalCount,
        executionMs: rs.executionMs,
        truncated: rs.truncated ?? false,
        hasMore: rs.rows.length === s.pageSize,
      });
    } catch (err) {
      if (seq !== reqSeq) {
        return;
      }
      const rpc = err instanceof RpcError ? err : undefined;
      set({
        phase: 'error',
        fetching: false,
        errorMsg: rpc?.message ?? (err instanceof Error ? err.message : String(err)),
        errorCode: rpc?.code,
      });
    }
  },

  async setPage(page) {
    set({ page: Math.max(0, page) });
    await get().refresh();
  },

  async setPageSize(size) {
    set({ pageSize: size, page: 0 });
    await get().refresh();
  },

  async toggleSort(column) {
    const cur = get().sorts;
    const existing = cur.find((x) => x.column === column);
    const next: SortSpecPayload[] = !existing
      ? [...cur, { column, dir: 'asc' }]
      : existing.dir === 'asc'
        ? cur.map((x) => (x.column === column ? { ...x, dir: 'desc' as const } : x))
        : cur.filter((x) => x.column !== column);
    set({ sorts: next });
    await get().refresh();
  },

  async applyFilters(drafts) {
    set({ appliedDrafts: drafts, page: 0 });
    await get().refresh();
  },

  async clearFilters() {
    set({ appliedDrafts: [], page: 0 });
    await get().refresh();
  },

  async applySearch(text) {
    if (text === get().searchApplied) {
      return;
    }
    set({ searchApplied: text, page: 0 });
    await get().refresh();
  },

  async setVisibleColumns(cols) {
    set({ visibleColumns: cols });
    await get().refresh();
  },

  async runExport(format, scope) {
    const s = get();
    set({ exportProgress: { rows: 0, bytes: 0 } });
    try {
      const params = buildQueryParams(
        {
          connId: s.connId,
          db: s.db,
          obj: s.obj,
          page: s.page,
          pageSize: s.pageSize,
          sorts: s.sorts,
          drafts: s.appliedDrafts,
          search: s.searchApplied,
          visibleColumns: s.visibleColumns,
        },
        s.columns,
      );
      // scope=page 只取当前页；scope=result 由 Host 循环取尽（概要设计 5.7）
      await request<unknown>(
        'export.run',
        {
          ...params,
          format,
          scope,
          limit: s.pageSize,
          offset: s.page * s.pageSize,
        },
        0,
      );
    } finally {
      set({ exportProgress: null });
    }
  },

  setExportProgress(p) {
    set({ exportProgress: p });
  },
}));

/** 供 App 层把 FilterCondition 传给下推链路的类型别名（保持 protocol 单一来源） */
export type PushdownFilter = FilterConditionPayload;
