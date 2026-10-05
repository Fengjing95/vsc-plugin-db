import type { ColumnSpecPayload, DdlStatementPayload, TableSpecPayload } from '@db-explorer/protocol';
import { DdlLoadResultSchema, DdlPreviewResultSchema, RpcMethods } from '@db-explorer/protocol';
import { create } from 'zustand';
import { request } from '../rpc/client';
import {
  columnRowError,
  diffSpecSummary,
  diffSummaryText,
  nextOrdinal,
  tableSpecError,
  type ColumnRow,
} from '../lib/tableDesign';

/**
 * 表结构编辑器状态（M8-B2，交互稿 §12）：
 * ddl.load 引导（create 空白 / alter 预载基线）→ 本地编辑（立即生效，无自动同步）→
 * SQL 预览（ddl.preview）→ 执行（ddl.execute，Host 侧同源重新生成语句）。
 * 不做崩溃恢复（§12.2 刻意从简：结构编辑非长事务场景）。
 */

let rowSeq = 0;
function newRow(col: ColumnSpecPayload): ColumnRow {
  rowSeq += 1;
  return { rowId: `col-${rowSeq}`, col };
}

function emptyColumn(ordinal: number): ColumnRow {
  return newRow({ name: '', dataType: '', nullable: true, isPrimaryKey: false, ordinal });
}

export type DesignPhase = 'loading' | 'ready' | 'error';

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
  /** alter 基线（ddl.load 预载；执行前 Host 会重拉最新） */
  baseline: TableSpecPayload | null;

  dirty: boolean;
  executing: boolean;
  /** 预览面板：语句集 + destructive 红条 */
  preview: { statements: DdlStatementPayload[] } | null;
  /** 执行失败定位（交互稿 §12.2：失败不关面板，明示中间态） */
  executeError: { index: number; code: string; message: string; total: number } | null;
  toast: { kind: 'info' | 'error'; text: string } | null;

  bootstrap(): Promise<void>;
  setTableName(name: string): void;
  setTableComment(comment: string): void;
  editColumn(rowId: string, patch: Partial<ColumnSpecPayload>): void;
  addColumn(): void;
  removeColumn(rowId: string): void;
  restoreColumn(rowId: string): void;
  canExecute(): boolean;
  validationError(): string | undefined;
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
  baseline: null,

  dirty: false,
  executing: false,
  preview: null,
  executeError: null,
  toast: null,

  async bootstrap() {
    const boot = window.__BOOTSTRAP__;
    const connId = boot?.params.connId ?? '';
    const db = boot?.params.db ?? '';
    const obj = boot?.params.obj || undefined;
    set({ connId, db, obj, kind: obj ? 'alter' : 'create', readOnly: boot?.params.readOnly === 'true' });
    try {
      const raw = await request<unknown>(RpcMethods.ddlLoad, { connId, db, obj }, 30_000);
      const parsed = DdlLoadResultSchema.safeParse(raw);
      if (!parsed.success) {
        set({ phase: 'error', errorMsg: '插件与视图版本不一致，请重载窗口' });
        return;
      }
      if (parsed.data.kind === 'alter' && parsed.data.spec) {
        const spec = parsed.data.spec;
        set({
          phase: 'ready',
          baseline: spec,
          tableName: spec.name,
          tableComment: spec.comment ?? '',
          rows: spec.columns.map((c) => newRow({ ...c })),
        });
      } else {
        set({ phase: 'ready', rows: [emptyColumn(1)] });
      }
    } catch (err) {
      set({ phase: 'error', errorMsg: err instanceof Error ? err.message : String(err) });
    }
  },

  setTableName(name) {
    set({ tableName: name, dirty: true });
  },

  setTableComment(comment) {
    set({ tableComment: comment, dirty: true });
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

  canExecute() {
    const s = get();
    if (s.executing || s.readOnly) {
      return false;
    }
    return tableSpecError(s.kind, s.tableName, s.rows) === undefined;
  },

  validationError() {
    const s = get();
    return tableSpecError(s.kind, s.tableName, s.rows);
  },

  diffText() {
    const s = get();
    if (s.kind !== 'alter') {
      return undefined;
    }
    return diffSummaryText(diffSpecSummary(s.baseline, s.rows));
  },

  async showPreview() {
    const s = get();
    if (!s.canExecute()) {
      return;
    }
    try {
      const raw = await request<unknown>(
        RpcMethods.ddlPreview,
        { connId: s.connId, db: s.db, obj: s.obj, spec: buildSpec(s.tableName, s.tableComment, s.rows) },
        30_000,
      );
      const parsed = DdlPreviewResultSchema.safeParse(raw);
      if (!parsed.success) {
        set({ toast: { kind: 'error', text: '预览生成失败（协议不一致）' } });
        return;
      }
      set({ preview: { statements: parsed.data.statements } });
    } catch (err) {
      set({ toast: { kind: 'error', text: `预览失败：${err instanceof Error ? err.message : String(err)}` } });
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
        { connId: s.connId, db: s.db, obj: s.obj, spec: buildSpec(s.tableName, s.tableComment, s.rows) },
        0, // 危险确认（prod 输入表名）是用户交互，不设限
      );
      if (result.failed) {
        set({
          executing: false,
          executeError: { ...result.failed, total: s.preview?.statements.length ?? 0 },
          toast: {
            kind: 'error',
            text: `第 ${result.failed.index} 条语句失败（${result.failed.code}）：${result.failed.message}。已执行的语句不回滚，库内结构可能处于中间态`,
          },
        });
        return;
      }
      // 成功：Host 侧已关闭面板 + 缓存失效 + 树刷新；本视图随之销毁，toast 由 Host 呈现
      set({ executing: false });
    } catch (err) {
      const cancelled = err instanceof Error && err.message.includes('已取消');
      set({
        executing: false,
        toast: cancelled
          ? { kind: 'info', text: '已取消执行' }
          : { kind: 'error', text: `执行失败：${err instanceof Error ? err.message : String(err)}` },
      });
    }
  },

  async closePanel() {
    const s = get();
    if (s.dirty) {
      const leave = window.confirm('放弃未保存的结构修改？');
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

function buildSpec(tableName: string, tableComment: string, rows: ColumnRow[]): TableSpecPayload {
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
  return spec;
}

/** 供页面渲染列级错误（订阅友好：独立函数避免在 action 内读 store） */
export function columnErrorOf(row: ColumnRow, rows: ColumnRow[]): string | undefined {
  return columnRowError(row, rows);
}
