import { expect, it } from 'vitest';
import { createMockDriver } from '@db-explorer/driver-mock';
import { runConnectionChecks } from './index';

/** 套件自身冒烟：mock 驱动必须全过 connection 组 */
it('conformance: mock 驱动通过 connection 组', async () => {
  const summary = await runConnectionChecks(() =>
    createMockDriver().connect(
      {
        id: 'conformance-mock',
        name: 'mock',
        driverId: 'mock',
        options: {},
        secretRef: 'dbExplorer.secrets.conformance-mock',
      },
      '',
    ),
  );

  expect(summary.failed).toBe(0);
  expect(summary.results).toHaveLength(3);
});
