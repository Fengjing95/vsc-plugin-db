import { describe, expect, it } from 'vitest';
import {
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

  it('响应帧允许 result 与 error 互斥语义存在', () => {
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

  it('协议版本常量为 1', () => {
    expect(RPC_PROTOCOL_VERSION).toBe(1);
  });
});
