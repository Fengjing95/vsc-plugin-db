import * as mssql from 'mssql';
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
  runRelationGraphChecks,
  runSqlValueEncodingChecks,
  type SqlValueEncodingCase,
} from '@db-explorer/driver-conformance';
import { createMssqlDriver, MSSQL_DRIVER_ID } from './index';

/**
 * SQL Server 契约测试（驱动规范 §11）：需真实 SQL Server 实例。
 * - M8-MSSQL 口径：本机无实例（P-28，macOS ARM 无容器运行时；用户已确认完全依赖 CI），
 *   测试经 MSSQL_HOST 环境变量门控——本地 skip、CI service（mcr.microsoft.com/mssql/server:2022-latest）
 *   实跑（.github/workflows/ci.yml，同 PG/MONGO/MYSQL 门控口径）
 * - fixture：专用库 cf_test（beforeAll 经 master 重建 + 种子，afterAll 整库清理 + cf_db_* 残 schema 清扫），
 *   禁止触碰其他库；db 参数语义（ADR D-21，D-15 同构）：全部契约组以 schema 'dbo' 作为 db 参数
 */

const HOST = process.env.MSSQL_HOST ?? '127.0.0.1';
const PORT = Number(process.env.MSSQL_PORT ?? 1433);
const USER = process.env.MSSQL_USER ?? 'sa';
const PASSWORD = process.env.MSSQL_PASSWORD ?? '';
const DATABASE = process.env.MSSQL_DATABASE ?? 'cf_test';
const SCHEMA = 'dbo';

const cfg = {
  id: 'conformance-mssql',
  name: 'SQL Server 契约',
  driverId: MSSQL_DRIVER_ID,
  options: { host: HOST, port: PORT, username: USER, database: DATABASE, connectTimeout: 10_000 },
  secretRef: 'dbExplorer.secrets.conformance-mssql',
};

function makeConn() {
  return createMssqlDriver().connect(cfg, PASSWORD);
}

// 本地无 SQL Server 实例 → 整套 skip（CI 实跑）
const d = process.env.MSSQL_HOST ? describe : describe.skip;

const SEED_ROWS = 25;

d('mssql conformance（CI service 实跑）', () => {
  let admin: mssql.ConnectionPool;

  beforeAll(async () => {
    // fixture 专用库整库重建（seeds 经 master 管理连接写入，禁止触碰其他库）
    admin = new mssql.ConnectionPool({
      server: HOST,
      port: PORT,
      user: USER,
      password: PASSWORD,
      database: 'master',
      connectionTimeout: 30_000,
      requestTimeout: 30_000,
      options: { trustServerCertificate: true },
    });
    await admin.connect();
    await admin
      .request()
      .query(`IF DB_ID('${DATABASE}') IS NOT NULL EXEC('ALTER DATABASE [${DATABASE}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [${DATABASE}];')`);
    await admin.request().query(`CREATE DATABASE [${DATABASE}]`);
    // fixture 库开启 RCSI（READ_COMMITTED_SNAPSHOT，Azure SQL DB 默认行为）：SQL Server 默认
    // READ COMMITTED 为锁式读（PG/MySQL 为 MVCC），未提交 INSERT 的 X 锁会阻塞其他连接的
    // COUNT——交互式事务契约组的「未提交不可见」检查会互等死锁。仅作用于测试自持的 fixture 库
    await admin
      .request()
      .query(`ALTER DATABASE [${DATABASE}] SET READ_COMMITTED_SNAPSHOT ON WITH ROLLBACK IMMEDIATE`);
    // fixture 表（cf_* 前缀；列型对齐 PG 契约的 cf_users）。全程三段名全限定——
    // mssql 连接池下 `USE` 只改当次抢到的物理连接（P-36 同族），不落会话
    await admin.request().query(`
      CREATE TABLE [${DATABASE}].[dbo].[cf_users] (
        id BIGINT IDENTITY(1,1) NOT NULL PRIMARY KEY,
        name NVARCHAR(64) NOT NULL,
        email NVARCHAR(128) NULL,
        age INT NULL,
        balance DECIMAL(12, 2) NOT NULL,
        status NVARCHAR(16) NOT NULL,
        created_at DATETIME2(3) NOT NULL DEFAULT SYSDATETIME(),
        avatar VARBINARY(MAX) NULL
      )
    `);
    await admin
      .request()
      .query(`CREATE TABLE [${DATABASE}].[dbo].[cf_txn] (id BIGINT IDENTITY(1,1) NOT NULL PRIMARY KEY, marker NVARCHAR(100) NOT NULL)`);
    for (let i = 1; i <= SEED_ROWS; i++) {
      await admin
        .request()
        .input('name', `user-${String(i).padStart(2, '0')}`)
        .input('email', i % 5 === 0 ? null : `user${i}@example.com`)
        .input('age', i % 7 === 0 ? null : 20 + i)
        .input('balance', (i * 1.5).toFixed(2))
        .input('status', i % 2 === 0 ? 'active' : 'inactive')
        // avatar 用三参显式 VarBinary 绑定：裸 null 会走 mssql 自动推断（NVarChar），
        // nvarchar→varbinary 无隐式转换，beforeAll 直接炸（v0.2.1 release 门禁首跑抓到——
        // 与驱动侧 TypedNullParam 同族，fixture 自身的裸 null 绑定同样必须显式类型）
        .input('avatar', mssql.VarBinary(mssql.MAX), i % 6 === 0 ? null : Buffer.from([0x00, 0x01, 0xff, i % 256]))
        .query(
          `INSERT INTO [${DATABASE}].[dbo].[cf_users] (name, email, age, balance, status, avatar) VALUES (@name, @email, @age, @balance, @status, @avatar)`,
        );
    }
  });

  afterAll(async () => {
    // create 周期可能的残 schema（失败中断时）清扫 + fixture 整库清理
    try {
      const pool = new mssql.ConnectionPool({
        server: HOST,
        port: PORT,
        user: USER,
        password: PASSWORD,
        database: DATABASE,
        connectionTimeout: 10_000,
        requestTimeout: 15_000,
        options: { trustServerCertificate: true },
      });
      await pool.connect();
      const leftovers = await pool
        .request()
        .query("SELECT name FROM sys.schemas WHERE name LIKE 'cf\\_db\\_%' ESCAPE '\\'");
      for (const row of leftovers.recordset) {
        await pool
          .request()
          .query(`IF SCHEMA_ID('${String(row.name)}') IS NOT NULL DROP SCHEMA [${String(row.name)}]`)
          .catch(() => undefined);
      }
      await pool.close().catch(() => undefined);
    } catch {
      // fixture 库可能已随失败清理，尽力而为
    }
    await admin
      .request()
      .query(
        `IF DB_ID('${DATABASE}') IS NOT NULL EXEC('ALTER DATABASE [${DATABASE}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [${DATABASE}];')`,
      )
      .catch(() => undefined);
    await admin.close().catch(() => undefined);
  });

  it('connection 组', async () => {
    const summary = await runConnectionChecks(makeConn);
    logFailures(summary);
    expect(summary.failed).toBe(0);
    expect(summary.results.filter((r) => !r.skipped)).toHaveLength(3);
  });

  it('metadata 组（D-21：listDatabases=schema）', async () => {
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
    // 13 个 FilterOp + 组合 + search + whereSql 拼接（同 mysql/pg 口径）
    expect(summary.results.filter((r) => !r.skipped)).toHaveLength(16);
  });

  it('changeset 组（短事务 + OUTPUT 回填 + 乐观锁）', async () => {
    const summary = await runChangesetChecks(makeConn);
    logFailures(summary);
    expect(summary.failed).toBe(0);
    expect(summary.results.filter((r) => !r.skipped)).toHaveLength(5);
  });

  it('cancellation 组（supportsCancel=true，request.cancel → ATTENTION）', async () => {
    const summary = await runCancellationChecks(makeConn, {
      supportsCancel: true,
      longQuerySql: (seconds) => `WAITFOR DELAY '00:00:0${Math.min(seconds, 9)}'`,
      probeSql: 'SELECT 1 AS one',
    });
    logFailures(summary);
    expect(summary.failed).toBe(0);
    expect(summary.results.filter((r) => !r.skipped)).toHaveLength(3);
  });

  it('sql-value-encoding 组（§5.6 编码往返）', async () => {
    const summary = await runSqlValueEncodingChecks(makeConn, {
      db: SCHEMA,
      cases: MSSQL_VE_CASES,
    });
    logFailures(summary);
    expect(summary.failed).toBe(0);
    expect(summary.results.filter((r) => !r.skipped)).toHaveLength(MSSQL_VE_CASES.length + 2);
  });

  it('ddl 组（表结构编辑，T-SQL 方言）', async () => {
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

  it('database-ddl 组（M8-DBDDL / D-19：schema 建删周期 + 标识符 fail-closed；无 ALTER 跳过）', async () => {
    const summary = await runDatabaseDdlChecks(createMssqlDriver(), makeConn);
    logFailures(summary);
    expect(summary.failed).toBe(0);
    // 实跑 2 项：标识符 fail-closed（supportsSQL）+ create/drop schema 周期；alter 未实现跳过
    expect(summary.results.filter((r) => !r.skipped)).toHaveLength(2);
    expect(summary.results.filter((r) => r.skipped)).toHaveLength(1);
  });

  it('interactive-transaction 组（D-09，连接默认库 = fixture 库）', async () => {
    const summary = await runInteractiveTransactionChecks(makeConn, {
      insertSql: (k) => `INSERT INTO cf_txn (marker) VALUES ('${k}')`,
      // COUNT(*) 加别名：TDS 无别名表达式列列名为空串（驱动侧已兜底占位，模板显式命名更自描述）
      countSql: (k) => `SELECT COUNT(*) AS cnt FROM cf_txn WHERE marker = '${k}'`,
      cleanupSql: (k) => `DELETE FROM cf_txn WHERE marker = '${k}'`,
    });
    logFailures(summary);
    expect(summary.failed).toBe(0);
    expect(summary.results.filter((r) => !r.skipped)).toHaveLength(5);
  });

  it('连接失败映射：错误密码 → E_AUTH；不可达 → E_CONN', async () => {
    const driver = createMssqlDriver();
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
 * T-SQL 方言值编码用例（驱动规范 §5.6 / C-7）。
 * 相对 PG 用例的如实裁剪（非遗漏）：
 * - json：SQL Server 无原生 JSON 类型（nvarchar 文本承载）——按字符串往返，对象形态不走编辑写
 * - uuid 用例保留（uniqueidentifier 原生类型）
 * 时间列用 time(3)/datetime2(3) 承载小数秒，对齐 §5 的 `.SSS` 编码形态
 */
const MSSQL_VE_CASES: SqlValueEncodingCase[] = [
  { column: 'c_str', dataType: 'nvarchar(64)', write: "it's ✓ 汉" },
  { column: 'c_empty', dataType: 'nvarchar(64)', write: '' },
  { column: 'c_int', dataType: 'int', write: 42 },
  { column: 'c_bigint', dataType: 'bigint', write: '9007199254740993' },
  // decimal 用例取安全精度（14 位有效 < 2^53）：tedious 对 Decimal/Numeric 经 JS Number 返回
  // （value / 10^scale），超过 Number 安全整数的精度在客户端层即失真、驱动无法恢复——
  // 与 mysql 值编码组「如实裁剪」同口径；引擎限制在驱动 README 已知限制声明
  { column: 'c_dec', dataType: 'decimal(32,9)', write: '12345.678901234' },
  { column: 'c_float', dataType: 'float', write: 1.5 },
  { column: 'c_bool', dataType: 'bit', write: true },
  { column: 'c_date', dataType: 'date', write: '2024-06-01' },
  { column: 'c_time', dataType: 'time(3)', write: '08:30:00.000' },
  { column: 'c_dt', dataType: 'datetime2(3)', write: '2024-06-01 08:30:00.000' },
  { column: 'c_json_text', dataType: 'nvarchar(max)', write: '{"k":1,"s":"汉"}' },
  { column: 'c_bin', dataType: 'varbinary(max)', write: 'AAEC/w==' },
  { column: 'c_uid', dataType: 'uniqueidentifier', write: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11' },
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
