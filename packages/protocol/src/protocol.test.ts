import { describe, expect, it } from 'vitest';
import {
  ConnSaveParamsSchema,
  ConnTestParamsSchema,
  ExportCancelParamsSchema,
  ExportRunParamsSchema,
  FetchRowsParamsSchema,
  RPC_PROTOCOL_VERSION,
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

  it('协议版本常量为 1', () => {
    expect(RPC_PROTOCOL_VERSION).toBe(1);
  });
});
