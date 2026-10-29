import type {
  ApplyChangesResult,
  EditOpPayload,
  ExportFormat,
  GetDdlResult,
  HandshakeResult,
  PreviewChangesResult,
  PreviewItemPayload,
  ResultSetPayload,
  SortSpecPayload,
} from '@db-explorer/protocol';
import { create } from 'zustand';
import { maxExploredPage, updateCursorStack } from '../lib/queryState';
import { request, RpcError } from '../rpc/client';
import { errorCodeToMessage } from '../lib/errors';
import { t } from '../lib/i18n';
import { viewerKindFor, type ViewerKind } from '../lib/cellViewer';
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
import { headerSortToText, orderTermsToSpecs, parseOrderTerms } from '../lib/orderTerms';
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
  /** M8 后台化：本视图追踪的导出任务 id（evt:export.progress/done 按 id 过滤） */
  exportId: string;
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
  /** 驱动能力子集（握手下行，概要 §5.1.3）：UI 按能力降级渲染，不感知数据库类型 */
  capabilities: {
    supportsSQL: boolean;
    supportsDdl: boolean;
    pagination?: 'offset' | 'cursor' | 'none';
    lazyCell?: boolean;
  };
  /** cursor 分页（M7 透传）：每页取数游标（cursors[0] = undefined 首页；仅 cursor 模式使用） */
  cursors: Array<string | undefined>;

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
  /** ADR D-30：被 cellMaxChars 截断的单元格坐标（[rowIndex, colIndex]，行内值 = 预览前缀）；
   *  随每次取数整体更替；编辑/复制前经 resolveFullCell 取整值回写 */
  truncatedCells: Array<[number, number]>;
  /** totalCount 缺省时：当前页满页 → 可能还有下一页 */
  hasMore: boolean;

  page: number;
  pageSize: number;
  /** appliedOrderBy 的规范解析镜像（表头指示器；自由表达式时为空） */
  sorts: SortSpecPayload[];
  /** appliedOrderBy 为自由表达式（不可与列头联动） */
  orderFreeform: boolean;
  /** 用户手写 WHERE / ORDER BY 片段（已应用值；v0.1.3 取代筛选构造器 drafts） */
  appliedWhere: string;
  appliedOrderBy: string;
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
  /** DDL 查看 Modal；null = 关闭 */
  ddl: string | null;
  ddlLoading: boolean;
  /** 单元格查看器（交互稿 §4.6）；value = 查看器当前值（lazyCell 驱动经 RPC 覆盖行内值）；
   *  partial = 整值尚未到手（lazyCell 拉取失败时保持 true，编辑保存/另存禁用防前缀覆写） */
  viewer: { rowIndex: number; colIndex: number; kind: ViewerKind; value: unknown; loading: boolean; partial: boolean } | null;
  toast: ToastState | null;
  /** 选中行（rowKeyString → true，仅当前页服务端行；拖拽/点击/Shift 范围） */
  selectedRows: Record<string, true>;
  /** 范围选择锚点（行号） */
  selectionAnchor: number | null;

  init(opts: { connId: string; db: string; obj: string; rowEstimate?: number; readOnly?: boolean }): void;
  refresh(): Promise<void>;
  setPage(page: number): Promise<void>;
  setPageSize(size: number): Promise<void>;
  /** 列头排序（双向联动）：解析/三态切换 ORDER BY 输入框内容并立即应用；
   *  输入框为自由表达式时仅提示、不覆盖 */
  toggleHeaderSort(column: string): void;
  /** 应用 WHERE/ORDER BY 自由条件（空串 = 无），回到第 1 页 */
  applyQuery(where: string, orderBy: string): Promise<void>;
  /** 依 allColumns 解析 appliedOrderBy → sorts 镜像 + orderFreeform */
  syncOrderMirror(): void;
  clearFilters(): Promise<void>;
  applySearch(text: string): Promise<void>;
  setVisibleColumns(cols: string[] | null): Promise<void>;
  runExport(format: ExportFormat, scope: 'page' | 'result'): Promise<void>;
  cancelExport(): Promise<void>;
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
  /** 行选择（交互稿 §4.3 v0.1.2）：replace=点击任意单元格选中该行（覆盖已有选择）；
   *  extend=拖拽/Shift+点击自锚点范围选择；toggle=Ctrl+点击增删 */
  selectRow(rowIndex: number, mode: 'replace' | 'extend' | 'toggle'): void;
  clearSelection(): void;
  markDeleteSelected(): void;
  revertRowByIndex(rowIndex: number): void;
  /** 撤销选中行的未提交变更（工具栏 ↺；无选中或选中行均无变更时 no-op，插入行不可选中、由行内菜单管理） */
  revertSelected(): void;
  revertAll(): Promise<void>;
  openPreview(): Promise<void>;
  closePreview(): void;
  submitChanges(): Promise<void>;
  /** 查看当前表 DDL（驱动未实现时报 E_UNSUPPORTED） */
  openDdl(): Promise<void>;
  closeDdl(): void;
  /** 单元格查看器（交互稿 §4.6）：binary/json 类型或超长文本的整值查看与编辑 */
  openCellViewer(rowIndex: number, colIndex: number): void;
  /** 截断单元格取整值（ADR D-30）：编辑/复制前保证乐观锁与「真实值」基线。
   *  knownFull 传入时跳过 RPC 直接回写（查看器已持整值路径）；
   *  非截断单元格原样返回行内值；lazyCell 取值失败抛错由调用方提示 */
  resolveFullCell(rowIndex: number, colIndex: number, knownFull?: unknown): Promise<unknown>;
  /** 批量取整值：选区内的截断单元格逐格 cell.fetch 回写行内值（复制为多种格式前调用） */
  resolveRowsFull(rowIndexes: number[]): Promise<void>;
  closeCellViewer(): void;
  /** 查看器保存写回 ChangeSet（文本/JSON；JSON 合法性由 Modal 校验后传入已解析值） */
  applyCellValue(rowIndex: number, colIndex: number, value: unknown): void;
  /** 二进制查看器「另存为文件」（sys.saveFile；取消静默） */
  saveViewerBinary(): Promise<void>;
  /** E_CONFLICT 动作：重取该行 → 校验变更列 → 基于新基线重新预览（不静默覆写） */
  retainMyChanges(): Promise<void>;
  /** E_CONFLICT 动作：放弃全部变更并刷新 */
  discardAndRefresh(): Promise<void>;
  dismissToast(): void;
  showToast(toast: ToastState, autoDismissMs?: number): void;
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
  capabilities: { supportsSQL: true, supportsDdl: false },

  phase: 'loading',
  errorMsg: '',
  fetching: false,

  columns: [],
  allColumns: [],
  rows: [],
  primaryKey: [],
  executionMs: 0,
  truncated: false,
  truncatedCells: [],
  hasMore: false,

  page: 0,
  pageSize: PAGE_SIZES[0],
  sorts: [],
  orderFreeform: false,
  appliedWhere: '',
  appliedOrderBy: '',
  searchApplied: '',
  visibleColumns: null,

  exportProgress: null,

  cursors: [undefined],

  editEnabled: false,
  updates: {},
  deletes: {},
  inserts: [],
  rowErrors: {},
  editing: null,
  previewItems: null,
  previewing: false,
  committing: false,
  ddl: null,
  ddlLoading: false,
  viewer: null,
  toast: null,
  selectedRows: {},
  selectionAnchor: null,

  init({ connId, db, obj, rowEstimate, readOnly }) {
    set({ connId, db, obj, rowEstimate, readOnly: readOnly ?? false, page: 0, cursors: [undefined], viewer: null });
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
          where: s.appliedWhere,
          orderBy: s.appliedOrderBy,
          search: s.searchApplied,
          // M7 cursor 透传：cursor 模式下发当前页游标（buildQueryParams 同时省略 offset）
          pagination: s.capabilities.pagination,
          cursor: s.cursors[s.page],
          // 编辑态保障：投影列 ∪ 主键列（P-7）；无主键全列匹配必须取全行（D-03）
          visibleColumns: s.editEnabled
            ? (effectiveFetchColumns(s.visibleColumns, s.primaryKey, s.allColumns.length > 0 ? s.allColumns : s.columns) ?? null)
            : s.visibleColumns,
        },
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
        truncatedCells: rs.truncatedCells ?? [],
        // cursor 模式：尽头以 nextCursor 缺失判定（比满页启发式精确）
        hasMore: s.capabilities.pagination === 'cursor' ? rs.nextCursor !== undefined : rs.rows.length === s.pageSize,
        cursors:
          s.capabilities.pagination === 'cursor'
            ? updateCursorStack(s.cursors, s.page, rs.nextCursor)
            : s.cursors,
        // 行数据已更替，选中集失效
        selectedRows: {},
        selectionAnchor: null,
      });
      get().syncOrderMirror();
    } catch (err) {
      if (seq !== reqSeq) {
        return;
      }
      const rpc = err instanceof RpcError ? err : undefined;
      const message = rpc?.message ?? (err instanceof Error ? err.message : String(err));
      const hadData = get().phase === 'ready';
      set({
        // 已有数据时不整页报错（保留旧数据，如手写条件语法错误），只通知
        phase: hadData ? 'ready' : 'error',
        fetching: false,
        errorMsg: message,
        errorCode: rpc?.code,
      });
      if (hadData) {
        // 展示驱动返回的具体信息（如 SQL 片段语法错误位置）；全局弹窗由 Host 层负责
        get().showToast({ kind: 'error', text: message }, 6000);
      }
    }
  },

  async setPage(page) {
    // cursor 模式：只允许回到已探明页（游标栈深度），跳过式跳转会退回首取语义
    const maxPage =
      get().capabilities.pagination === 'cursor' ? maxExploredPage(get().cursors) : Number.MAX_SAFE_INTEGER;
    set({ page: Math.min(Math.max(0, page), maxPage), editing: null });
    await get().refresh();
  },

  async setPageSize(size) {
    set({ pageSize: size, page: 0, cursors: [undefined], editing: null });
    await get().refresh();
  },

  async applyQuery(where, orderBy) {
    set({ appliedWhere: where, appliedOrderBy: orderBy, page: 0, cursors: [undefined] });
    get().syncOrderMirror();
    await get().refresh();
  },

  toggleHeaderSort(column) {
    const s = get();
    if (s.orderFreeform) {
      // 自由表达式不参与联动：提示而非静默覆盖用户输入
      get().showToast({ kind: 'info', text: t('table.toast.orderFreeform') });
      return;
    }
    const names = (s.allColumns.length > 0 ? s.allColumns : s.columns).map((c) => c.name);
    const nextText = headerSortToText(s.appliedOrderBy, column, names);
    if (nextText === null) {
      return;
    }
    set({ appliedOrderBy: nextText });
    get().syncOrderMirror();
    void get().refresh();
  },

  syncOrderMirror() {
    const s = get();
    const names = (s.allColumns.length > 0 ? s.allColumns : s.columns).map((c) => c.name);
    const parsed = parseOrderTerms(s.appliedOrderBy, names);
    set({
      sorts: orderTermsToSpecs(s.appliedOrderBy, names),
      orderFreeform: !parsed.canonical && s.appliedOrderBy.trim() !== '',
    });
  },

  async clearFilters() {
    set({ appliedWhere: '', appliedOrderBy: '', page: 0, cursors: [undefined] });
    await get().refresh();
  },

  async applySearch(text) {
    if (text === get().searchApplied) {
      return;
    }
    set({ searchApplied: text, page: 0, cursors: [undefined] });
    await get().refresh();
  },

  async setVisibleColumns(cols) {
    set({ visibleColumns: cols });
    await get().refresh();
  },

  async runExport(format, scope) {
    const s = get();
    set({ exportProgress: null });
    try {
      const params = buildQueryParams(
        {
          connId: s.connId,
          db: s.db,
          obj: s.obj,
          page: s.page,
          pageSize: s.pageSize,
          where: s.appliedWhere,
          orderBy: s.appliedOrderBy,
          search: s.searchApplied,
          visibleColumns: s.visibleColumns,
        },
      );
      // scope=page 只取当前页；scope=result 由 Host 循环取尽（概要设计 5.7）
      // M8 后台化：SaveDialog 后立即回执 exportId，导出在 Host 后台继续（不阻塞本视图）
      const ack = await request<{ exportId: string; canceled?: boolean }>(
        'export.run',
        {
          ...params,
          format,
          scope,
          limit: s.pageSize,
          offset: s.page * s.pageSize,
        },
        0, // SaveDialog 是用户交互，不设限
      );
      if (ack.canceled) {
        return; // 用户取消保存对话框：静默（无任务）
      }
      set({ exportProgress: { exportId: ack.exportId, rows: 0, bytes: 0 } });
    } catch (err) {
      get().showToast({
        kind: 'error',
        text: t('table.toast.exportFailed', [err instanceof Error ? err.message : String(err)]),
      });
    }
  },

  async cancelExport() {
    const { exportProgress } = get();
    if (!exportProgress) {
      return;
    }
    try {
      await request('export.cancel', { exportId: exportProgress.exportId });
    } catch {
      // 取消失败静默（任务有超时/流自然结束兜底）
    }
  },

  setExportProgress(p) {
    set({ exportProgress: p });
  },

  // ── M4 编辑动作 ──────────────────────────────────────────

  applyHandshake(hs) {
    set({
      editEnabled: hs.edit.enabled,
      editReason: hs.edit.reason,
      capabilities: hs.capabilities,
      // M7 cursor 透传：游标栈不进崩溃快照（opaque 且跨会话无意义），恢复回第 0 页
      cursors: [undefined],
    });
    const snapshot = hs.changeSet;
    const hasSnapshot = snapshot.inserts.length + snapshot.updates.length + snapshot.deletes.length > 0;
    if (hasSnapshot) {
      const restored = overlayFromSnapshot(snapshot);
      set({ updates: restored.updates, deletes: restored.deletes, inserts: restored.inserts });
    }
    if (hs.uiState) {
      const ui = hs.uiState;
      set({
        page: hs.capabilities.pagination === 'cursor' ? 0 : ui.page,
        pageSize: ui.pageSize,
        searchApplied: ui.search,
        // drafts 为旧版构造器遗留（协议兼容保留），恒忽略；恢复 WHERE/ORDER BY 自由条件
        appliedWhere: ui.where ?? '',
        appliedOrderBy: ui.orderBy ?? '',
      });
    }
  },

  rowEditState(rowIndex) {
    const s = get();
    if (rowIndex >= s.rows.length) {
      return { kind: 'inserted' as const };
    }
    if (rowIndex < 0) {
      return { kind: 'normal' as const }; // 非法索引防御：白屏（React 渲染期异常）比错值代价大
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
    if (!col || rowIndex < 0) {
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
      get().showToast({ kind: 'info', text: t('table.toast.binaryReadonly') });
      return;
    }
    if (rowIndex < s.rows.length && s.primaryKey.includes(col.name)) {
      get().showToast({ kind: 'info', text: t('table.toast.pkReadonly') });
      return;
    }
    if (rowIndex < s.rows.length && get().rowEditState(rowIndex).kind === 'deleted') {
      return; // 已标记删除的行不再进入编辑
    }
    set({ editing: { rowIndex, colIndex } });
    // 截断单元格后台预取整值（编辑器种子文本随回写刷新；提交时仍有提交时点解析兜底，ADR D-30）
    if (isCellTruncated(s, rowIndex, colIndex)) {
      void get().resolveFullCell(rowIndex, colIndex).catch(() => undefined);
    }
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
      get().showToast({ kind: 'error', text: t('table.cell.valueInvalid', [col.name, parsed.error ?? '']) });
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
    // 已有行：截断单元格先取整值（乐观锁 old 必须整值，ADR D-30；取值失败中止本次编辑）
    void (async () => {
      try {
        if (isCellTruncated(get(), editing.rowIndex, editing.colIndex)) {
          await get().resolveFullCell(editing.rowIndex, editing.colIndex);
        }
      } catch (err) {
        get().showToast({ kind: 'error', text: t('table.toast.fullCellFailed', [err instanceof Error ? err.message : String(err)]) });
        return;
      }
      const s2 = get();
      if (editing.rowIndex >= s2.rows.length) {
        return; // 行已被刷新更替
      }
      const row = s2.rows[editing.rowIndex];
      const rowKey = rowKeyOfRow(row, s2.columns, s2.primaryKey);
      const key = rowKeyString(rowKey);
      const overlay = s2.updates[key];
      const nextOverlay = mergeSetCell(overlay, rowKey, col.name, row[editing.colIndex], value);
      if (!overlay && !nextOverlay) {
        return; // 首改即原值：无变化
      }
      const updates = { ...s2.updates };
      if (nextOverlay) {
        updates[key] = nextOverlay;
      } else {
        delete updates[key];
      }
      set({ updates });
      queueOp({ op: 'setCell', rowKey, column: col.name, old: row[editing.colIndex], new: value });
      scheduleSync(set, get);
    })();
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
    // 聚焦第一个可编辑列。新插入行的展示位 = rows.length + 旧 inserts.length（追加后
    // 新行序 = 新总数 - 1 = 旧数）——空表（rows=0 且首次新增）下旧式 `-1` 写法算出 -1，
    // 聚焦 effect 经 effectiveValue 取 rows[-1] 直接 TypeError 白屏
    const colIndex = s.columns.findIndex((c) => c.type !== 'binary' && !s.primaryKey.includes(c.name));
    if (colIndex >= 0) {
      set({ editing: { rowIndex: s.rows.length + s.inserts.length, colIndex } });
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

  selectRow(rowIndex, mode) {
    const s = get();
    if (rowIndex >= s.rows.length) {
      return; // 仅服务端行可选中（插入行经工具栏管理）
    }
    const keyOf = (idx: number): string => rowKeyString(rowKeyOfRow(s.rows[idx], s.columns, s.primaryKey));
    if (mode === 'extend' && s.selectionAnchor !== null) {
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
    if (mode === 'toggle') {
      const key = keyOf(rowIndex);
      const selectedRows = { ...s.selectedRows };
      if (selectedRows[key]) {
        delete selectedRows[key];
      } else {
        selectedRows[key] = true;
      }
      set({ selectedRows, selectionAnchor: rowIndex });
      return;
    }
    // replace：任何新的单击选中都覆盖已有选择（评审反馈）
    set({ selectedRows: { [keyOf(rowIndex)]: true }, selectionAnchor: rowIndex });
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

  revertSelected() {
    const s = get();
    if (!s.editEnabled || s.committing || s.previewing) {
      return;
    }
    // 与 revertRowByIndex 同语义的批量版：本地清覆盖层 + 逐行 revertRow op 合并一次上行
    const updates = { ...s.updates };
    const deletes = { ...s.deletes };
    const rowErrors = { ...s.rowErrors };
    let reverted = 0;
    for (let i = 0; i < s.rows.length; i++) {
      const rowKey = rowKeyOfRow(s.rows[i], s.columns, s.primaryKey);
      const key = rowKeyString(rowKey);
      if (!s.selectedRows[key] || (!s.updates[key] && !s.deletes[key])) {
        continue;
      }
      delete updates[key];
      delete deletes[key];
      delete rowErrors[key];
      queueOp({ op: 'revertRow', rowKey });
      reverted++;
    }
    if (reverted === 0) {
      return;
    }
    set({ updates, deletes, rowErrors });
    scheduleSync(set, get);
    get().showToast({ kind: 'info', text: t('table.toast.revertedRows', [reverted]) });
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
      get().showToast({ kind: 'info', text: t('table.toast.revertedAll') });
    } catch (err) {
      get().showToast({ kind: 'error', text: err instanceof Error ? err.message : String(err) });
    }
  },

  async openPreview() {
    const s = get();
    if (s.committing || s.previewing) {
      return;
    }
    const synced = await flushPending(set, get);
    if (!synced) {
      return; // 上行失败已提示，中止预览
    }
    if (get().editCount().total === 0) {
      get().showToast({ kind: 'info', text: t('table.toast.noChanges') });
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
    if (s.committing || s.previewing) {
      return;
    }
    // 未同步的编辑立即上行并等待完成（postMessage 消息按序处理，
    // 等待可保证 Host 处理 applyChanges 时权威副本已含全部编辑）
    if (!(await flushPending(set, get))) {
      return; // 上行失败已提示；带着缺失的权威副本提交会静默漏改，必须中止
    }
    if (get().editCount().total === 0) {
      get().showToast({ kind: 'info', text: t('table.toast.noChanges') });
      return;
    }
    set({ committing: true, previewItems: null });
    try {
      const result = await request<ApplyChangesResult>('table.applyChanges', {
        connId: s.connId,
        db: s.db,
        obj: s.obj,
      });
      set({ committing: false, updates: {}, deletes: {}, inserts: [], rowErrors: {} });
      get().showToast({ kind: 'info', text: t('table.toast.committed', [result.items.length]) });
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
              text: t('table.toast.conflict'),
              actions: [
                { label: t('table.action.refreshDiscard'), onSelect: () => void get().discardAndRefresh() },
                { label: t('table.action.retainMine'), onSelect: () => void get().retainMyChanges() },
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

  async openDdl() {
    const s = get();
    if (s.ddlLoading) {
      return;
    }
    set({ ddlLoading: true, ddl: null });
    try {
      const result = await request<GetDdlResult>('table.getDdl', {
        connId: s.connId,
        db: s.db,
        obj: s.obj,
      });
      set({ ddl: result.ddl, ddlLoading: false });
    } catch (err) {
      set({ ddlLoading: false });
      const rpc = err instanceof RpcError ? err : undefined;
      get().showToast({ kind: 'error', text: errorCodeToMessage(rpc?.code, err instanceof Error ? err.message : String(err)) });
    }
  },

  closeDdl() {
    set({ ddl: null });
  },

  openCellViewer(rowIndex, colIndex) {
    const s = get();
    const col = s.columns[colIndex];
    if (!col || rowIndex >= s.rows.length) {
      return;
    }
    const kind = viewerKindFor(col.type, s.rows[rowIndex][colIndex]);
    if (!kind) {
      return;
    }
    const row = s.rows[rowIndex];
    set({ viewer: { rowIndex, colIndex, kind, value: row[colIndex], loading: s.capabilities.lazyCell === true, partial: s.capabilities.lazyCell === true } });
    if (s.capabilities.lazyCell !== true) {
      return;
    }
    // 按需拉取整值（驱动可能截断行内值）；失败回退行内值并提示，partial 保持 true
    // （查看器编辑保存/另存禁用，防前缀覆写整值）；已关闭/切换即丢弃（P-6 口径）
    request<{ value: unknown }>('cell.fetch', {
      connId: s.connId,
      db: s.db,
      obj: s.obj,
      rowKey: rowKeyOfRow(row, s.columns, s.primaryKey),
      column: col.name,
    })
      .then(({ value }) => {
        const cur = get().viewer;
        if (!cur || cur.rowIndex !== rowIndex || cur.colIndex !== colIndex) {
          return;
        }
        set({ viewer: { ...cur, value, loading: false, partial: false } });
      })
      .catch((err) => {
        const cur = get().viewer;
        if (!cur || cur.rowIndex !== rowIndex || cur.colIndex !== colIndex) {
          return;
        }
        set({ viewer: { ...cur, loading: false } });
        get().showToast({
          kind: 'error',
          text: t('table.toast.lazyCellFailed', [err instanceof Error ? err.message : String(err)]),
        });
      });
  },

  closeCellViewer() {
    set({ viewer: null });
  },

  async resolveFullCell(rowIndex, colIndex, knownFull) {
    const s = get();
    if (rowIndex < 0 || rowIndex >= s.rows.length) {
      return null;
    }
    if (knownFull !== undefined) {
      writeBackCell(set, get, rowIndex, colIndex, knownFull);
      return knownFull;
    }
    if (!isCellTruncated(s, rowIndex, colIndex)) {
      return s.rows[rowIndex][colIndex];
    }
    if (s.capabilities.lazyCell !== true) {
      return s.rows[rowIndex][colIndex]; // 非 lazyCell 连接不产生截断（防御）
    }
    const col = s.columns[colIndex];
    const row = s.rows[rowIndex];
    const rowKey = rowKeyOfRow(row, s.columns, s.primaryKey);
    const { value } = await request<{ value: unknown }>('cell.fetch', {
      connId: s.connId,
      db: s.db,
      obj: s.obj,
      rowKey,
      column: col?.name ?? '',
    });
    // 行数据可能已被 refresh 更替：回写前校验行身份（RowKey）未变
    writeBackCell(set, get, rowIndex, colIndex, value, rowKeyString(rowKey));
    return value;
  },

  async resolveRowsFull(rowIndexes) {
    const wanted = new Set(rowIndexes);
    const targets = get().truncatedCells.filter(([r]) => wanted.has(r));
    for (const [r, c] of targets) {
      // 逐格取整值（截断单元格通常稀少）；失败抛给调用方——复制中止，不静默截断（ADR D-30）
      await get().resolveFullCell(r, c);
    }
  },

  applyCellValue(rowIndex, colIndex, value) {
    const s = get();
    // 查看器已持整值（partial=false）时作为 knownFull 直接回写，省一次重复 RPC（ADR D-30）
    const knownFull =
      s.viewer && s.viewer.rowIndex === rowIndex && s.viewer.colIndex === colIndex && !s.viewer.partial
        ? s.viewer.value
        : undefined;
    void confirmParsed(set, get, rowIndex, colIndex, value, knownFull);
    set({ viewer: null });
  },

  async saveViewerBinary() {
    const s = get();
    const v = s.viewer;
    const col = v ? s.columns[v.colIndex] : null;
    if (!v || v.kind !== 'binary' || typeof v.value !== 'string') {
      return;
    }
    if (v.partial) {
      // 整值未到手（懒取失败）：前缀落盘 = 半文件，禁用（ADR D-30）
      get().showToast({ kind: 'error', text: t('table.viewer.partialNote') });
      return;
    }
    try {
      const { path } = await request<{ path: string | null }>('sys.saveFile', {
        defaultName: `${s.obj}-${col?.name ?? 'binary'}.bin`,
        base64: v.value,
        title: t('table.viewer.saveAsFile'),
      });
      if (path) {
        get().showToast({ kind: 'info', text: t('table.toast.savedTo', [path]) });
      }
    } catch (err) {
      get().showToast({ kind: 'error', text: err instanceof Error ? err.message : String(err) });
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
        get().showToast({ kind: 'error', text: t('table.toast.insertFailed') }, 6000);
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
          where: '',
          orderBy: '',
          search: '',
          visibleColumns: null, // 全列基线
        },
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
          get().showToast({ kind: 'error', text: t('table.toast.rowDeletedStale') }, 6000);
          set({ rowErrors: {} });
          return;
        }
        get().showToast(
          { kind: 'error', text: t('table.toast.rowDeletedNoRetain'), actions: [{ label: t('table.action.refreshDiscard'), onSelect: () => void get().discardAndRefresh() }] },
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
            text: t('table.toast.conflictColumns', [conflictedCols.join('、')]),
            actions: [{ label: t('table.action.refreshDiscard'), onSelect: () => void get().discardAndRefresh() }],
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
      get().showToast({ kind: 'info', text: t('table.toast.rebased') });
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

  showToast(toast, autoDismissMs) {
    if (toastTimer !== undefined) {
      clearTimeout(toastTimer);
    }
    set({ toast });
    const ms = autoDismissMs ?? (toast.actions ? 8000 : 3000);
    if (toast.actions && ms === 0) {
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

/** 立即上行待同步编辑（300ms debounce 的 flush；概要设计 §4.5）。
 *  返回是否全部上行成功（无待同步时视为成功），调用方可 await 保证 Host 端时序。 */
function flushPending(
  set: (partial: Partial<TableState>) => void,
  get: () => TableState,
): Promise<boolean> {
  if (syncTimer !== undefined) {
    clearTimeout(syncTimer);
    syncTimer = undefined;
  }
  const s = get();
  const ops = pendingOps;
  pendingOps = [];
  if (ops.length === 0) {
    return Promise.resolve(true);
  }
  const seq = ++syncSeq;
  return request('table.editChanges', {
    connId: s.connId,
    db: s.db,
    obj: s.obj,
    ops,
    uiState: {
      page: s.page,
      pageSize: s.pageSize,
      sorts: [],
      search: s.searchApplied,
      drafts: [],
      where: s.appliedWhere,
      orderBy: s.appliedOrderBy,
    },
  }).then(
    () => true,
    (err) => {
      if (seq !== syncSeq) {
        return false;
      }
      get().showToast({ kind: 'error', text: t('table.toast.syncFailed', [err instanceof Error ? err.message : String(err)]) });
      set({}); // 触发一次渲染
      return false;
    },
  );
}

async function confirmParsed(
  set: (partial: Partial<TableState>) => void,
  get: () => TableState,
  rowIndex: number,
  colIndex: number,
  value: unknown,
  knownFull?: unknown,
): Promise<void> {
  const s0 = get();
  const col = s0.columns[colIndex];
  if (!col || rowIndex >= s0.rows.length) {
    return;
  }
  // 截断单元格先取整值回写行内——乐观锁 old 必须整值，否则 WHERE 原值失配（ADR D-30）；
  // 取值失败中止本次编辑（不落队列，不静默用前缀比对）
  if (knownFull !== undefined || isCellTruncated(s0, rowIndex, colIndex)) {
    try {
      await get().resolveFullCell(rowIndex, colIndex, knownFull);
    } catch (err) {
      get().showToast({ kind: 'error', text: t('table.toast.fullCellFailed', [err instanceof Error ? err.message : String(err)]) });
      return;
    }
  }
  const s = get();
  if (rowIndex >= s.rows.length) {
    return; // 行已被刷新更替
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

/** 截断标记判定（truncatedCells 随取数更替，量级小线性扫） */
function isCellTruncated(s: TableState, rowIndex: number, colIndex: number): boolean {
  return s.truncatedCells.some(([r, c]) => r === rowIndex && c === colIndex);
}

/** 整值回写行内并清除对应截断标记；expectRowKey 给出时校验行身份未变（refresh 竞态防护） */
function writeBackCell(
  set: (partial: Partial<TableState>) => void,
  get: () => TableState,
  rowIndex: number,
  colIndex: number,
  value: unknown,
  expectRowKey?: string,
): void {
  const s = get();
  if (rowIndex < 0 || rowIndex >= s.rows.length) {
    return;
  }
  if (expectRowKey !== undefined) {
    const current = rowKeyString(rowKeyOfRow(s.rows[rowIndex], s.columns, s.primaryKey));
    if (current !== expectRowKey) {
      return; // 行已被刷新更替，丢弃回写
    }
  }
  const rows = s.rows.slice();
  const next = rows[rowIndex].slice();
  next[colIndex] = value;
  rows[rowIndex] = next;
  set({
    rows,
    truncatedCells: s.truncatedCells.filter(([r, c]) => !(r === rowIndex && c === colIndex)),
  });
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
