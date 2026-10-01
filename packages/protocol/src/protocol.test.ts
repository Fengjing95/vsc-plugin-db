import { describe, expect, it } from 'vitest';
import {
  ApplyChangesResultSchema,
  ConnSaveParamsSchema,
  ConnTestParamsSchema,
  ConsoleBannerSchema,
  ConsoleActivatedEventSchema,
  ConsoleExecuteParamsSchema,
  ConsoleExportParamsSchema,
  ConsoleResolveBannerParamsSchema,
  ConsoleRunSchema,
  ConsoleStateParamsSchema,
  ConsoleStateResultSchema,
  EditChangesParamsSchema,
  ExportCancelParamsSchema,
  ExportRunParamsSchema,
  FetchRowsParamsSchema,
  HandshakeResultSchema,
  PreviewChangesResultSchema,
  GetDdlParamsSchema,
  GetDdlResultSchema,
  RPC_PROTOCOL_VERSION,
  RevertChangesParamsSchema,
  RpcRequestSchema,
  RpcResponseSchema,
} from './index';

describe('RPC 帧校验', () => {
  it('合法请求帧可解析', () => {
    const frame = RpcRequestSchema.parse({ kind: 'req', id: 'wv-1', method: 'sys.handshake' });
    expect(frame.method).toBe('sys.handshake');
  });

  it('缺少 kind/id 的帧被拒绝', () => {
    expect(() => RpcRequestSchema.parse({ id: 'wv-1', method: 'sys.handshake' })).toThrow();
    expect(() => RpcRequestSchema.parse({ kind: 'req', method: 'sys.handshake' })).toThrow();
  });

  it('响应帧允许 result 与 error 语义', () => {
    const ok = RpcResponseSchema.parse({ kind: 'res', id: 'wv-1', ok: true, result: { a: 1 } });
    const bad = RpcResponseSchema.parse({
      kind: 'res',
      id: 'wv-1',
      ok: false,
      error: { code: 'E_TIMEOUT', message: '超时' },
    });
    expect(ok.ok).toBe(true);
    expect(bad.error?.code).toBe('E_TIMEOUT');
  });
});

describe('方法参数校验', () => {
  it('fetchRows：limit 上限 5000，超限拒绝', () => {
    const base = { connId: 'c1', db: 'demo', obj: 'users' };
    expect(FetchRowsParamsSchema.parse({ ...base, limit: 100 }).limit).toBe(100);
    expect(() => FetchRowsParamsSchema.parse({ ...base, limit: 5001 })).toThrow();
    expect(() => FetchRowsParamsSchema.parse({ ...base, limit: 0 })).toThrow();
  });

  it('fetchRows：缺少必填字段拒绝', () => {
    expect(() => FetchRowsParamsSchema.parse({ db: 'demo', obj: 'users', limit: 10 })).toThrow();
  });

  it('handshake：快照类型化（inserts/updates/deletes 结构校验）', () => {
    const result = HandshakeResultSchema.parse({
      protocolVersion: RPC_PROTOCOL_VERSION,
      viewId: 'c/db/t',
      params: { connId: 'c' },
      changeSet: {
        inserts: [{ tempId: 't1', values: { name: 'n' } }],
        updates: [{ rowKey: { id: 1 }, original: { id: 1 }, changes: { name: { old: 'a', new: 'b' } } }],
        deletes: [],
      },
      edit: { enabled: true },
    });
    expect(result.changeSet.updates[0].changes.name.new).toBe('b');
    expect(result.uiState).toBeUndefined();
    // 缺 edit 权限 → 拒绝（M4 起握手必带）
    expect(() =>
      HandshakeResultSchema.parse({
        protocolVersion: 1,
        viewId: 'v',
        params: {},
        changeSet: { inserts: [], updates: [], deletes: [] },
      }),
    ).toThrow();
  });

  it('editChanges：EditOp 判别联合（未知 op 拒绝）', () => {
    const base = { connId: 'c', db: 'demo', obj: 'users' };
    const p = EditChangesParamsSchema.parse({
      ...base,
      ops: [
        { op: 'setCell', rowKey: { id: 1 }, column: 'name', old: 'a', new: 'b' },
        { op: 'addRow', tempId: 't1', values: {} },
        { op: 'setInsertCell', tempId: 't1', column: 'name', value: 'x' },
        { op: 'removeRow', tempId: 't1' },
        { op: 'markDelete', rowKey: { id: 2 } },
        { op: 'unmarkDelete', rowKey: { id: 2 } },
        { op: 'revertRow', rowKey: { id: 3 } },
      ],
    });
    expect(p.ops).toHaveLength(7);
    expect(() => EditChangesParamsSchema.parse({ ...base, ops: [{ op: 'destroyAll' }] })).toThrow();
    expect(() =>
      EditChangesParamsSchema.parse({ ...base, ops: [{ op: 'setCell', rowKey: { id: 1 } }] }),
    ).toThrow();
  });

  it('editChanges：随行 uiState（drafts 形状）', () => {
    const p = EditChangesParamsSchema.parse({
      connId: 'c',
      db: 'demo',
      obj: 'users',
      ops: [],
      uiState: { page: 2, pageSize: 100, sorts: [{ column: 'id', dir: 'desc' }], search: 'k', drafts: [{ id: 'd1', column: 'name', op: 'eq', value: 'a', value2: '' }] },
    });
    expect(p.uiState?.page).toBe(2);
    expect(() =>
      EditChangesParamsSchema.parse({
        connId: 'c',
        db: 'demo',
        obj: 'users',
        ops: [],
        uiState: { page: -1, pageSize: 10, sorts: [], search: '', drafts: [] },
      }),
    ).toThrow();
  });

  it('previewChanges/applyChanges：语句项形状与回填主键', () => {
    const preview = PreviewChangesResultSchema.parse({
      items: [{ kind: 'update', rowKey: { id: 1 }, sql: 'UPDATE t SET a = ? WHERE id = ?', params: [1] }],
    });
    expect(preview.items[0].kind).toBe('update');
    expect(() =>
      PreviewChangesResultSchema.parse({ items: [{ kind: 'drop', sql: 'x' }] }),
    ).toThrow();
    const apply = ApplyChangesResultSchema.parse({
      items: [{ kind: 'insert', tempId: 't1', rowKey: { id: 61 }, sql: 'INSERT INTO t (a) VALUES (?)', affectedRows: 1 }],
      executionMs: 12,
    });
    expect(apply.items[0].rowKey).toEqual({ id: 61 });
  });

  it('getDdl：参数与结果形状', () => {
    const base = { connId: 'c', db: 'demo', obj: 'users' };
    expect(GetDdlParamsSchema.parse(base).obj).toBe('users');
    expect(() => GetDdlParamsSchema.parse({ connId: 'c', db: 'demo' })).toThrow();
    expect(GetDdlResultSchema.parse({ ddl: 'CREATE TABLE ...' }).ddl).toContain('CREATE');
    expect(() => GetDdlResultSchema.parse({})).toThrow();
  });

  it('revertChanges：scope 判别联合', () => {
    const base = { connId: 'c', db: 'demo', obj: 'users' };
    expect(RevertChangesParamsSchema.parse({ ...base, target: { scope: 'all' } }).target.scope).toBe('all');
    expect(
      RevertChangesParamsSchema.parse({ ...base, target: { scope: 'row', rowKey: { id: 1 } } }).target,
    ).toEqual({ scope: 'row', rowKey: { id: 1 } });
    expect(
      RevertChangesParamsSchema.parse({ ...base, target: { scope: 'insert', tempId: 't1' } }).target,
    ).toEqual({ scope: 'insert', tempId: 't1' });
    expect(() => RevertChangesParamsSchema.parse({ ...base, target: { scope: 'nope' } })).toThrow();
  });

  it('fetchRows：filters/sorts/search 合法形状可通过', () => {
    const base = { connId: 'c1', db: 'demo', obj: 'users' };
    const parsed = FetchRowsParamsSchema.parse({
      ...base,
      limit: 50,
      columns: ['id', 'name'],
      filters: [
        { column: 'status', op: 'eq', value: 'active' },
        { column: 'age', op: 'between', values: [1, 9] },
        { column: 'note', op: 'isNull' },
      ],
      sorts: [{ column: 'id', dir: 'desc' }],
      search: '张',
    });
    expect(parsed.filters).toHaveLength(3);
    expect(parsed.sorts?.[0]?.dir).toBe('desc');
  });

  it('fetchRows：非法 FilterOp / 缺少 dir / 超量 filters 拒绝', () => {
    const base = { connId: 'c1', db: 'demo', obj: 'users', limit: 50 };
    expect(() =>
      FetchRowsParamsSchema.parse({ ...base, filters: [{ column: 'a', op: 'regex', value: 'x' }] }),
    ).toThrow();
    expect(() =>
      FetchRowsParamsSchema.parse({ ...base, sorts: [{ column: 'a', dir: 'up' }] }),
    ).toThrow();
    expect(() =>
      FetchRowsParamsSchema.parse({
        ...base,
        filters: Array.from({ length: 21 }, (_, i) => ({ column: `c${i}`, op: 'eq', value: 1 })),
      }),
    ).toThrow();
  });

  it('export.run：format/scope 枚举校验', () => {
    const base = { connId: 'c1', db: 'demo', obj: 'users' };
    expect(ExportRunParamsSchema.parse({ ...base, format: 'csv', scope: 'result' }).format).toBe('csv');
    expect(() => ExportRunParamsSchema.parse({ ...base, format: 'xlsx', scope: 'result' })).toThrow();
    expect(() => ExportRunParamsSchema.parse({ ...base, format: 'csv', scope: 'all' })).toThrow();
  });

  it('export.cancel：exportId 必填', () => {
    expect(ExportCancelParamsSchema.parse({ exportId: 'e1' }).exportId).toBe('e1');
    expect(() => ExportCancelParamsSchema.parse({})).toThrow();
  });

  it('conn.test：password 必须显式 nullable（沿用已存密码语义）', () => {
    const base = { driverId: 'mysql', options: { host: '127.0.0.1' } };
    expect(ConnTestParamsSchema.parse({ ...base, password: null }).password).toBeNull();
    expect(ConnTestParamsSchema.parse({ ...base, password: 's3cret' }).password).toBe('s3cret');
    expect(() => ConnTestParamsSchema.parse({ ...base })).toThrow();
  });

  it('conn.save：name 必填非空', () => {
    const base = { driverId: 'mysql', options: {}, password: null };
    expect(ConnSaveParamsSchema.parse({ ...base, name: '本地 MySQL' }).name).toBe('本地 MySQL');
    expect(() => ConnSaveParamsSchema.parse({ ...base, name: '' })).toThrow();
    expect(() => ConnSaveParamsSchema.parse({ ...base })).toThrow();
  });

  it('console.execute：sql 必填且有长度上限', () => {
    expect(ConsoleExecuteParamsSchema.parse({ consoleId: 'c1', sql: 'SELECT 1' }).sql).toBe('SELECT 1');
    expect(() => ConsoleExecuteParamsSchema.parse({ consoleId: 'c1' })).toThrow();
    expect(() => ConsoleExecuteParamsSchema.parse({ consoleId: 'c1', sql: '' })).toThrow();
    expect(() => ConsoleExecuteParamsSchema.parse({ consoleId: 'c1', sql: 'x'.repeat(200_001) })).toThrow();
  });

  it('console.resolveBanner：action 枚举校验', () => {
    const base = { consoleId: 'c1', bannerId: 'b1' };
    expect(ConsoleResolveBannerParamsSchema.parse({ ...base, action: 'proceed' }).action).toBe('proceed');
    expect(ConsoleResolveBannerParamsSchema.parse({ ...base, action: 'cancel' }).action).toBe('cancel');
    expect(() => ConsoleResolveBannerParamsSchema.parse({ ...base, action: 'ignore' })).toThrow();
  });

  it('console.run：running 状态与结果项校验（多结果 Tab 形状）', () => {
    const run = ConsoleRunSchema.parse({
      consoleId: 'c1',
      runId: 'r1',
      startedAt: 1,
      durationMs: 12,
      status: 'running',
      items: [
        { seq: 1, sql: 'SELECT 1', executionMs: 5, resultSet: { columns: [], rows: [], rowCount: 0, executionMs: 5 } },
        { seq: 2, sql: 'UPDATE t SET a=1', executionMs: 7, affectedRows: 3 },
      ],
    });
    expect(run.items[0].resultSet?.rowCount).toBe(0);
    expect(run.items[1].affectedRows).toBe(3);
    expect(() =>
      ConsoleRunSchema.parse({ consoleId: 'c1', runId: 'r1', startedAt: 1, durationMs: 1, status: 'paused', items: [] }),
    ).toThrow();
  });

  it('console.banner：reasons 非空数组', () => {
    expect(ConsoleBannerSchema.parse({ bannerId: 'b1', reasons: ['UPDATE 无 WHERE'], sql: 'UPDATE t SET a=1' }).reasons).toHaveLength(1);
    expect(() => ConsoleBannerSchema.parse({ bannerId: 'b1', reasons: [], sql: 'x' })).toThrow();
  });

  it('console.export：itemSeq 必须为正整数', () => {
    const base = { consoleId: 'c1', format: 'csv' as const };
    expect(ConsoleExportParamsSchema.parse({ ...base, itemSeq: 2 }).itemSeq).toBe(2);
    expect(() => ConsoleExportParamsSchema.parse({ ...base, itemSeq: 0 })).toThrow();
  });

  it('console.getState：consoleId 允许空串（底部面板「最近执行」引导路径）', () => {
    expect(ConsoleStateParamsSchema.parse({ consoleId: '' }).consoleId).toBe('');
    expect(ConsoleStateResultSchema.parse({ consoleId: '', bound: false }).bound).toBe(false);
  });

  it('evt:console.activated：负载为 consoleId（可空串）', () => {
    expect(ConsoleActivatedEventSchema.parse({ consoleId: 'console-2' }).consoleId).toBe('console-2');
    expect(ConsoleActivatedEventSchema.parse({ consoleId: '' }).consoleId).toBe('');
  });

  it('协议版本常量为 1', () => {
    expect(RPC_PROTOCOL_VERSION).toBe(1);
  });
});
