import { createConnection } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  runCancellationChecks,
  runChangesetChecks,
  runConnectionChecks,
  runDatabaseDdlChecks,
  runDdlChecks,
  runFilterPushdownChecks,
  runInteractiveTransactionChecks,
  runLazyCellChecks,
  runMetadataChecks,
  runPaginationChecks,
  runRelationGraphChecks,
  runSqlValueEncodingChecks,
  type SqlValueEncodingCase,
} from '@db-explorer/driver-conformance';
import { createMysqlDriver, MYSQL_DRIVER_ID } from './index';

/**
 * MySQL 契约测试（驱动规范 §11）：需真实 MySQL 实例。
 * - 发布准备批次：mysql 此前仅生成层单测（sql/changes/ddl.test），契约按 PG 同款
 *   环境门控（MYSQL_HOST）——本地 skip（P-28 无容器运行时）、CI service（mysql:8）实跑
 * - fixture：专用库 cf_test（beforeAll 重建 + 种子，afterAll 整库清理 + cf_db_* 残库清扫），
 *   禁止触碰其他库；样例发现（firstTable/findSampleTable）依赖 listDatabases 的系统库过滤
 *   （CI 专用空实例上 cf_test 即首个用户库，发现确定性成立）
 */

const HOST = process.env.MYSQL_HOST ?? '127.0.0.1';
const PORT = Number(process.env.MYSQL_PORT ?? 3306);
const USER = process.env.MYSQL_USER ?? 'root';
const PASSWORD = process.env.MYSQL_PASSWORD ?? 'root';
const DATABASE = process.env.MYSQL_DATABASE ?? 'cf_test';

const cfg = {
  id: 'conformance-mysql',
  name: 'MySQL 契约',
  driverId: MYSQL_DRIVER_ID,
  options: { host: HOST, port: PORT, username: USER, database: DATABASE },
  secretRef: 'dbExplorer.secrets.conformance-mysql',
};

function makeConn() {
  return createMysqlDriver().connect(cfg, PASSWORD);
}

// 本地无 MySQL 实例 → 整套 skip（CI 实跑）
const d = process.env.MYSQL_HOST ? describe : describe.skip;

const SEED_ROWS = 25;

d('mysql conformance（CI service 实跑）', () => {
  let admin: Awaited<ReturnType<typeof createConnection>>;

  beforeAll(async () => {
    admin = await createConnection({ host: HOST, port: PORT, user: USER, password: PASSWORD });
    await admin.query(`DROP DATABASE IF EXISTS \`${DATABASE}\``);
    await admin.query(`CREATE DATABASE \`${DATABASE}\` CHARACTER SET utf8mb4`);
    await admin.query(`USE \`${DATABASE}\``);
    // fixture 表（cf_* 前缀；幂等重建）。列型对齐 PG 契约的 cf_users（数组型列 MySQL 无对应，省略）
    await admin.query(`
      CREATE TABLE cf_users (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(64) NOT NULL,
        email VARCHAR(128) NULL,
        age INT NULL,
        balance DECIMAL(12, 2) NOT NULL,
        status VARCHAR(16) NOT NULL,
        data JSON NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        avatar BLOB NULL
      )
    `);
    await admin.query(
      'CREATE TABLE cf_txn (id BIGINT AUTO_INCREMENT PRIMARY KEY, marker VARCHAR(100) NOT NULL)',
    );
    for (let i = 1; i <= SEED_ROWS; i++) {
      await admin.query(
        'INSERT INTO cf_users (name, email, age, balance, status, data, avatar) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [
          `user-${String(i).padStart(2, '0')}`,
          i % 5 === 0 ? null : `user${i}@example.com`,
          i % 7 === 0 ? null : 20 + i,
          (i * 1.5).toFixed(2),
          i % 2 === 0 ? 'active' : 'inactive',
          i % 4 === 0 ? null : JSON.stringify({ idx: i, tags: ['a', 'b'] }),
          i % 6 === 0 ? null : Buffer.from([0x00, 0x01, 0xff, i % 256]),
        ],
      );
    }
  });

  afterAll(async () => {
    // create 周期可能的残库（失败中断时）清扫 + fixture 整库清理
    const [rows] = (await admin
      .query("SELECT SCHEMA_NAME AS n FROM information_schema.SCHEMATA WHERE SCHEMA_NAME LIKE 'cf\\_db\\_%'")
      .catch(() => [[] as Array<{ n: string }>])) as [Array<{ n: string }>];
    for (const row of rows ?? []) {
      await admin.query(`DROP DATABASE IF EXISTS \`${row.n}\``).catch(() => undefined);
    }
    await admin.query(`DROP DATABASE IF EXISTS \`${DATABASE}\``).catch(() => undefined);
    await admin.end().catch(() => undefined);
  });

  it('connection 组', async () => {
    const summary = await runConnectionChecks(makeConn);
    logFailures(summary);
    expect(summary.failed).toBe(0);
    expect(summary.results.filter((r) => !r.skipped)).toHaveLength(3);
  });

  it('lazy-cell 组（能力门控：fetchCell 未实现即整组跳过）', async () => {
    const summary = await runLazyCellChecks(makeConn);
    logFailures(summary);
    expect(summary.failed).toBe(0);
  });

  it('metadata 组', async () => {
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
    // 13 个 FilterOp + 组合 + search + whereSql 拼接（同 mock/PG 口径）
    expect(summary.results.filter((r) => !r.skipped)).toHaveLength(16);
  });

  it('changeset 组（短事务 + LAST_INSERT_ID 回填 + 乐观锁）', async () => {
    const summary = await runChangesetChecks(makeConn);
    logFailures(summary);
    expect(summary.failed).toBe(0);
    expect(summary.results.filter((r) => !r.skipped)).toHaveLength(5);
  });

  it('cancellation 组（supportsCancel=true → KILL QUERY 三检查实跑）', async () => {
    // abort/超时 → 专用临时连接 KILL QUERY <threadId>（只杀语句不断连接），1317 → E_CANCELED
    const summary = await runCancellationChecks(makeConn, {
      supportsCancel: true,
      longQuerySql: (seconds) => `SELECT SLEEP(${seconds})`,
      probeSql: 'SELECT 1 AS one',
    });
    logFailures(summary);
    expect(summary.failed).toBe(0);
    expect(summary.results.filter((r) => !r.skipped)).toHaveLength(3);
  });

  it('sql-value-encoding 组（§5 编码往返）', async () => {
    const summary = await runSqlValueEncodingChecks(makeConn, {
      db: DATABASE,
      cases: MYSQL_VE_CASES,
    });
    logFailures(summary);
    expect(summary.failed).toBe(0);
    expect(summary.results.filter((r) => !r.skipped)).toHaveLength(MYSQL_VE_CASES.length + 2);
  });

  it('ddl 组（表结构编辑，MySQL 方言）', async () => {
    const summary = await runDdlChecks(makeConn);
    logFailures(summary);
    expect(summary.failed).toBe(0);
    // 原 7 项 + 键/外键/索引段 6 项（外键 alter 各方言均支持，无 skip）
    expect(summary.results.filter((r) => !r.skipped)).toHaveLength(13);
  });

  it('relation-graph 组（M8-ER / D-22：单列/复合/自引用 FK + selection 裁剪）', async () => {
    const summary = await runRelationGraphChecks(makeConn);
    logFailures(summary);
    expect(summary.failed).toBe(0);
    // C-3：组必须实跑（supportsErDiagram 已声明）——fixture / 表集列形状 / FK 边 / selection / 清理
    expect(summary.results.filter((r) => !r.skipped)).toHaveLength(5);
  });

  it('database-ddl 组（M8-DBDDL / D-19：建库周期 + alter 无差异 + 标识符 fail-closed 全实跑）', async () => {
    const summary = await runDatabaseDdlChecks(createMysqlDriver(), makeConn);
    logFailures(summary);
    expect(summary.failed).toBe(0);
    // mysql 实现全三方法：create 周期闭环 / alter 无差异空数组 / 标识符 fail-closed
    expect(summary.results.filter((r) => !r.skipped)).toHaveLength(3);
    expect(summary.results.filter((r) => r.skipped)).toHaveLength(0);
  });

  it('interactive-transaction 组（D-09，连接默认库 = fixture 库）', async () => {
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
    const driver = createMysqlDriver();
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

/**
 * MySQL 方言值编码用例（驱动规范 §5 / C-7）。
 * 相对 mock/PG 用例的三处裁剪（如实在此留痕，非遗漏）：
 * - boolean：MySQL 无原生 BOOLEAN（tinyint(1) 读回为数值 0/1，按 integer 归一）——c_int 已覆盖整型
 * - binary：mysql 编辑写路径无 base64→Buffer 钩子（D-03 口径下含二进制列不走编辑），写往返不成立
 * - uuid：MySQL 无原生 UUID 类型（等同 varchar）
 * 时间列用 time(3)/datetime(3)（DDL 生成器按方言原文透传）承载小数秒，对齐 §5 的 `.SSS` 编码形态
 */
const MYSQL_VE_CASES: SqlValueEncodingCase[] = [
  { column: 'c_str', dataType: 'varchar(64)', write: "it's ✓ 汉" },
  { column: 'c_empty', dataType: 'varchar(64)', write: '' },
  { column: 'c_int', dataType: 'int', write: 42 },
  { column: 'c_bigint', dataType: 'bigint', write: '9007199254740993' },
  { column: 'c_dec', dataType: 'decimal(32,9)', write: '12345678901234567890.123456789' },
  { column: 'c_float', dataType: 'double', write: 1.5 },
  { column: 'c_date', dataType: 'date', write: '2024-06-01' },
  { column: 'c_time', dataType: 'time(3)', write: '08:30:00.000' },
  { column: 'c_dt', dataType: 'datetime(3)', write: '2024-06-01 08:30:00.000' },
  { column: 'c_json', dataType: 'json', write: { k: 1, arr: [1, 2, null], s: '汉' } },
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
