import { describe, expect, it } from 'vitest';
import { DriverError } from './errors';
import { InProcessDriverHost } from './host';
import type { FetchRowsRequest, ResultSet } from '../model/rows';
import type { IConnection } from './types';

function fakeConnection(impl: Partial<IConnection>): IConnection {
  return {
    connectionId: 'test',
    ping: async () => undefined,
    listDatabases: async () => [],
    listObjects: async () => [],
    listColumns: async () => [],
    fetchRows: async (_req: FetchRowsRequest) => ({ columns: [], rows: [], rowCount: 0, executionMs: 0 }),
    query: async () => [],
    previewChanges: async () => [],
    applyChanges: async () => ({ items: [], executionMs: 0 }),
    getCompletionSource: async () => ({
      keywords: [],
      functions: [],
      databases: [],
      tables: [],
      columns: [],
    }),
    dispose: () => undefined,
    ...impl,
  } as IConnection;
}

describe('InProcessDriverHost', () => {
  it('透传结果集', async () => {
    const host = new InProcessDriverHost();
    const rs: ResultSet = {
      columns: [{ name: 'id', type: 'integer' }],
      rows: [[1]],
      rowCount: 1,
      executionMs: 1,
    };
    const conn = fakeConnection({ fetchRows: async () => rs });

    const out = await host.fetchRows(conn, { db: 'demo', obj: 'users', limit: 1 });
    expect(out.rowCount).toBe(1);
  });

  it('超时 → E_TIMEOUT，并触发底层 signal 中止', async () => {
    const host = new InProcessDriverHost();
    let aborted = false;
    const conn = fakeConnection({
      fetchRows: (_req) =>
        new Promise<ResultSet>((_, reject) => {
          _req.signal?.addEventListener('abort', () => {
            aborted = true;
          });
          void reject; // 永不 resolve，模拟慢查询
        }),
    });

    await expect(
      host.fetchRows(conn, { db: 'demo', obj: 'big', limit: 1, timeoutMs: 20 }),
    ).rejects.toMatchObject({ code: 'E_TIMEOUT' });
    // 给 abort 传播留一个微任务周期
    await new Promise((r) => setTimeout(r, 5));
    expect(aborted).toBe(true);
  });

  it('外部 signal 已取消 → E_CANCELED，不触达驱动', async () => {
    const host = new InProcessDriverHost();
    let called = false;
    const conn = fakeConnection({
      fetchRows: async () => {
        called = true;
        return { columns: [], rows: [], rowCount: 0, executionMs: 0 };
      },
    });
    const controller = new AbortController();
    controller.abort();

    const err = await host
      .applyChanges(
        conn,
        'demo',
        'users',
        { inserts: [], updates: [], deletes: [] },
        { timeoutMs: 1000, signal: controller.signal },
      )
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(DriverError.is(err)).toBe(true);
    expect(err && DriverError.is(err) && err.code).toBe('E_CANCELED');
    expect(called).toBe(false);
  });
});
