import { expect, it } from 'vitest';
import { createMockDriver } from '@db-explorer/driver-mock';
import { runConnectionChecks, runMetadataChecks } from './index';

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
