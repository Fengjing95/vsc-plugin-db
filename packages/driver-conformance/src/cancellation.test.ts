import { expect, it } from 'vitest';
import { DriverError, type IConnection, type QueryRequest, type ResultSet } from '@db-explorer/core';
import { runCancellationChecks } from './index';

/**
 * 取消契约组自身逻辑的红绿验证（C-3）：
 * mock 驱动未声明 supportsCancel（组按能力跳过），组逻辑用 stub 连接验证——
 * 真实响应 AbortSignal 的实现必须全绿，虚报 supportsCancel 的实现必须红。
 */

const LONG_SQL = (seconds: number) => `SELECT pg_sleep(${seconds})`;
const PROBE_SQL = 'SELECT 1 AS one';

interface StubBehavior {
  /** 预中止 signal 是否在 SQL 下发前拒绝 */
  honorPreAbort: boolean;
  /** 在途查询是否响应 abort */
  honorInFlight: boolean;
}

function stubConnection(behavior: StubBehavior): IConnection {
  const okResult = (): ResultSet[] => [{ columns: [{ name: 'one', type: 'integer' }], rows: [[1]], rowCount: 1, executionMs: 1 }];
  const canceled = (): DriverError => new DriverError('E_CANCELED', '查询已取消');

  const query = async (req: QueryRequest): Promise<ResultSet[]> => {
    if (req.signal?.aborted) {
      if (behavior.honorPreAbort) throw canceled();
      return okResult(); // 虚报：无视已中止的 signal
    }
    if (req.sql.startsWith('SELECT 1')) {
      return okResult(); // 复用探针：立即返回
    }
    if (behavior.honorInFlight) {
      // 模拟长查询：3s 后自然完成；abort 事件先到则以 E_CANCELED 拒绝
      return new Promise<ResultSet[]>((resolve, reject) => {
        const timer = setTimeout(() => resolve(okResult()), 3000);
        req.signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(canceled());
        }, { once: true });
      });
    }
    return okResult(); // 虚报：在途不响应 abort
  };

  return {
    connectionId: 'stub-cancel',
    ping: async () => undefined,
    listDatabases: async () => [{ name: 'db' }],
    listObjects: async () => [],
    listColumns: async () => [],
    fetchRows: async () => ({ columns: [], rows: [], rowCount: 0, executionMs: 0 }),
    query,
    previewChanges: async () => [],
    applyChanges: async () => ({ items: [], executionMs: 0 }),
    dispose: async () => undefined,
  } as unknown as IConnection;
}

it('取消组：真实响应 AbortSignal 的实现全绿', async () => {
  const summary = await runCancellationChecks(
    () => Promise.resolve(stubConnection({ honorPreAbort: true, honorInFlight: true })),
    { supportsCancel: true, longQuerySql: LONG_SQL, probeSql: PROBE_SQL },
  );
  if (summary.failed > 0) {
    console.error(JSON.stringify(summary.results.filter((r) => !r.ok), null, 2));
  }
  expect(summary.failed).toBe(0);
  expect(summary.results.filter((r) => !r.skipped)).toHaveLength(3);
});

it('取消组：在途不响应 abort（虚报 supportsCancel）必须红', async () => {
  const summary = await runCancellationChecks(
    () => Promise.resolve(stubConnection({ honorPreAbort: true, honorInFlight: false })),
    { supportsCancel: true, longQuerySql: LONG_SQL, probeSql: PROBE_SQL },
  );
  expect(summary.failed).toBeGreaterThan(0);
  expect(summary.results.find((r) => r.name.includes('在途查询'))?.ok).toBe(false);
});

it('取消组：预中止 signal 不拒绝（缺 SQL 下发前检查点）必须红', async () => {
  const summary = await runCancellationChecks(
    () => Promise.resolve(stubConnection({ honorPreAbort: false, honorInFlight: true })),
    { supportsCancel: true, longQuerySql: LONG_SQL, probeSql: PROBE_SQL },
  );
  expect(summary.failed).toBeGreaterThan(0);
  expect(summary.results.find((r) => r.name.includes('预中止'))?.ok).toBe(false);
});

it('取消组：未声明 supportsCancel 整组跳过', async () => {
  const summary = await runCancellationChecks(
    () => Promise.resolve(stubConnection({ honorPreAbort: false, honorInFlight: false })),
    { supportsCancel: false, longQuerySql: LONG_SQL, probeSql: PROBE_SQL },
  );
  expect(summary.failed).toBe(0);
  expect(summary.results.every((r) => r.skipped)).toBe(true);
});
