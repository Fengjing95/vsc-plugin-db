import { expect, it } from 'vitest';
import { createMockDriver } from '@db-explorer/driver-mock';
import {
  runCancellationChecks,
  runChangesetChecks,
  runConnectionChecks,
  runDdlChecks,
  runFilterPushdownChecks,
  runInteractiveTransactionChecks,
  runMetadataChecks,
  runPaginationChecks,
  runRelationGraphChecks,
  runSqlValueEncodingChecks,
  type SqlValueEncodingCase,
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

it('conformance: mock 驱动通过 ddl 组（M8-B2，表结构编辑）', async () => {
  const summary = await runDdlChecks(mockConnection);
  if (summary.failed > 0) {
    console.error(JSON.stringify(summary.results.filter((r) => !r.ok), null, 2));
  }
  expect(summary.failed).toBe(0);
  // C-3：组必须实跑（mock 声明 supportsDdlEditor + listKeys/listIndexes）而非静默跳过；
  // create 一致 / 加列改注释 / 删列 / 主键变更 / 无差异 / 键外键索引建读一致 / 增删唯一键 /
  // 增删索引 / 增删外键 / 防误删红线 / 两段清理 / 非法标识符
  expect(summary.results.filter((r) => !r.skipped)).toHaveLength(13);
});

it('conformance: mock 驱动通过 relation-graph 组（M8-ER，D-22）', async () => {
  const summary = await runRelationGraphChecks(mockConnection);
  if (summary.failed > 0) {
    console.error(JSON.stringify(summary.results.filter((r) => !r.ok), null, 2));
  }
  expect(summary.failed).toBe(0);
  // C-3：组必须实跑（mock 声明 supportsErDiagram + listKeys）——fixture / 表集列形状 / FK 边 / selection / 清理
  expect(summary.results.filter((r) => !r.skipped)).toHaveLength(5);
});

/** mock 基准值编码用例（§5 编码形态写入→读回；dataType 为驱动方言原文） */
const MOCK_VE_CASES: SqlValueEncodingCase[] = [
  { column: 'c_str', dataType: 'varchar(64)', write: "it's ✓ 汉" },
  { column: 'c_empty', dataType: 'varchar(64)', write: '' },
  { column: 'c_int', dataType: 'bigint', write: 42 },
  { column: 'c_bigint', dataType: 'bigint', write: '9007199254740993' },
  { column: 'c_dec', dataType: 'decimal(32,9)', write: '12345678901234567890.123456789' },
  { column: 'c_float', dataType: 'double', write: 1.5 },
  { column: 'c_bool', dataType: 'boolean', write: true },
  { column: 'c_date', dataType: 'date', write: '2024-06-01' },
  { column: 'c_time', dataType: 'time', write: '08:30:00.000' },
  { column: 'c_dt', dataType: 'datetime', write: '2024-06-01 08:30:00.000' },
  { column: 'c_json', dataType: 'json', write: { k: 1, arr: [1, 2, null], s: '汉' } },
  { column: 'c_bin', dataType: 'bytea', write: 'AAEC/w==' },
  { column: 'c_uuid', dataType: 'varchar(36)', write: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11' },
];

it('conformance: mock 驱动通过 sql-value-encoding 组（M8-PG，§5 编码往返）', async () => {
  const summary = await runSqlValueEncodingChecks(mockConnection, { db: 'demo', cases: MOCK_VE_CASES });
  if (summary.failed > 0) {
    console.error(JSON.stringify(summary.results.filter((r) => !r.ok), null, 2));
  }
  expect(summary.failed).toBe(0);
  // C-3：组必须实跑（mock 已实现 buildCreateTable/applyChanges）——类型用例 + NULL 行 + 清理
  expect(summary.results.filter((r) => !r.skipped)).toHaveLength(MOCK_VE_CASES.length + 2);
});

it('conformance: 取消组按能力跳过（mock 未声明 supportsCancel，M8-PG）', async () => {
  const summary = await runCancellationChecks(mockConnection, {
    supportsCancel: false,
    longQuerySql: (s) => `SELECT ${s}`,
    probeSql: 'SELECT COUNT(*) AS n FROM demo.users',
  });
  expect(summary.failed).toBe(0);
  expect(summary.results.every((r) => r.skipped)).toBe(true);
});
