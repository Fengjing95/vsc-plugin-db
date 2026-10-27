import { describe, expect, it, vi } from 'vitest';
import { executeCancelable } from './index';
import { toDriverError } from './sql';

type Executor = { query(opts: { sql: string; values?: unknown[] }): Promise<[unknown, unknown]> };

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const REQ = { sql: 'SELECT SLEEP(3)', maxRows: 10, timeoutMs: 0 };

describe('executeCancelable（驱动规范 §7 取消/超时，pg runCancelableOn 同构）', () => {
  it('预中止 signal → E_CANCELED 且 SQL 不下发', async () => {
    const ac = new AbortController();
    ac.abort();
    const executor: Executor = { query: vi.fn(() => deferred<[unknown, unknown]>().promise) };
    await expect(
      executeCancelable(executor, { ...REQ, signal: ac.signal }, undefined),
    ).rejects.toMatchObject({ code: 'E_CANCELED' });
    expect(executor.query).not.toHaveBeenCalled();
  });

  it('在途 abort → E_CANCELED，KILL 以 threadId 定向，cancelSettle 待结算', async () => {
    const ac = new AbortController();
    const d = deferred<[unknown, unknown]>();
    const executor: Executor = { query: vi.fn(() => d.promise) };
    const cancelServer = vi.fn();
    const pending = executeCancelable(executor, { ...REQ, signal: ac.signal }, {
      threadId: 42,
      cancelServer,
    });
    ac.abort();
    await expect(pending).rejects.toMatchObject({ code: 'E_CANCELED' });
    expect(cancelServer).toHaveBeenCalledWith(42);
    const settle = (executor as { cancelSettle?: Promise<unknown> }).cancelSettle;
    expect(settle).toBeInstanceOf(Promise);
    // 服务端 1317 迟到回包：被 settle 链消费不外泄（泄漏即 vitest unhandled rejection 红）
    d.reject(Object.assign(new Error('Query execution was interrupted'), { code: 'ER_QUERY_INTERRUPTED' }));
    await settle;
  });

  it('timeoutMs 死线 → E_TIMEOUT 且请求服务端取消', async () => {
    vi.useFakeTimers();
    try {
      const executor: Executor = { query: () => deferred<[unknown, unknown]>().promise };
      const cancelServer = vi.fn();
      const pending = executeCancelable(executor, { ...REQ, timeoutMs: 5_000 }, {
        threadId: 7,
        cancelServer,
      });
      const assertion = expect(pending).rejects.toMatchObject({ code: 'E_TIMEOUT' });
      await vi.advanceTimersByTimeAsync(5_001);
      await assertion;
      expect(cancelServer).toHaveBeenCalledWith(7);
    } finally {
      vi.useRealTimers();
    }
  });

  it('无 signal/无 timeout 快路径直通结果', async () => {
    const executor: Executor = { query: vi.fn(async (): Promise<[unknown, unknown]> => [[{ id: 1 }], []]) };
    await expect(executeCancelable(executor, { ...REQ }, undefined)).resolves.toEqual([
      [{ id: 1 }],
      [],
    ]);
  });

  it('自然完成先于 abort → 结算以查询结果为准（abort 不改写已结算 promise）', async () => {
    const ac = new AbortController();
    const d = deferred<[unknown, unknown]>();
    const executor: Executor = { query: () => d.promise };
    const pending = executeCancelable(executor, { ...REQ, signal: ac.signal }, undefined);
    d.resolve([[{ id: 1 }], []]);
    await expect(pending).resolves.toEqual([[{ id: 1 }], []]);
    // 查询已自然结算后 abort：cancelSettle 未记录（未进取消路径）、信号监听已摘除
    ac.abort();
    expect((executor as { cancelSettle?: Promise<unknown> }).cancelSettle).toBeUndefined();
  });
});

describe('toDriverError 取消映射（§6 映射表）', () => {
  it('ER_QUERY_INTERRUPTED(1317) → E_CANCELED', () => {
    const mapped = toDriverError(
      Object.assign(new Error('Query execution was interrupted'), { code: 'ER_QUERY_INTERRUPTED' }),
    );
    expect(mapped.code).toBe('E_CANCELED');
  });
});
