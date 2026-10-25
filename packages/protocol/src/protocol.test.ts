import { describe, expect, it } from 'vitest';
import {
  ApplyChangesResultSchema,
  CellFetchParamsSchema,
  CellFetchResultSchema,
  ConnDbOptionsParamsSchema,
  ConnDbOptionsResultSchema,
  ConnSaveParamsSchema,
  ConnTestParamsSchema,
  AiApplyFixParamsSchema,
  AiFixErrorParamsSchema,
  AiFixErrorResultSchema,
  AiSaveSettingsParamsSchema,
  AiSettingsResultSchema,
  AiTestSettingsParamsSchema,
  ConsoleAiEventSchema,
  ConsoleAiSchema,
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
  SETTINGS_ALLOWED_KEYS,
  SETTINGS_KEY_TYPES,
  SettingsGetResultSchema,
  SettingsHubActionParamsSchema,
  SettingsOpenInVscodeParamsSchema,
  SysSaveFileParamsSchema,
  SysSaveFileResultSchema,
  SettingsUpdateParamsSchema,
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
      capabilities: { supportsSQL: true, supportsDdl: true },
    });
    expect(result.changeSet.updates[0].changes.name.new).toBe('b');
    expect(result.uiState).toBeUndefined();
    expect(result.capabilities.supportsSQL).toBe(true);
    // 缺 edit 权限 → 拒绝（M4 起握手必带）；缺 capabilities 同样拒绝（M6 起必带）
    expect(() =>
      HandshakeResultSchema.parse({
        protocolVersion: 1,
        viewId: 'v',
        params: {},
        changeSet: { inserts: [], updates: [], deletes: [] },
      }),
    ).toThrow();
    expect(() =>
      HandshakeResultSchema.parse({
        protocolVersion: 1,
        viewId: 'v',
        params: {},
        changeSet: { inserts: [], updates: [], deletes: [] },
        edit: { enabled: false },
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
    // M7/D-14：xlsx 成为合法导出格式
    expect(ExportRunParamsSchema.parse({ ...base, format: 'xlsx', scope: 'result' }).format).toBe('xlsx');
    // 单元格查看器批次②：NDJSON / Markdown / SQL INSERT 文件导出（§5.7 P2 收口）
    expect(ExportRunParamsSchema.parse({ ...base, format: 'ndjson', scope: 'result' }).format).toBe('ndjson');
    expect(ExportRunParamsSchema.parse({ ...base, format: 'markdown', scope: 'result' }).format).toBe('markdown');
    expect(ExportRunParamsSchema.parse({ ...base, format: 'insert', scope: 'result' }).format).toBe('insert');
    expect(() => ExportRunParamsSchema.parse({ ...base, format: 'pdf', scope: 'result' })).toThrow();
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

  it('conn.dbOptions：password nullable 同 conn.test；结果恒为数组（M8-PG B5）', () => {
    const base = { driverId: 'postgres', options: { host: '127.0.0.1' } };
    expect(ConnDbOptionsParamsSchema.parse({ ...base, password: null }).password).toBeNull();
    expect(ConnDbOptionsParamsSchema.parse({ ...base, password: 's3cret' }).password).toBe('s3cret');
    expect(() => ConnDbOptionsParamsSchema.parse({ ...base })).toThrow();
    expect(ConnDbOptionsResultSchema.parse({ databases: ['postgres', 'app'] }).databases).toHaveLength(2);
    expect(ConnDbOptionsResultSchema.parse({ databases: [] }).databases).toHaveLength(0);
    expect(() => ConnDbOptionsResultSchema.parse({})).toThrow();
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

describe('settings.* 方法校验（设置中心）', () => {
  it('settings.get：返回版本与配置值映射', () => {
    const parsed = SettingsGetResultSchema.parse({ version: '0.4.0', values: { 'dbExplorer.query.maxRows': 500 } });
    expect(parsed.version).toBe('0.4.0');
    expect(parsed.values['dbExplorer.query.maxRows']).toBe(500);
  });

  it('settings.update：key 只接受白名单内配置键', () => {
    expect(() => SettingsUpdateParamsSchema.parse({ key: 'dbExplorer.query.maxRows', value: 500 })).not.toThrow();
    expect(() => SettingsUpdateParamsSchema.parse({ key: 'editor.fontSize', value: 14 })).toThrow();
    expect(() => SettingsUpdateParamsSchema.parse({ key: 'dbExplorer.ai.endpoint', value: 'x' })).toThrow();
  });

  it('settings.openInVscodeSettings / hubAction：key 与 action 均为枚举', () => {
    expect(SettingsOpenInVscodeParamsSchema.parse({ key: 'dbExplorer.export.defaultFormat' }).key).toBe(
      'dbExplorer.export.defaultFormat',
    );
    expect(() => SettingsOpenInVscodeParamsSchema.parse({ key: 'other.key' })).toThrow();
    expect(SettingsHubActionParamsSchema.parse({ action: 'openLog' }).action).toBe('openLog');
    expect(() => SettingsHubActionParamsSchema.parse({ action: 'deleteAll' })).toThrow();
  });

  it('白名单键的类型清单完整对齐', () => {
    expect(Object.keys(SETTINGS_KEY_TYPES)).toEqual([...SETTINGS_ALLOWED_KEYS]);
  });
});

describe('ai.* 方法校验（M9-AI / D-24）', () => {
  it('ai.getSettings：只回 endpoint/model/hasKey（密钥永不回传）', () => {
    const parsed = AiSettingsResultSchema.parse({ endpoint: 'https://x/v1', model: 'm', hasKey: true });
    expect(parsed.hasKey).toBe(true);
    expect(Object.keys(parsed).sort()).toEqual(['endpoint', 'hasKey', 'model']);
  });

  it('ai.saveSettings：apiKey/clearKey 可缺省（缺省 = 不修改已存密钥）', () => {
    const minimal = AiSaveSettingsParamsSchema.parse({ endpoint: 'https://x/v1', model: 'm' });
    expect(minimal.apiKey).toBeUndefined();
    expect(minimal.clearKey).toBeUndefined();
    expect(AiSaveSettingsParamsSchema.parse({ endpoint: 'e', model: 'm', apiKey: 'sk-1' }).apiKey).toBe('sk-1');
    expect(
      AiSaveSettingsParamsSchema.parse({ endpoint: 'e', model: 'm', clearKey: true }).clearKey,
    ).toBe(true);
  });

  it('ai.testSettings 与 saveSettings 同形（按表单当前值测试）', () => {
    expect(AiTestSettingsParamsSchema).toBe(AiSaveSettingsParamsSchema);
  });

  it('ai.fixError：consoleId + 正整数 seq', () => {
    expect(AiFixErrorParamsSchema.parse({ consoleId: 'c1', seq: 3 }).seq).toBe(3);
    expect(() => AiFixErrorParamsSchema.parse({ consoleId: 'c1', seq: 0 })).toThrow();
  });

  it('ai.fixError 结果：fixId + 原/建议 SQL + 可选 note', () => {
    const parsed = AiFixErrorResultSchema.parse({
      fixId: 'fix-1',
      originalSql: 'SELECT',
      suggestedSql: 'SELECT 1',
    });
    expect(parsed.note).toBeUndefined();
    expect(
      AiFixErrorResultSchema.parse({ fixId: 'f', originalSql: 'a', suggestedSql: 'b', note: '缺列' }).note,
    ).toBe('缺列');
  });

  it('ai.applyFix：mode 只接受 replace/insert', () => {
    expect(AiApplyFixParamsSchema.parse({ fixId: 'f', mode: 'replace' }).mode).toBe('replace');
    expect(() => AiApplyFixParamsSchema.parse({ fixId: 'f', mode: 'execute' })).toThrow();
  });

  it('ConsoleRun.documentBound 可选（有文档来源的执行标记）', () => {
    const base = {
      consoleId: 'c1',
      runId: 'r1',
      startedAt: 1,
      durationMs: 1,
      status: 'ok' as const,
      items: [],
    };
    expect(ConsoleRunSchema.parse(base).documentBound).toBeUndefined();
    expect(ConsoleRunSchema.parse({ ...base, documentBound: true }).documentBound).toBe(true);
  });

  it('ConsoleStateResult.ai 与 evt:console.ai：解释流式状态可解析，null 表示已清除', () => {
    const running = { seq: 1, status: 'running' as const, content: '部分' };
    expect(ConsoleStateResultSchema.parse({ consoleId: 'c1', bound: true, ai: running }).ai).toEqual(running);
    expect(ConsoleStateResultSchema.parse({ consoleId: 'c1', bound: true, ai: null }).ai).toBeNull();
    expect(ConsoleStateResultSchema.parse({ consoleId: 'c1', bound: true }).ai).toBeUndefined();
    expect(ConsoleAiEventSchema.parse({ consoleId: 'c1', ai: running }).ai).toEqual(running);
    expect(ConsoleAiEventSchema.parse({ consoleId: 'c1', ai: null }).ai).toBeNull();
    expect(() => ConsoleAiSchema.parse({ seq: 1, status: 'paused', content: '' })).toThrow();
  });
});

describe('cell.fetch / sys.saveFile（单元格查看器批次）', () => {
  it('cell.fetch：rowKey + column 定位，value 为 C-7 单元格同形值', () => {
    const params = { connId: 'c1', db: 'demo', obj: 'wide', rowKey: { id: 1 }, column: 'meta' };
    expect(CellFetchParamsSchema.parse(params)).toEqual(params);
    expect(() => CellFetchParamsSchema.parse({ ...params, column: '' })).toThrow();
    expect(() => CellFetchParamsSchema.parse({ ...params, rowKey: undefined })).toThrow();
    expect(CellFetchResultSchema.parse({ value: null }).value).toBeNull();
    expect(CellFetchResultSchema.parse({ value: { a: 1 } }).value).toEqual({ a: 1 });
    expect(CellFetchResultSchema.parse({ value: 'aGVsbG8=' }).value).toBe('aGVsbG8=');
  });

  it('sys.saveFile：base64 + defaultName 必填，取消返回 path=null', () => {
    const params = { defaultName: 'avatar.bin', base64: 'aGVsbG8=' };
    expect(SysSaveFileParamsSchema.parse(params)).toEqual(params);
    expect(SysSaveFileParamsSchema.parse({ ...params, title: '另存为' }).title).toBe('另存为');
    expect(() => SysSaveFileParamsSchema.parse({ defaultName: '', base64: 'aGk=' })).toThrow();
    expect(SysSaveFileResultSchema.parse({ path: '/tmp/avatar.bin' }).path).toBe('/tmp/avatar.bin');
    expect(SysSaveFileResultSchema.parse({ path: null }).path).toBeNull();
  });

  it('handshake capabilities.lazyCell 可选下行（查看器是否走按需拉取）', () => {
    const base = {
      protocolVersion: RPC_PROTOCOL_VERSION,
      viewId: 'c/db/t',
      params: { connId: 'c' },
      changeSet: { inserts: [], updates: [], deletes: [] },
      edit: { enabled: true },
      capabilities: { supportsSQL: true, supportsDdl: true },
    };
    expect(HandshakeResultSchema.parse(base).capabilities.lazyCell).toBeUndefined();
    expect(
      HandshakeResultSchema.parse({ ...base, capabilities: { ...base.capabilities, lazyCell: true } }).capabilities
        .lazyCell,
    ).toBe(true);
  });
});
