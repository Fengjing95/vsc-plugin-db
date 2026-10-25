import type {
  ColumnSpecPayload,
  DataTypeOptionPayload,
  DdlStatementPayload,
  ForeignKeySpecPayload,
  IndexSpecPayload,
  TableDesignFeaturesPayload,
  TableSpecPayload,
  UniqueKeySpecPayload,
} from '@db-explorer/protocol';
import { DdlLoadResultSchema, DdlPreviewResultSchema, RpcMethods } from '@db-explorer/protocol';
import { create } from 'zustand';
import { t } from '../lib/i18n';
import { request } from '../rpc/client';
import {
  columnRowError,
  diffSummaryTextExtended,
  fkRowError,
  idxRowError,
  nextOrdinal,
  tableSpecError,
  ukRowError,
  type ColumnRow,
  type FkRow,
  type IdxRow,
  type UkRow,
} from '../lib/tableDesign';

/**
 * 表结构编辑器状态（M8-B2，交互稿 §12；Tab 化为表设计器批次 B §12.1~12.7）：
 * ddl.load 引导（create 空白 / alter 预载基线）→ 本地编辑（立即生效，无自动同步）→
 * SQL 预览（ddl.preview）→ 执行（ddl.execute，Host 侧同源重新生成语句）。
 * Tab：列 / 键 / 外键 / 索引按驱动 features 显隐（缺省 = 纯列编辑）；外键引用表/列
 * 经 ddl.refTables / ddl.refColumns 懒拉（失败无感降级为手输，§12.5）。
 * 不做崩溃恢复（§12.2 刻意从简：结构编辑非长事务场景）。
 */

let rowSeq = 0;
function newRowId(prefix: string): string {
  rowSeq += 1;
  return `${prefix}-${rowSeq}`;
}

function newRow(col: ColumnSpecPayload): ColumnRow {
  return { rowId: newRowId('col'), col };
}

function emptyColumn(ordinal: number): ColumnRow {
  return newRow({ name: '', dataType: '', nullable: true, isPrimaryKey: false, ordinal });
}

export type DesignPhase = 'loading' | 'ready' | 'error';
export type DesignTab = 'columns' | 'keys' | 'fks' | 'indexes';

interface TableDesignState {
  phase: DesignPhase;
  errorMsg: string;

  connId: string;
  db: string;
  obj?: string;
  kind: 'create' | 'alter';
  readOnly: boolean;

  tableName: string;
  tableComment: string;
  rows: ColumnRow[];
  /** 类型建议词表（ddl.load 下发，驱动方言各自维护；空数组 = 类型框纯手输） */
  dataTypes: DataTypeOptionPayload[];
  /** Tab 能力（ddl.load 下发；缺省 = 键/外键/索引 Tab 隐藏，§12.2） */
  features?: TableDesignFeaturesPayload;
  activeTab: DesignTab;
  /** alter 基线（ddl.load 预载；执行前 Host 会重拉最新） */
  baseline: TableSpecPayload | null;

  ukRows: UkRow[];
  fkRows: FkRow[];
  idxRows: IdxRow[];
  /** 外键引用表清单（§12.5：聚焦/首用懒拉；failed = 无感降级手输） */
  refTables: string[];
  refTablesStatus: 'idle' | 'loading' | 'ready' | 'failed';
  /** 引用表 → 列清单缓存 */
  refColumnsCache: Record<string, string[]>;
  refColumnsLoading: Record<string, boolean>;

  dirty: boolean;
  executing: boolean;
  /** 初始聚焦的列行（§12 修订：编辑列 focus 到指定列 / 新增列 focus 到新空行），聚焦后清空 */
  focusRowId: string | null;
  /** 预览面板：语句集 + destructive 红条 */
  preview: { statements: DdlStatementPayload[] } | null;
  /** 执行失败定位（交互稿 §12.2：失败不关面板，明示中间态） */
  executeError: { index: number; code: string; message: string; total: number } | null;
  toast: { kind: 'info' | 'error'; text: string } | null;

  bootstrap(): Promise<void>;
  clearFocus(): void;
  setTableName(name: string): void;
  setTableComment(comment: string): void;
  setActiveTab(tab: DesignTab): void;
  editColumn(rowId: string, patch: Partial<ColumnSpecPayload>): void;
  addColumn(): void;
  removeColumn(rowId: string): void;
  restoreColumn(rowId: string): void;
  editUk(rowId: string, patch: Partial<UniqueKeySpecPayload>): void;
  addUk(): void;
  removeUk(rowId: string): void;
  editFk(rowId: string, patch: Partial<ForeignKeySpecPayload>): void;
  addFk(): void;
  removeFk(rowId: string): void;
  editIdx(rowId: string, patch: Partial<IndexSpecPayload>): void;
  addIdx(): void;
  removeIdx(rowId: string): void;
  loadRefTables(): Promise<void>;
  loadRefColumns(table: string): Promise<void>;
  canExecute(): boolean;
  validationError(): string | undefined;
  tabErrorCount(tab: DesignTab): number;
  diffText(): string | undefined;
  showPreview(): Promise<void>;
  hidePreview(): void;
  execute(): Promise<void>;
  closePanel(): Promise<void>;
  dismissToast(): void;
}

export const useTableDesignStore = create<TableDesignState>((set, get) => ({
  phase: 'loading',
  errorMsg: '',

  connId: '',
  db: '',
  kind: 'create',
  readOnly: false,

  tableName: '',
  tableComment: '',
  rows: [],
  dataTypes: [],
  activeTab: 'columns',
  baseline: null,

  ukRows: [],
  fkRows: [],
  idxRows: [],
  refTables: [],
  refTablesStatus: 'idle',
  refColumnsCache: {},
  refColumnsLoading: {},

  dirty: false,
  executing: false,
  focusRowId: null,
  preview: null,
  executeError: null,
  toast: null,

  async bootstrap() {
    const boot = window.__BOOTSTRAP__;
    const connId = boot?.params.connId ?? '';
    const db = boot?.params.db ?? '';
    const obj = boot?.params.obj || undefined;
    const appendColumn = boot?.params.appendColumn === 'true';
    const focusColumn = boot?.params.focusColumn || undefined;
    set({ connId, db, obj, kind: obj ? 'alter' : 'create', readOnly: boot?.params.readOnly === 'true' });
    try {
      const raw = await request<unknown>(RpcMethods.ddlLoad, { connId, db, obj }, 30_000);
      const parsed = DdlLoadResultSchema.safeParse(raw);
      if (!parsed.success) {
        set({ phase: 'error', errorMsg: t('design.protocolMismatch') });
        return;
      }
      const features = parsed.data.features;
      if (parsed.data.kind === 'alter' && parsed.data.spec) {
        const spec = parsed.data.spec;
        const rows = spec.columns.map((c) => newRow({ ...c }));
        const ukRows: UkRow[] = (spec.uniqueKeys ?? []).map((k) => ({ rowId: newRowId('uk'), spec: { ...k, columns: [...k.columns] } }));
        const fkRows: FkRow[] = (spec.foreignKeys ?? []).map((k) => ({ rowId: newRowId('fk'), spec: { ...k, columns: [...k.columns], refColumns: [...k.refColumns] } }));
        const idxRows: IdxRow[] = (spec.indexes ?? []).map((k) => ({ rowId: newRowId('idx'), spec: { ...k, columns: [...k.columns] } }));
        // §12 修订：编辑列 focus 到指定列；新增列追加空行并 focus（找不到目标列则不聚焦）
        let focusRowId: string | null = null;
        if (appendColumn) {
          const fresh = emptyColumn(nextOrdinal(rows));
          rows.push(fresh);
          focusRowId = fresh.rowId;
        } else if (focusColumn) {
          focusRowId = rows.find((r) => r.col.name === focusColumn)?.rowId ?? null;
        }
        set({
          phase: 'ready',
          baseline: spec,
          tableName: spec.name,
          tableComment: spec.comment ?? '',
          rows,
          dataTypes: parsed.data.dataTypes ?? [],
          features,
          ukRows,
          fkRows,
          idxRows,
          focusRowId,
        });
      } else {
        set({ phase: 'ready', rows: [emptyColumn(1)], dataTypes: parsed.data.dataTypes ?? [], features });
      }
    } catch (err) {
      set({ phase: 'error', errorMsg: err instanceof Error ? err.message : String(err) });
    }
  },

  clearFocus() {
    set({ focusRowId: null });
  },

  setTableName(name) {
    set({ tableName: name, dirty: true });
  },

  setTableComment(comment) {
    set({ tableComment: comment, dirty: true });
  },

  setActiveTab(tab) {
    set({ activeTab: tab });
  },

  editColumn(rowId, patch) {
    set({
      rows: get().rows.map((r) => (r.rowId === rowId ? { ...r, col: { ...r.col, ...patch } } : r)),
      dirty: true,
    });
  },

  addColumn() {
    const rows = get().rows;
    const fresh = emptyColumn(nextOrdinal(rows));
    set({ rows: [...rows, fresh], dirty: true });
    return fresh.rowId;
  },

  removeColumn(rowId) {
    // §12.2：删除行红底可撤销（本地标记，权威语句集由驱动 diff）
    set({
      rows: get().rows.map((r) => (r.rowId === rowId ? { ...r, deleted: true } : r)),
      dirty: true,
    });
  },

  restoreColumn(rowId) {
    set({
      rows: get().rows.map((r) => (r.rowId === rowId ? { ...r, deleted: false } : r)),
      dirty: true,
    });
  },

  editUk(rowId, patch) {
    set({
      ukRows: get().ukRows.map((r) => (r.rowId === rowId ? { ...r, spec: { ...r.spec, ...patch } } : r)),
      dirty: true,
    });
  },

  addUk() {
    set({ ukRows: [...get().ukRows, { rowId: newRowId('uk'), spec: { columns: [] } }], dirty: true });
  },

  removeUk(rowId) {
    set({ ukRows: get().ukRows.filter((r) => r.rowId !== rowId), dirty: true });
  },

  editFk(rowId, patch) {
    set({
      fkRows: get().fkRows.map((r) => (r.rowId === rowId ? { ...r, spec: { ...r.spec, ...patch } } : r)),
      dirty: true,
    });
  },

  addFk() {
    set({ fkRows: [...get().fkRows, { rowId: newRowId('fk'), spec: { columns: [], refTable: '', refColumns: [] } }], dirty: true });
  },

  removeFk(rowId) {
    set({ fkRows: get().fkRows.filter((r) => r.rowId !== rowId), dirty: true });
  },

  editIdx(rowId, patch) {
    set({
      idxRows: get().idxRows.map((r) => (r.rowId === rowId ? { ...r, spec: { ...r.spec, ...patch } } : r)),
      dirty: true,
    });
  },

  addIdx() {
    set({ idxRows: [...get().idxRows, { rowId: newRowId('idx'), spec: { columns: [] } }], dirty: true });
  },

  removeIdx(rowId) {
    set({ idxRows: get().idxRows.filter((r) => r.rowId !== rowId), dirty: true });
  },

  /** 外键引用表清单懒拉（§12.5）：失败无感降级（不置错误态），下次进入 Tab 重试 */
  async loadRefTables() {
    const s = get();
    if (s.refTablesStatus === 'loading' || s.refTablesStatus === 'ready') {
      return;
    }
    set({ refTablesStatus: 'loading' });
    try {
      const raw = await request<{ tables: string[] }>(RpcMethods.ddlRefTables, { connId: s.connId, db: s.db }, 15_000);
      set({ refTables: raw.tables ?? [], refTablesStatus: 'ready' });
    } catch {
      set({ refTables: [], refTablesStatus: 'failed' });
    }
  },

  async loadRefColumns(table) {
    const s = get();
    if (!table || s.refColumnsCache[table] || s.refColumnsLoading[table]) {
      return;
    }
    set({ refColumnsLoading: { ...s.refColumnsLoading, [table]: true } });
    try {
      const raw = await request<{ columns: string[] }>(RpcMethods.ddlRefColumns, { connId: s.connId, db: s.db, table }, 15_000);
      set({ refColumnsCache: { ...get().refColumnsCache, [table]: raw.columns ?? [] }, refColumnsLoading: { ...get().refColumnsLoading, [table]: false } });
    } catch {
      // 失败无感降级：引用列下拉留空（用户可改用手输场景走列名编辑禁用），不置错误态
      set({ refColumnsLoading: { ...get().refColumnsLoading, [table]: false } });
    }
  },

  canExecute() {
    const s = get();
    if (s.executing || s.readOnly) {
      return false;
    }
    return get().validationError() === undefined;
  },

  validationError() {
    const s = get();
    const base = tableSpecError(s.kind, s.tableName, s.rows);
    if (base) {
      return base;
    }
    for (const r of s.ukRows) {
      const err = ukRowError(r, s.ukRows);
      if (err) {
        return err;
      }
    }
    for (const r of s.fkRows) {
      const err = fkRowError(r, s.fkRows);
      if (err) {
        return err;
      }
    }
    for (const r of s.idxRows) {
      const err = idxRowError(r, s.idxRows);
      if (err) {
        return err;
      }
    }
    return undefined;
  },

  tabErrorCount(tab) {
    const s = get();
    if (tab === 'columns') {
      return s.rows.filter((r) => columnRowError(r, s.rows) !== undefined).length;
    }
    if (tab === 'keys') {
      return s.ukRows.filter((r) => ukRowError(r, s.ukRows) !== undefined).length;
    }
    if (tab === 'fks') {
      return s.fkRows.filter((r) => fkRowError(r, s.fkRows) !== undefined).length;
    }
    return s.idxRows.filter((r) => idxRowError(r, s.idxRows) !== undefined).length;
  },

  diffText() {
    const s = get();
    if (s.kind !== 'alter') {
      return undefined;
    }
    return diffSummaryTextExtended(s.baseline, s.rows, s.ukRows, s.fkRows, s.idxRows);
  },

  async showPreview() {
    const s = get();
    if (!s.canExecute()) {
      return;
    }
    try {
      const raw = await request<unknown>(
        RpcMethods.ddlPreview,
        { connId: s.connId, db: s.db, obj: s.obj, spec: buildSpec(s.tableName, s.tableComment, s.rows, s.ukRows, s.fkRows, s.idxRows) },
        30_000,
      );
      const parsed = DdlPreviewResultSchema.safeParse(raw);
      if (!parsed.success) {
        set({ toast: { kind: 'error', text: t('design.previewProtocolError') } });
        return;
      }
      set({ preview: { statements: parsed.data.statements } });
    } catch (err) {
      set({ toast: { kind: 'error', text: t('design.previewFailed', [err instanceof Error ? err.message : String(err)]) } });
    }
  },

  hidePreview() {
    set({ preview: null });
  },

  async execute() {
    const s = get();
    if (!s.canExecute()) {
      return;
    }
    set({ executing: true, executeError: null });
    try {
      const result = await request<{ executed: number; failed?: { index: number; code: string; message: string } }>(
        RpcMethods.ddlExecute,
        { connId: s.connId, db: s.db, obj: s.obj, spec: buildSpec(s.tableName, s.tableComment, s.rows, s.ukRows, s.fkRows, s.idxRows) },
        0, // 危险确认（prod 输入表名）是用户交互，不设限
      );
      if (result.failed) {
        set({
          executing: false,
          executeError: { ...result.failed, total: s.preview?.statements.length ?? 0 },
          toast: {
            kind: 'error',
            text: t('design.executeFailedDetail', [result.failed.index, result.failed.code, result.failed.message]),
          },
        });
        return;
      }
      // 成功：Host 侧已关闭面板 + 缓存失效 + 树刷新；关掉预览 Modal（面板 dispose 失败时不残留）
      set({ executing: false, preview: null });
    } catch (err) {
      const cancelled = err instanceof Error && err.message.includes('已取消');
      set({
        executing: false,
        toast: cancelled
          ? { kind: 'info', text: t('design.executeCancelled') }
          : { kind: 'error', text: t('design.executeFailed', [err instanceof Error ? err.message : String(err)]) },
      });
    }
  },

  async closePanel() {
    const s = get();
    if (s.dirty) {
      const leave = window.confirm(t('design.confirmDiscard'));
      if (!leave) {
        return;
      }
    }
    try {
      await request(RpcMethods.ddlClose, {}, 10_000);
    } catch {
      // 面板可能已关闭，静默
    }
  },

  dismissToast() {
    set({ toast: null });
  },
}));

function trimName(name: string | undefined): string | undefined {
  const t = (name ?? '').trim();
  return t ? t : undefined;
}

function buildSpec(
  tableName: string,
  tableComment: string,
  rows: ColumnRow[],
  ukRows: UkRow[],
  fkRows: FkRow[],
  idxRows: IdxRow[],
): TableSpecPayload {
  const spec: TableSpecPayload = {
    name: tableName.trim(),
    columns: rows
      .filter((r) => !r.deleted)
      .map((r, i) => ({
        name: r.col.name.trim(),
        dataType: r.col.dataType.trim(),
        nullable: r.col.nullable,
        isPrimaryKey: r.col.isPrimaryKey,
        autoIncrement: r.col.autoIncrement || undefined,
        defaultValue: r.col.defaultValue?.trim() ? r.col.defaultValue.trim() : undefined,
        comment: r.col.comment?.trim() ? r.col.comment.trim() : undefined,
        ordinal: i + 1,
      })),
  };
  if (tableComment.trim()) {
    spec.comment = tableComment.trim();
  }
  const uks = ukRows
    .filter((r) => r.spec.columns.length > 0)
    .map((r) => ({ name: trimName(r.spec.name), columns: r.spec.columns.map((c) => c.trim()) }));
  if (uks.length > 0) {
    spec.uniqueKeys = uks;
  }
  const fks = fkRows
    .filter((r) => r.spec.refTable.trim())
    .map((r) => {
      // §12.5 修订：UI 侧列对应按行维护（columns[i] ↔ refColumns[i]），提交时剔除未完成的组
      // （不完整的组会被校验拦截，此处防御性过滤保证 spec 平行数组严格成对）
      const columns: string[] = [];
      const refColumns: string[] = [];
      for (let i = 0; i < Math.max(r.spec.columns.length, r.spec.refColumns.length); i++) {
        const col = r.spec.columns[i]?.trim() ?? '';
        const ref = r.spec.refColumns[i]?.trim() ?? '';
        if (col && ref) {
          columns.push(col);
          refColumns.push(ref);
        }
      }
      return {
        name: trimName(r.spec.name),
        columns,
        refTable: r.spec.refTable.trim(),
        refColumns,
        onDelete: r.spec.onDelete,
        onUpdate: r.spec.onUpdate,
      };
    })
    .filter((r) => r.columns.length > 0);
  if (fks.length > 0) {
    spec.foreignKeys = fks;
  }
  const idxs = idxRows
    .filter((r) => r.spec.columns.length > 0)
    .map((r) => ({ name: trimName(r.spec.name), columns: r.spec.columns.map((c) => c.trim()), unique: r.spec.unique || undefined, type: r.spec.type || undefined }));
  if (idxs.length > 0) {
    spec.indexes = idxs;
  }
  return spec;
}
