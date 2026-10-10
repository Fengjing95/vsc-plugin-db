import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  runCancellationChecks,
  runChangesetChecks,
  runConnectionChecks,
  runDatabaseDdlChecks,
  runDdlChecks,
  runFilterPushdownChecks,
  runInteractiveTransactionChecks,
  runMetadataChecks,
  runPaginationChecks,
  runSqlValueEncodingChecks,
  type SqlValueEncodingCase,
} from '@db-explorer/driver-conformance';
import { createPostgresDriver, POSTGRES_DRIVER_ID } from './index';

/**
 * PostgreSQL 契约测试（驱动规范 §11）：需真实 PG 实例。
 * - M8-PG 本地口径：本机无 PG（P-28 环境事实），测试经 PG_HOST 环境变量门控——
 *   本地 skip、CI service（postgres:16）实跑（.github/workflows/ci.yml，驱动规范 §11 CI 门控注记）
 * - fixture：cf_* 前缀表（beforeAll 建表 + 种子，afterAll 清理），禁止触碰其他表
 * - db 参数语义（D-15）：全部契约组以 schema 'public' 作为 db 参数
 */

const HOST = process.env.PG_HOST ?? '127.0.0.1';
const PORT = Number(process.env.PG_PORT ?? 5432);
const USER = process.env.PG_USER ?? 'postgres';
const PASSWORD = process.env.PG_PASSWORD ?? 'postgres';
const DATABASE = process.env.PG_DATABASE ?? 'postgres';
const SCHEMA = 'public';

const cfg = {
  id: 'conformance-postgres',
  name: 'PG 契约',
  driverId: POSTGRES_DRIVER_ID,
  options: { host: HOST, port: PORT, username: USER, database: DATABASE, connectTimeout: 10_000 },
  secretRef: 'dbExplorer.secrets.conformance-postgres',
};

function makeConn() {
  return createPostgresDriver().connect(cfg, PASSWORD);
}

// 本地无 PG 实例 → 整套 skip（CI 实跑）
const d = process.env.PG_HOST ? describe : describe.skip;

const SEED_ROWS = 25;

d('postgres conformance（CI service 实跑）', () => {
  let admin: pg.Client;

  beforeAll(async () => {
    admin = new pg.Client({ host: HOST, port: PORT, user: USER, password: PASSWORD, database: DATABASE });
    await admin.connect();
    // fixture 表（cf_* 前缀；幂等重建）
    await admin.query('DROP TABLE IF EXISTS cf_users');
    await admin.query('DROP TABLE IF EXISTS cf_txn');
    await admin.query(`
      CREATE TABLE cf_users (
        id bigserial PRIMARY KEY,
        name varchar(64) NOT NULL,
        email varchar(128),
        age int,
        balance numeric(12, 2) NOT NULL,
        status varchar(16) NOT NULL,
        data jsonb,
        tags text[],
        created_at timestamp NOT NULL DEFAULT now(),
        avatar bytea
      )
    `);
    await admin.query('CREATE TABLE cf_txn (id bigserial PRIMARY KEY, marker varchar(100) NOT NULL)');
    for (let i = 1; i <= SEED_ROWS; i++) {
      await admin.query(
        'INSERT INTO cf_users (name, email, age, balance, status, data, tags, avatar) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
        [
          `user-${String(i).padStart(2, '0')}`,
          i % 5 === 0 ? null : `user${i}@example.com`,
          i % 7 === 0 ? null : 20 + i,
          (i * 1.5).toFixed(2),
          i % 2 === 0 ? 'active' : 'inactive',
          i % 4 === 0 ? null : JSON.stringify({ idx: i, tags: ['a', 'b'] }),
          i % 3 === 0 ? null : ['x', `t${i}`],
          i % 6 === 0 ? null : Buffer.from([0x00, 0x01, 0xff, i % 256]),
        ],
      );
    }
  });

  afterAll(async () => {
    await admin.query('DROP TABLE IF EXISTS cf_users').catch(() => undefined);
    await admin.query('DROP TABLE IF EXISTS cf_txn').catch(() => undefined);
    await admin.query('DROP TABLE IF EXISTS cf_valenc_t').catch(() => undefined);
    await admin.query('DROP TABLE IF EXISTS cf_ddl_t').catch(() => undefined);
    await admin.end().catch(() => undefined);
  });

  it('connection 组', async () => {
    const summary = await runConnectionChecks(makeConn);
    logFailures(summary);
    expect(summary.failed).toBe(0);
    expect(summary.results.filter((r) => !r.skipped)).toHaveLength(3);
  });

  it('metadata 组（D-15：listDatabases=schema）', async () => {
    const summary = await runMetadataChecks(makeConn);
    logFailures(summary);
    expect(summary.failed).toBe(0);
  });

  it('pagination 组', async () => {
    const summary = await runPaginationChecks(makeConn);
    logFailures(summary);
    expect(summary.failed).toBe(0);
    expect(summary.results.filter((r) => !r.skipped)).toHaveLength(4);
  });

  it('filter-pushdown 组', async () => {
    const summary = await runFilterPushdownChecks(makeConn, { supportsWhereSql: true });
    logFailures(summary);
    expect(summary.failed).toBe(0);
    // 13 个 FilterOp + 组合 + search + whereSql 拼接（同 mock 口径）
    expect(summary.results.filter((r) => !r.skipped)).toHaveLength(16);
  });

  it('changeset 组（短事务 + RETURNING 回填 + 乐观锁）', async () => {
    const summary = await runChangesetChecks(makeConn);
    logFailures(summary);
    expect(summary.failed).toBe(0);
    expect(summary.results.filter((r) => !r.skipped)).toHaveLength(5);
  });

  it('cancellation 组（supportsCancel=true，§7）', async () => {
    const summary = await runCancellationChecks(makeConn, {
      supportsCancel: true,
      longQuerySql: (seconds) => `SELECT pg_sleep(${seconds})`,
      probeSql: 'SELECT 1 AS one',
    });
    logFailures(summary);
    expect(summary.failed).toBe(0);
    expect(summary.results.filter((r) => !r.skipped)).toHaveLength(3);
  });

  it('sql-value-encoding 组（§5.2 编码往返）', async () => {
    const summary = await runSqlValueEncodingChecks(makeConn, {
      db: SCHEMA,
      cases: PG_VE_CASES,
    });
    logFailures(summary);
    expect(summary.failed).toBe(0);
    expect(summary.results.filter((r) => !r.skipped)).toHaveLength(PG_VE_CASES.length + 2);
  });

  it('ddl 组（表结构编辑，PG 方言）', async () => {
    const summary = await runDdlChecks(makeConn);
    logFailures(summary);
    expect(summary.failed).toBe(0);
    expect(summary.results.filter((r) => !r.skipped)).toHaveLength(7);
  });

  it('database-ddl 组（M8-DBDDL / D-19：schema 建删周期 + 标识符 fail-closed；无 ALTER 跳过）', async () => {
    const summary = await runDatabaseDdlChecks(createPostgresDriver(), makeConn);
    logFailures(summary);
    expect(summary.failed).toBe(0);
    // 实跑 2 项：标识符 fail-closed（supportsSQL）+ create/drop schema 周期；alter 未实现跳过
    expect(summary.results.filter((r) => !r.skipped)).toHaveLength(2);
    expect(summary.results.filter((r) => r.skipped)).toHaveLength(1);
  });

  it('interactive-transaction 组（D-09）', async () => {
    const summary = await runInteractiveTransactionChecks(makeConn, {
      insertSql: (k) => `INSERT INTO cf_txn (marker) VALUES ('${k}')`,
      countSql: (k) => `SELECT COUNT(*) FROM cf_txn WHERE marker = '${k}'`,
      cleanupSql: (k) => `DELETE FROM cf_txn WHERE marker = '${k}'`,
    });
    logFailures(summary);
    expect(summary.failed).toBe(0);
    expect(summary.results.filter((r) => !r.skipped)).toHaveLength(5);
  });

  it('连接失败映射：错误密码 → E_AUTH；不可达 → E_CONN', async () => {
    const driver = createPostgresDriver();
    const badAuth = await driver.testConnection({ ...cfg, id: 'cf-bad-auth' }, 'wrong-password');
    expect(badAuth.ok).toBe(false);
    expect(badAuth.error?.code).toBe('E_AUTH');

    const badConn = await driver.testConnection(
      { ...cfg, id: 'cf-bad-conn', options: { ...cfg.options, host: '127.0.0.1', port: 59999, connectTimeout: 2000 } },
      PASSWORD,
    );
    expect(badConn.ok).toBe(false);
    expect(badConn.error?.code).toBe('E_CONN');
  });
});

/** PG 方言值编码用例（驱动规范 §5.2） */
const PG_VE_CASES: SqlValueEncodingCase[] = [
  { column: 'c_str', dataType: 'varchar(64)', write: "it's ✓ 汉" },
  { column: 'c_empty', dataType: 'varchar(64)', write: '' },
  { column: 'c_int', dataType: 'integer', write: 42 },
  { column: 'c_bigint', dataType: 'bigint', write: '9007199254740993' },
  { column: 'c_dec', dataType: 'numeric', write: '12345678901234567890.123456789' },
  { column: 'c_float', dataType: 'double precision', write: 1.5 },
  { column: 'c_bool', dataType: 'boolean', write: true },
  { column: 'c_date', dataType: 'date', write: '2024-06-01' },
  { column: 'c_time', dataType: 'time', write: '08:30:00.000' },
  { column: 'c_ts', dataType: 'timestamp', write: '2024-06-01 08:30:00.000' },
  { column: 'c_json', dataType: 'jsonb', write: { k: 1, arr: [1, 2, null], s: '汉' } },
  { column: 'c_arr', dataType: 'text[]', write: ['a', 'b', null] },
  { column: 'c_bin', dataType: 'bytea', write: 'AAEC/w==' },
  { column: 'c_uuid', dataType: 'uuid', write: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11' },
];

function logFailures(summary: {
  failed: number;
  results: Array<{ ok: boolean; group: string; name: string; error?: string }>;
}): void {
  const failed = summary.results.filter((r) => !r.ok);
  if (failed.length > 0) {
    console.error(JSON.stringify(failed, null, 2));
    // CI 注记只显示断言/抛错 message（完整日志需登录才可见）——把 check 级失败详情塞进抛错文本，
    // 首轮推送即可在 annotations 里拿到每项失败的具体错误
    throw new Error(
      `契约组失败 ${failed.length} 项：\n${failed
        .map((f) => `- [${f.group}] ${f.name}: ${f.error ?? '（无错误文本）'}`)
        .join('\n')}`,
    );
  }
}
