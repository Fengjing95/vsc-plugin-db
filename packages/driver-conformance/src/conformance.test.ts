import { expect, it } from 'vitest';
import { createMockDriver } from '@db-explorer/driver-mock';
import {
  runConnectionChecks,
  runFilterPushdownChecks,
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
  // 13 个 FilterOp + 组合 + search
  expect(summary.results.filter((r) => !r.skipped)).toHaveLength(15);
});
