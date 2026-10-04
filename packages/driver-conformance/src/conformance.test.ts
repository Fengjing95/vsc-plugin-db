import { expect, it } from 'vitest';
import { createMockDriver } from '@db-explorer/driver-mock';
import {
  runChangesetChecks,
  runConnectionChecks,
  runFilterPushdownChecks,
  runInteractiveTransactionChecks,
  runMetadataChecks,
  runPaginationChecks,
} from './index';

function mockConnection() {
  return createMockDriver().connect(
    {
      id: 'conformance-mock',
      name: 'mock',
      driverId: 'mock',
      options: {},
      secretRef: 'dbExplorer.secrets.conformance-mock',
    },
    '',
  );
}

/** 套件自身冒烟：mock 驱动必须全过全部契约组 */
it('conformance: mock 驱动通过 connection 组', async () => {
  const summary = await runConnectionChecks(mockConnection);
  expect(summary.failed).toBe(0);
  expect(summary.results).toHaveLength(3);
});

it('conformance: mock 驱动通过 metadata 组（M2）', async () => {
  const summary = await runMetadataChecks(mockConnection);
  expect(summary.failed).toBe(0);
  expect(summary.results.length).toBeGreaterThanOrEqual(5);
});

it('conformance: mock 驱动通过 pagination 组（M3）', async () => {
  const summary = await runPaginationChecks(mockConnection);
  expect(summary.failed).toBe(0);
  expect(summary.results.filter((r) => !r.skipped)).toHaveLength(4);
});

it('conformance: mock 驱动通过 filter-pushdown 组（M3）', async () => {
  const summary = await runFilterPushdownChecks(mockConnection);
  expect(summary.failed).toBe(0);
  // 13 个 FilterOp + 组合 + search + whereSql 拼接
  expect(summary.results.filter((r) => !r.skipped)).toHaveLength(16);
});

it('conformance: mock 驱动通过 changeset 组（M4）', async () => {
  const summary = await runChangesetChecks(mockConnection);
  if (summary.failed > 0) {
    console.error(JSON.stringify(summary.results.filter((r) => !r.ok), null, 2));
  }
  expect(summary.failed).toBe(0);
  expect(summary.results.filter((r) => !r.skipped)).toHaveLength(5);
});

it('conformance: mock 驱动通过 interactive-transaction 组（M7，D-09）', async () => {
  const summary = await runInteractiveTransactionChecks(mockConnection, {
    insertSql: (k) =>
      `INSERT INTO demo.users (name, email) VALUES ('txn:${k}', 'txn:${k}@conformance')`,
    countSql: (k) => `SELECT COUNT(*) FROM demo.users WHERE email = 'txn:${k}@conformance'`,
    cleanupSql: (k) => `DELETE FROM demo.users WHERE email = 'txn:${k}@conformance'`,
  });
  if (summary.failed > 0) {
    console.error(JSON.stringify(summary.results.filter((r) => !r.ok), null, 2));
  }
  expect(summary.failed).toBe(0);
  // C-3：组必须实跑（mock 已实现交互式事务）而非静默跳过
  expect(summary.results.filter((r) => !r.skipped)).toHaveLength(5);
});
