import type {
  ApplyChangesResult,
  EditOpPayload,
  FilterDraftPayload,
  HandshakeResult,
  PreviewChangesResult,
  PreviewItemPayload,
  ResultSetPayload,
  SortSpecPayload,
} from '@db-explorer/protocol';
import { create } from 'zustand';
import { request, RpcError } from '../rpc/client';
import { cellInputText, parseCellInput } from '../lib/editValues';
import {
  applyOverlay,
  countEdits,
  effectiveFetchColumns,
  insertRowToArray,
  mergeSetCell,
  overlayFromSnapshot,
  rowKeyOfRow,
  rowKeyString,
  valuesEqual,
  type RowColumns,
  type RowOverlay,
} from '../lib/editOverlay';
import type { FilterDraft } from '../lib/filterOps';
import { buildQueryParams } from '../lib/queryState';
import { PAGE_SIZES } from '../lib/queryState';

/**
 * 表格视图状态（技术选型 T-08 Zustand）。
 * M3 只读范围：分页/排序/筛选/搜索/列投影均服务端下推。
 * M4 编辑范围：本地覆盖层（权威副本在 Host，ADR D-06）+ 300ms debounce 同步 +
 * 预览/提交/撤销 + 冲突"保留我的修改"三步语义（交互稿 §9.2，不静默覆写）。
 */
export type SortDir = 'asc' | 'desc';

export interface ExportProgress {
  rows: number;
  bytes: number;
}

export interface ToastState {
  text: string;
  /** 常驻动作（交互稿 §9.1：失败可重试时提供动作按钮） */
  actions?: Array<{ label: string; onSelect: () => void }>;
  kind: 'info' | 'error';
}

interface RowError {
  code: string;
  message: string;
  kind?: 'insert' | 'update' | 'delete';
  tempId?: string;
  rowKey?: Record<string, unknown>;
}

interface EditingCell {
  rowIndex: number; // 相对当前页（含插入行：≥ rows.length 时为插入行）
  colIndex: number;
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
  /** 全量列（未投影）；列设置/筛选构造器/编辑基线的选项来源，不随投影缩减 */
  allColumns: Array<{ name: string; type: string }>;
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

  // ── M4 编辑态 ──
  editEnabled: boolean;
  editReason?: string;
  /** 行覆盖层：rowKeyString → 覆盖 */
  updates: Record<string, RowOverlay>;
  deletes: Record<string, true>;
  inserts: Array<{ tempId: string; values: Record<string, unknown> }>;
  /** 提交失败的错误行（evt:row.error 定位） */
  rowErrors: Record<string, RowError>;
  editing: EditingCell | null;
  /** 预览 Modal；null = 关闭 */
  previewItems: PreviewItemPayload[] | null;
  previewing: boolean;
  committing: boolean;
  toast: ToastState | null;
  /** 选中行（rowKeyString → true，仅当前页服务端行；拖拽/点击/Shift 范围） */
  selectedRows: Record<string, true>;
  /** 范围选择锚点（行号） */
  selectionAnchor: number | null;

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

  // ── M4 编辑动作 ──
  applyHandshake(hs: HandshakeResult): void;
  beginEdit(rowIndex: number, colIndex: number): void;
  confirmEdit(text: string): void;
  cancelEdit(): void;
  setCellNull(rowIndex: number, colIndex: number): void;
  setCellEmpty(rowIndex: number, colIndex: number): void;
  addInsertRow(): void;
  removeInsertRow(tempId: string): void;
  markDeleteRow(rowIndex: number): void;
  unmarkDeleteRow(rowIndex: number): void;
  /** 行选择：点击切换 / Shift+点击或拖拽范围选择（交互稿 §4.3 选中行的入口） */
  toggleSelectRow(rowIndex: number, extend: boolean): void;
  clearSelection(): void;
  markDeleteSelected(): void;
  revertRowByIndex(rowIndex: number): void;
  revertAll(): Promise<void>;
  openPreview(): Promise<void>;
  closePreview(): void;
  submitChanges(): Promise<void>;
  /** E_CONFLICT 动作：重取该行 → 校验变更列 → 基于新基线重新预览（不静默覆写） */
  retainMyChanges(): Promise<void>;
  /** E_CONFLICT 动作：放弃全部变更并刷新 */
  discardAndRefresh(): Promise<void>;
  dismissToast(): void;
  showToast(t: ToastState, autoDismissMs?: number): void;
  /** 行级编辑状态（DataGrid 视觉） */
  rowEditState(rowIndex: number): { kind: 'normal' | 'updated' | 'deleted' | 'inserted'; overlay?: RowOverlay };
  /** 生效单元格值（覆盖层叠加后） */
  effectiveValue(rowIndex: number, colIndex: number): unknown;
  editCount(): { total: number; inserts: number; updates: number; deletes: number };
}

let reqSeq = 0;
let syncSeq = 0;
let syncTimer: ReturnType<typeof setTimeout> | undefined;
let pendingOps: EditOpPayload[] = [];
let insertSeq = 0;
let toastTimer: ReturnType<typeof setTimeout> | undefined;

export const useTableStore = create<TableState>((set, get) => ({
  connId: '',
  db: '',
  obj: '',
  readOnly: false,

  phase: 'loading',
  errorMsg: '',
  fetching: false,

  columns: [],
  allColumns: [],
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

  editEnabled: false,
  updates: {},
  deletes: {},
  inserts: [],
  rowErrors: {},
  editing: null,
  previewItems: null,
  previewing: false,
  committing: false,
  toast: null,
  selectedRows: {},
  selectionAnchor: null,

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
          // 编辑态保障：投影列 ∪ 主键列（P-7）；无主键全列匹配必须取全行（D-03）
          visibleColumns: s.editEnabled
            ? (effectiveFetchColumns(s.visibleColumns, s.primaryKey, s.allColumns.length > 0 ? s.allColumns : s.columns) ?? null)
            : s.visibleColumns,
        },
        s.allColumns.length > 0 ? s.allColumns : s.columns,
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
        // 未投影的取数即全量列基线；投影时保留既有全量列，列设置才能恢复隐藏列
        allColumns: s.visibleColumns === null ? rs.columns : s.allColumns.length > 0 ? s.allColumns : rs.columns,
        rows: rs.rows,
        primaryKey: rs.primaryKey ?? [],
        totalCount: rs.totalCount,
        executionMs: rs.executionMs,
        truncated: rs.truncated ?? false,
        hasMore: rs.rows.length === s.pageSize,
        // 行数据已更替，选中集失效
        selectedRows: {},
        selectionAnchor: null,
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
    set({ page: Math.max(0, page), editing: null });
    await get().refresh();
  },

  async setPageSize(size) {
    set({ pageSize: size, page: 0, editing: null });
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
        s.allColumns.length > 0 ? s.allColumns : s.columns,
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

  // ── M4 编辑动作 ──────────────────────────────────────────

  applyHandshake(hs) {
    set({ editEnabled: hs.edit.enabled, editReason: hs.edit.reason });
    const snapshot = hs.changeSet;
    const hasSnapshot = snapshot.inserts.length + snapshot.updates.length + snapshot.deletes.length > 0;
    if (hasSnapshot) {
      const restored = overlayFromSnapshot(snapshot);
      set({ updates: restored.updates, deletes: restored.deletes, inserts: restored.inserts });
    }
    if (hs.uiState) {
      const ui = hs.uiState;
      set({
        page: ui.page,
        pageSize: ui.pageSize,
        sorts: ui.sorts,
        searchApplied: ui.search,
        appliedDrafts: ui.drafts.map((d: FilterDraftPayload) => ({ ...d })),
      });
    }
  },

  rowEditState(rowIndex) {
    const s = get();
    if (rowIndex >= s.rows.length) {
      return { kind: 'inserted' as const };
    }
    const row = s.rows[rowIndex];
    const key = rowKeyString(rowKeyOfRow(row, s.columns, s.primaryKey));
    if (s.deletes[key]) {
      return { kind: 'deleted' as const };
    }
    const overlay = s.updates[key];
    if (overlay && Object.keys(overlay.cells).length > 0) {
      return { kind: 'updated' as const, overlay };
    }
    return { kind: 'normal' as const };
  },

  effectiveValue(rowIndex, colIndex) {
    const s = get();
    const col = s.columns[colIndex];
    if (!col) {
      return null;
    }
    if (rowIndex >= s.rows.length) {
      const ins = s.inserts[rowIndex - s.rows.length];
      return ins ? (col.name in ins.values ? ins.values[col.name] : null) : null;
    }
    const editState = get().rowEditState(rowIndex);
    const row = editState.kind === 'updated' ? applyOverlay(s.rows[rowIndex], s.columns, editState.overlay) : s.rows[rowIndex];
    return row[colIndex];
  },

  editCount() {
    return countEdits(get());
  },

  beginEdit(rowIndex, colIndex) {
    const s = get();
    if (!s.editEnabled || s.committing || s.previewing) {
      return;
    }
    const col = s.columns[colIndex];
    if (!col) {
      return;
    }
    if (col.type === 'binary') {
      get().showToast({ kind: 'info', text: '二进制列只读展示（点击值可复制）' });
      return;
    }
    if (rowIndex < s.rows.length && s.primaryKey.includes(col.name)) {
      get().showToast({ kind: 'info', text: '主键列不可编辑（行定位依赖主键）' });
      return;
    }
    if (rowIndex < s.rows.length && get().rowEditState(rowIndex).kind === 'deleted') {
      return; // 已标记删除的行不再进入编辑
    }
    set({ editing: { rowIndex, colIndex } });
  },

  confirmEdit(text) {
    const s = get();
    const editing = s.editing;
    if (!editing) {
      return;
    }
    const col = s.columns[editing.colIndex];
    if (!col) {
      set({ editing: null });
      return;
    }
    const parsed = parseCellInput(text, col.type);
    if (!parsed.ok) {
      get().showToast({ kind: 'error', text: `${col.name}：${parsed.error}` });
      return; // 保持编辑态，用户修正
    }
    const value = parsed.value;
    set({ editing: null });
    if (editing.rowIndex >= s.rows.length) {
      // 插入行
      const ins = s.inserts[editing.rowIndex - s.rows.length];
      if (!ins) {
        return;
      }
      if (valuesEqual(ins.values[col.name], value)) {
        return;
      }
      set({
        inserts: s.inserts.map((x, i) => (i === editing.rowIndex - s.rows.length ? { ...x, values: { ...x.values, [col.name]: value } } : x)),
      });
      queueOp({ op: 'setInsertCell', tempId: ins.tempId, column: col.name, value });
      scheduleSync(set, get);
      return;
    }
    // 已有行
    const row = s.rows[editing.rowIndex];
    const key = rowKeyString(rowKeyOfRow(row, s.columns, s.primaryKey));
    const overlay = s.updates[key];
    const nextOverlay = mergeSetCell(overlay, rowKeyOfRow(row, s.columns, s.primaryKey), col.name, row[editing.colIndex], value);
    if (!overlay && !nextOverlay) {
      return; // 首改即原值：无变化
    }
    const updates = { ...s.updates };
    if (nextOverlay) {
      updates[key] = nextOverlay;
    } else {
      delete updates[key];
    }
    set({ updates });
    queueOp({ op: 'setCell', rowKey: rowKeyOfRow(row, s.columns, s.primaryKey), column: col.name, old: row[editing.colIndex], new: value });
    scheduleSync(set, get);
  },

  cancelEdit() {
    set({ editing: null });
  },

  setCellNull(rowIndex, colIndex) {
    confirmParsed(set, get, rowIndex, colIndex, null);
  },

  setCellEmpty(rowIndex, colIndex) {
    confirmParsed(set, get, rowIndex, colIndex, '');
  },

  addInsertRow() {
    const s = get();
    if (!s.editEnabled || s.committing) {
      return;
    }
    const tempId = `t-${Date.now()}-${++insertSeq}`;
    set({ inserts: [...s.inserts, { tempId, values: {} }] });
    queueOp({ op: 'addRow', tempId, values: {} });
    scheduleSync(set, get);
    // 聚焦第一个可编辑列
    const colIndex = s.columns.findIndex((c) => c.type !== 'binary' && !s.primaryKey.includes(c.name));
    if (colIndex >= 0) {
      set({ editing: { rowIndex: s.rows.length + s.inserts.length - 1, colIndex } });
    }
  },

  removeInsertRow(tempId) {
    const s = get();
    set({ inserts: s.inserts.filter((x) => x.tempId !== tempId) });
    queueOp({ op: 'removeRow', tempId });
    scheduleSync(set, get);
  },

  markDeleteRow(rowIndex) {
    const s = get();
    if (rowIndex >= s.rows.length || !s.editEnabled || s.committing) {
      return;
    }
    const row = s.rows[rowIndex];
    const key = rowKeyString(rowKeyOfRow(row, s.columns, s.primaryKey));
    if (s.deletes[key]) {
      return;
    }
    // 删行吞并同行的未提交 update（与 Host 合并语义一致）
    const updates = { ...s.updates };
    delete updates[key];
    set({ deletes: { ...s.deletes, [key]: true }, updates });
    queueOp({ op: 'markDelete', rowKey: rowKeyOfRow(row, s.columns, s.primaryKey) });
    scheduleSync(set, get);
  },

  unmarkDeleteRow(rowIndex) {
    const s = get();
    if (rowIndex >= s.rows.length) {
      return;
    }
    const key = rowKeyString(rowKeyOfRow(s.rows[rowIndex], s.columns, s.primaryKey));
    if (!s.deletes[key]) {
      return;
    }
    const deletes = { ...s.deletes };
    delete deletes[key];
    set({ deletes });
    queueOp({ op: 'unmarkDelete', rowKey: rowKeyOfRow(s.rows[rowIndex], s.columns, s.primaryKey) });
    scheduleSync(set, get);
  },

  toggleSelectRow(rowIndex, extend) {
    const s = get();
    if (rowIndex >= s.rows.length) {
      return; // 仅服务端行可选中（插入行经工具栏管理）
    }
    const keyOf = (idx: number): string => rowKeyString(rowKeyOfRow(s.rows[idx], s.columns, s.primaryKey));
    if (extend && s.selectionAnchor !== null) {
      const [from, to] = [Math.min(s.selectionAnchor, rowIndex), Math.max(s.selectionAnchor, rowIndex)];
      const selectedRows: Record<string, true> = {};
      for (let i = from; i <= to; i++) {
        if (i < s.rows.length) {
          selectedRows[keyOf(i)] = true;
        }
      }
      set({ selectedRows });
      return;
    }
    const key = keyOf(rowIndex);
    const selectedRows = { ...s.selectedRows };
    if (selectedRows[key]) {
      delete selectedRows[key];
    } else {
      selectedRows[key] = true;
    }
    set({ selectedRows, selectionAnchor: rowIndex });
  },

  clearSelection() {
    set({ selectedRows: {}, selectionAnchor: null });
  },

  markDeleteSelected() {
    const s = get();
    if (!s.editEnabled || s.committing) {
      return;
    }
    const keys = new Set(Object.keys(s.selectedRows));
    if (keys.size === 0) {
      return;
    }
    const keyOf = (idx: number): string => rowKeyString(rowKeyOfRow(s.rows[idx], s.columns, s.primaryKey));
    for (let i = 0; i < s.rows.length; i++) {
      if (keys.has(keyOf(i))) {
        get().markDeleteRow(i);
      }
    }
    set({ selectedRows: {}, selectionAnchor: null });
  },

  revertRowByIndex(rowIndex) {
    const s = get();
    if (rowIndex >= s.rows.length) {
      const ins = s.inserts[rowIndex - s.rows.length];
      if (ins) {
        get().removeInsertRow(ins.tempId);
      }
      return;
    }
    const row = s.rows[rowIndex];
    const key = rowKeyString(rowKeyOfRow(row, s.columns, s.primaryKey));
    const updates = { ...s.updates };
    delete updates[key];
    const deletes = { ...s.deletes };
    delete deletes[key];
    const rowErrors = { ...s.rowErrors };
    delete rowErrors[key];
    set({ updates, deletes, rowErrors });
    queueOp({ op: 'revertRow', rowKey: rowKeyOfRow(row, s.columns, s.primaryKey) });
    scheduleSync(set, get);
  },

  async revertAll() {
    const s = get();
    if (s.committing) {
      return;
    }
    set({ updates: {}, deletes: {}, inserts: [], rowErrors: {}, editing: null });
    try {
      await request('table.revertChanges', {
        connId: s.connId,
        db: s.db,
        obj: s.obj,
        target: { scope: 'all' },
      });
      get().showToast({ kind: 'info', text: '已撤销全部未提交变更' });
    } catch (err) {
      get().showToast({ kind: 'error', text: err instanceof Error ? err.message : String(err) });
    }
  },

  async openPreview() {
    const s = get();
    if (s.committing || s.previewing) {
      return;
    }
    flushPending(set, get); // 提交前把未同步的编辑立即上行
    if (get().editCount().total === 0) {
      get().showToast({ kind: 'info', text: '没有可提交的变更' });
      return;
    }
    set({ previewing: true });
    try {
      const result = await request<PreviewChangesResult>('table.previewChanges', {
        connId: s.connId,
        db: s.db,
        obj: s.obj,
      });
      set({ previewItems: result.items, previewing: false });
    } catch (err) {
      set({ previewing: false });
      get().showToast({ kind: 'error', text: err instanceof Error ? err.message : String(err) });
    }
  },

  closePreview() {
    set({ previewItems: null });
  },

  async submitChanges() {
    const s = get();
    if (s.committing || !s.previewItems) {
      return;
    }
    const total = get().editCount().total;
    set({ committing: true, previewItems: null });
    try {
      await request<ApplyChangesResult>('table.applyChanges', {
        connId: s.connId,
        db: s.db,
        obj: s.obj,
      });
      set({ committing: false, updates: {}, deletes: {}, inserts: [], rowErrors: {} });
      get().showToast({ kind: 'info', text: `已提交 ${total} 条变更` });
      await get().refresh();
    } catch (err) {
      set({ committing: false });
      // 冲突错误由 evt:row.error 定位错误行并给出动作（先于本响应到达）；
      // 仅在事件缺失（驱动未带定位信息）时在此兜底提示
      const rpc = err instanceof RpcError ? err : undefined;
      if (rpc?.code === 'E_CONFLICT') {
        if (Object.keys(get().rowErrors).length === 0) {
          get().showToast(
            {
              kind: 'error',
              text: '数据已被他人修改，请刷新后重试',
              actions: [
                { label: '刷新并放弃', onSelect: () => void get().discardAndRefresh() },
                { label: '保留我的修改', onSelect: () => void get().retainMyChanges() },
              ],
            },
            8000,
          );
        }
      } else {
        get().showToast({ kind: 'error', text: err instanceof Error ? err.message : String(err) }, 6000);
      }
    }
  },

  async retainMyChanges() {
    const s = get();
    const errorEntry = Object.entries(s.rowErrors)[0];
    if (!errorEntry) {
      return;
    }
    const [errorKey, rowError] = errorEntry;
    try {
      if (rowError.kind === 'insert' || rowError.tempId) {
        // insert 不参与乐观锁（约束错误走 E_CONSTRAINT），无可保留语义
        get().showToast({ kind: 'error', text: '新增行提交失败，请检查数据后重试或删除该行' }, 6000);
        return;
      }
      if (!rowError.rowKey) {
        get().showToast({ kind: 'error', text: rowError.message }, 6000);
        return;
      }
      // 第一步：重取该行当前值（全列基线，P-7）
      const params = buildQueryParams(
        {
          connId: s.connId,
          db: s.db,
          obj: s.obj,
          page: 0,
          pageSize: 5,
          sorts: [],
          drafts: [],
          search: '',
          visibleColumns: null, // 全列基线
        },
        s.allColumns,
      );
      const rs = await request<ResultSetPayload>('table.fetchRows', {
        ...params,
        filters: Object.entries(rowError.rowKey).map(([column, value]) => ({ column, op: 'eq' as const, value })),
      });
      // 第二步：校验变更列是否已被他人修改
      const currentRow = rs.rows[0];
      if (!currentRow) {
        if (rowError.kind === 'delete') {
          // 该行已被他人删除 → DELETE 已完成，丢弃本地删除标记
          get().showToast({ kind: 'error', text: '该行已被他人删除，本地删除标记已失效' }, 6000);
          set({ rowErrors: {} });
          return;
        }
        get().showToast(
          { kind: 'error', text: '该行已被他人删除，无法保留修改', actions: [{ label: '刷新并放弃', onSelect: () => void get().discardAndRefresh() }] },
          8000,
        );
        return;
      }
      if (rowError.kind === 'delete') {
        // DELETE 仅按主键（§8-2），行仍存在 → 删除依然有效，直接重新预览
        set({ rowErrors: {} });
        await get().openPreview();
        return;
      }
      const overlay = s.updates[errorKey];
      if (!overlay) {
        set({ rowErrors: {} });
        return;
      }
      const conflictedCols: string[] = [];
      for (const [colName, ch] of Object.entries(overlay.cells)) {
        const i = rs.columns.findIndex((c) => c.name === colName);
        const current = i >= 0 ? currentRow[i] : undefined;
        if (!valuesEqual(current, ch.old)) {
          conflictedCols.push(colName);
        }
      }
      if (conflictedCols.length > 0) {
        get().showToast(
          {
            kind: 'error',
            text: `变更列已被他人修改：${conflictedCols.join('、')}。无法自动保留，请刷新后重新编辑`,
            actions: [{ label: '刷新并放弃', onSelect: () => void get().discardAndRefresh() }],
          },
          8000,
        );
        return;
      }
      // 第三步：基于新基线重建覆盖层（保留我的新值）并重新预览
      const currentKey = rowKeyString(rowKeyOfRow(currentRow, rs.columns, s.primaryKey));
      let rebuilt: RowOverlay | undefined;
      for (const [colName, ch] of Object.entries(overlay.cells)) {
        const i = rs.columns.findIndex((c) => c.name === colName);
        const current = i >= 0 ? currentRow[i] : null;
        rebuilt = mergeSetCell(rebuilt, rowKeyOfRow(currentRow, rs.columns, s.primaryKey), colName, current, ch.new)!;
      }
      const updates = { ...get().updates };
      delete updates[errorKey];
      if (rebuilt) {
        updates[currentKey] = rebuilt;
      }
      set({ updates, rowErrors: {} });
      get().showToast({ kind: 'info', text: '已基于最新数据重新定基，请确认预览' });
      await get().openPreview();
    } catch (err) {
      get().showToast({ kind: 'error', text: err instanceof Error ? err.message : String(err) }, 6000);
    }
  },

  async discardAndRefresh() {
    const s = get();
    set({ updates: {}, deletes: {}, inserts: [], rowErrors: {}, editing: null });
    try {
      await request('table.revertChanges', {
        connId: s.connId,
        db: s.db,
        obj: s.obj,
        target: { scope: 'all' },
      });
    } catch {
      // 撤销失败不阻塞刷新（本地已清空，Host 残留可由下次提交前 preview 发现）
    }
    await get().refresh();
  },

  dismissToast() {
    set({ toast: null });
  },

  showToast(t, autoDismissMs) {
    if (toastTimer !== undefined) {
      clearTimeout(toastTimer);
    }
    set({ toast: t });
    const ms = autoDismissMs ?? (t.actions ? 8000 : 3000);
    if (t.actions && ms === 0) {
      return; // 常驻
    }
    toastTimer = setTimeout(() => {
      set({ toast: null });
    }, ms);
  },
}));

// ── 同步与辅助（模块级，避免闭包重建）────────────────────────

function queueOp(op: EditOpPayload): void {
  pendingOps.push(op);
}

function scheduleSync(
  set: (partial: Partial<TableState>) => void,
  get: () => TableState,
): void {
  if (syncTimer !== undefined) {
    clearTimeout(syncTimer);
  }
  syncTimer = setTimeout(() => {
    flushPending(set, get);
  }, 300);
}

/** 立即上行待同步编辑（300ms debounce 的 flush；概要设计 §4.5） */
function flushPending(
  set: (partial: Partial<TableState>) => void,
  get: () => TableState,
): void {
  if (syncTimer !== undefined) {
    clearTimeout(syncTimer);
    syncTimer = undefined;
  }
  const s = get();
  const ops = pendingOps;
  pendingOps = [];
  if (ops.length === 0) {
    return;
  }
  const seq = ++syncSeq;
  void request('table.editChanges', {
    connId: s.connId,
    db: s.db,
    obj: s.obj,
    ops,
    uiState: {
      page: s.page,
      pageSize: s.pageSize,
      sorts: s.sorts,
      search: s.searchApplied,
      drafts: s.appliedDrafts,
    },
  }).catch((err) => {
    if (seq !== syncSeq) {
      return;
    }
    get().showToast({ kind: 'error', text: `变更同步失败：${err instanceof Error ? err.message : String(err)}` });
    set({}); // 触发一次渲染
  });
}

function confirmParsed(
  set: (partial: Partial<TableState>) => void,
  get: () => TableState,
  rowIndex: number,
  colIndex: number,
  value: unknown,
): void {
  const s = get();
  const col = s.columns[colIndex];
  if (!col || rowIndex >= s.rows.length) {
    return;
  }
  const row = s.rows[rowIndex];
  const rowKey = rowKeyOfRow(row, s.columns, s.primaryKey);
  const key = rowKeyString(rowKey);
  const old = row[colIndex];
  const overlay = s.updates[key];
  const nextOverlay = mergeSetCell(overlay, rowKey, col.name, old, value);
  const updates = { ...s.updates };
  if (nextOverlay) {
    updates[key] = nextOverlay;
  } else {
    delete updates[key];
  }
  set({ updates });
  queueOp({ op: 'setCell', rowKey, column: col.name, old, new: value });
  scheduleSync(set, get);
}

/** 供 TablePage 渲染插入行数组 */
export function insertRowForDisplay(
  values: Record<string, unknown>,
  columns: RowColumns[],
): unknown[] {
  return insertRowToArray(values, columns);
}

/** 编辑初始文本（进入编辑态时） */
export function editingText(value: unknown): string {
  return cellInputText(value);
}
