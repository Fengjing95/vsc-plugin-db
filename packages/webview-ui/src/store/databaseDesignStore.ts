import type { DdlStatementPayload, FormFieldPayload } from '@db-explorer/protocol';
import { DbDdlLoadResultSchema, DdlStatementSchema, RpcMethods } from '@db-explorer/protocol';
import { create } from 'zustand';
import { request } from '../rpc/client';
import { initialFieldValues, specOf, validateFieldValues } from '../lib/databaseDesign';

/**
 * 库级 DDL 弹窗状态（M8-DBDDL，交互稿 §8.3）：
 * dbddl.load 引导（create 空 / alter 预填当前值）→ 表单编辑 → SQL 预览（dbddl.preview）→
 * 执行（dbddl.execute，Host 同源重新生成语句；成功后 Host 关面板 + 树刷新）。
 */

export type DesignPhase = 'loading' | 'ready' | 'error';

interface DatabaseDesignState {
  phase: DesignPhase;
  errorMsg: string;

  connId: string;
  db: string;
  kind: 'create' | 'alter';

  fields: FormFieldPayload[];
  values: Record<string, unknown>;
  errors: Record<string, string>;

  preview: DdlStatementPayload[] | null;
  executing: boolean;
  executeError: { index: number; code: string; message: string } | null;

  load(): Promise<void>;
  setValue(key: string, value: unknown): void;
  requestPreview(): Promise<void>;
  closePreview(): void;
  execute(): Promise<void>;
  close(): Promise<void>;
}

export const useDatabaseDesignStore = create<DatabaseDesignState>((set, get) => ({
  phase: 'loading',
  errorMsg: '',

  connId: window.__BOOTSTRAP__?.params.connId ?? '',
  db: window.__BOOTSTRAP__?.params.db ?? '',
  kind: (window.__BOOTSTRAP__?.params.kind as 'create' | 'alter') ?? 'create',

  fields: [],
  values: {},
  errors: {},

  preview: null,
  executing: false,
  executeError: null,

  async load() {
    const { connId, db, kind } = get();
    set({ phase: 'loading', errorMsg: '' });
    try {
      const raw = await request<unknown>(RpcMethods.dbddlLoad, { connId, kind, db: db || undefined }, 30_000);
      const result = DbDdlLoadResultSchema.parse(raw);
      const values = initialFieldValues(result.schema.fields);
      if (result.spec) {
        // 编辑态预填（name/charset/collation）
        values.name = result.spec.name;
        if (result.spec.charset !== undefined) values.charset = result.spec.charset;
        if (result.spec.collation !== undefined) values.collation = result.spec.collation;
      }
      set({
        phase: 'ready',
        fields: result.schema.fields,
        values,
        errors: {},
        preview: null,
        executeError: null,
      });
    } catch (err) {
      set({ phase: 'error', errorMsg: err instanceof Error ? err.message : String(err) });
    }
  },

  setValue(key: string, value: unknown) {
    set((s) => ({ values: { ...s.values, [key]: value }, errors: { ...s.errors, [key]: '' } }));
  },

  async requestPreview() {
    const { connId, db, kind, values, fields } = get();
    const errors = validateFieldValues(fields, values);
    if (Object.keys(errors).some((k) => errors[k])) {
      set({ errors });
      return;
    }
    const spec = specOf(values);
    const raw = await request<unknown>(
      RpcMethods.dbddlPreview,
      { connId, kind, db: db || undefined, spec },
      30_000,
    );
    const parsed = zParseStatements(raw);
    set({ preview: parsed });
  },

  closePreview() {
    set({ preview: null });
  },

  async execute() {
    const { connId, db, kind, values, fields } = get();
    const errors = validateFieldValues(fields, values);
    if (Object.keys(errors).some((k) => errors[k])) {
      set({ errors });
      return;
    }
    const spec = specOf(values);
    set({ executing: true, executeError: null });
    try {
      const raw = await request<{
        executed: number;
        failed?: { index: number; code: string; message: string };
      }>(
        RpcMethods.dbddlExecute,
        { connId, kind, db: db || undefined, spec },
        60_000,
      );
      if (raw.failed) {
        // 失败即停：面板保留 + 明示中间态（DDL 隐式提交）
        set({ executing: false, executeError: raw.failed, preview: null });
        return;
      }
      // 成功：Host 侧 dispose 面板（dbDatabasePanel execute handler）；本地仅复位
      set({ executing: false, preview: null });
    } catch (err) {
      set({ executing: false, executeError: { index: 1, code: 'E_INTERNAL', message: err instanceof Error ? err.message : String(err) } });
    }
  },

  async close() {
    await request(RpcMethods.dbddlClose, {}, 10_000);
  },
}));

/** 预览语句 zod 校验（D-06 Webview 侧；statement 结构与 ddl.preview 同形状） */
function zParseStatements(raw: unknown): DdlStatementPayload[] {
  const parsed = DdlStatementSchema.array().parse((raw as { statements: unknown }).statements);
  return parsed;
}
