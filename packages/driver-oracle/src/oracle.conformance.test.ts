import * as oracledb from 'oracledb';
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
import { createOracleDriver, ORACLE_DRIVER_ID } from './index';

/**
 * Oracle 契约测试（驱动规范 §11 / ADR D-23）：需真实 Oracle 实例。
 * - 门控口径（PG/MONGO/MYSQL/MSSQL 先例）：ORACLE_HOST 等环境变量注入——本地（常驻实例）实跑、
 *   未设 skip；CI `gvenzl/oracle-free` service 实跑保底防「契约静默缺考」（独立 job，磁盘预算）。
 * - fixture：专用 schema cf_test（beforeAll 经管理连接重建 + 种子；afterAll DROP USER CASCADE
 *   + cf_db_* 残留清扫，mssql cf_test 整库重建同构）；契约组主连接 = ORACLE_USER（应用账号），
 *   跨 schema 用例 db='CF_TEST'；db 参数语义（D-23，D-15/D-21 同构）：db = schema 名。
 * - 常驻实例（100.125.188.135:1521/orcl，Oracle 19.19）：dbkit/cf_test 已预建；
 *   CI（oracle-free 23ai）：APP_USER env 由镜像创建，管理连接 system 免 SYSDBA。
 */

const HOST = process.env.ORACLE_HOST ?? '127.0.0.1';
const PORT = Number(process.env.ORACLE_PORT ?? 1521);
const SERVICE = process.env.ORACLE_SERVICE ?? 'FREEPDB1';
const USER = process.env.ORACLE_USER ?? 'dbkit';
const PASSWORD = process.env.ORACLE_PASSWORD ?? '';
const ADMIN_USER = process.env.ORACLE_ADMIN_USER ?? 'system';
const ADMIN_PASSWORD = process.env.ORACLE_ADMIN_PASSWORD ?? PASSWORD;

const cfg = {
  id: 'conformance-oracle',
  name: 'Oracle 契约',
  driverId: ORACLE_DRIVER_ID,
  options: {
    host: HOST,
    port: PORT,
    serviceName: SERVICE,
    username: USER,
    connectTimeout: 15_000,
    poolMax: 8,
  },
  secretRef: 'dbExplorer.secrets.conformance-oracle',
};

function makeConn() {
  return createOracleDriver().connect(cfg, PASSWORD);
}

// 本地未注入实例 → 整套 skip（CI / 本地 env 实跑）
const d = process.env.ORACLE_HOST ? describe : describe.skip;

/** 管理连接（sys 需 SYSDBA 身份；system 等普通 DBA 免）；fixture 重建专用，不入契约路径 */
async function withAdmin<T>(fn: (admin: oracledb.Connection) => Promise<T>): Promise<T> {
  const admin = await oracledb.getConnection({
    user: ADMIN_USER,
    password: ADMIN_PASSWORD,
    connectString: `${HOST}:${PORT}/${SERVICE}`,
    privilege: ADMIN_USER.toLowerCase() === 'sys' ? oracledb.SYSDBA : undefined,
  });
  try {
    return await fn(admin);
  } finally {
    await admin.close().catch(() => undefined);
  }
}

/** 应用账号直连（fixture 种子/清理；非契约路径） */
async function withApp<T>(fn: (conn: oracledb.Connection) => Promise<T>): Promise<T> {
  const conn = await oracledb.getConnection({
    user: USER,
    password: PASSWORD,
    connectString: `${HOST}:${PORT}/${SERVICE}`,
  });
  try {
    return await fn(conn);
  } finally {
    await conn.close().catch(() => undefined);
  }
}

const SEED_ROWS = 25;
/** 契约 fixture 表（专用前缀 cf_；开始前预清 + 结束清扫——19c 无 DROP TABLE IF EXISTS，逐表尽力而为）。表名必须带引号：套件建的是小写引号名，无引号 DROP 大小写折叠查不到（ORA-00942 被吞） */
const FIXTURE_TABLES = ['cf_valenc_t', 'cf_ddl_t', 'cf_ddl_ref'];

async function dropFixtureTables(conn: oracledb.Connection): Promise<void> {
  for (const t of FIXTURE_TABLES) {
    await conn.execute(`DROP TABLE "${t}" PURGE`).catch(() => undefined);
  }
  // 种子表（无引号建 → 大写存储）
  await conn.execute(`DROP TABLE CF_USERS PURGE`).catch(() => undefined);
  await conn.execute(`DROP TABLE CF_TXN PURGE`).catch(() => undefined);
  // ER fixture（契约组内 IF EXISTS 清理在 19c 恒失败——这里按名单兜底）
  for (const t of ['cf_er_line', 'cf_er_child', 'cf_er_self', 'cf_er_parent', 'cf_er_order', 'cf_er_loose']) {
    await conn.execute(`DROP TABLE "${t}" PURGE`).catch(() => undefined);
  }
}

d('oracle conformance（ORACLE_* 门控实跑）', () => {
  beforeAll(async () => {
    // ① fixture 专用 schema 重建（禁止触碰其他 schema）。DROP 前先清理残留会话（上一轮
    //  afterAll 的 DROP USER 可能因会话/字典延迟失败——失败被吞会让本轮 CREATE 撞 955）
    await withAdmin(async (admin) => {
      await admin
        .execute(`BEGIN FOR s IN (SELECT sid, serial# FROM v$session WHERE username = 'CF_TEST') LOOP EXECUTE IMMEDIATE 'ALTER SYSTEM KILL SESSION ''' || s.sid || ',' || s.serial# || ''' IMMEDIATE'; END LOOP; END;`)
        .catch(() => undefined);
      await admin.execute(`DROP USER cf_test CASCADE`).catch((e) => console.error('[fixture] drop cf_test:', String(e.message).split('\n')[0]));
      await admin
        .execute(`CREATE USER cf_test IDENTIFIED BY "cf_test_pw_123" DEFAULT TABLESPACE USERS QUOTA UNLIMITED ON USERS`)
        .catch((e) => { throw new Error(`CREATE USER cf_test 失败: ${String(e.message).split('\n')[0]}`); });
      await admin.execute(`GRANT CREATE SESSION, RESOURCE, CREATE VIEW TO cf_test`);
      // database-ddl 组 create/drop USER 周期需要系统权限（幂等再授权）
      await admin.execute(`GRANT CREATE USER, DROP USER, CREATE SESSION, CREATE VIEW TO ${USER} WITH ADMIN OPTION`).catch(() => undefined);
      await admin.execute(`GRANT RESOURCE TO ${USER} WITH ADMIN OPTION`).catch(() => undefined);
    });

    // ② 应用 schema 预清（前次中断残留——套件 dropFixture 用 IF EXISTS，19c 不支持恒被吞）+ 种子
    await withApp(async (conn) => {
      await dropFixtureTables(conn);
      await conn.execute(`
        CREATE TABLE cf_users (
          id NUMBER(9) GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
          name VARCHAR2(64 CHAR) NOT NULL,
          email VARCHAR2(128 CHAR),
          age NUMBER(9),
          balance NUMBER(12, 2) NOT NULL,
          status VARCHAR2(16 CHAR) NOT NULL,
          created_at DATE NOT NULL,
          note CLOB,
          avatar BLOB
        )
      `);
      await conn.execute(`CREATE INDEX idx_cf_users_name ON cf_users (name)`).catch((e) => { throw new Error(`CREATE INDEX 失败: ${String(e.message).split("\n")[0]}`); });
      for (let i = 1; i <= SEED_ROWS; i++) {
        await conn.execute(
          `INSERT INTO cf_users (name, email, age, balance, status, created_at, note, avatar)
           VALUES (:1, :2, :3, :4, :5, TO_DATE(:6, 'YYYY-MM-DD HH24:MI:SS'), :7, :8)`,
          [
            `user-${String(i).padStart(2, '0')}`,
            i % 5 === 0 ? null : `user${i}@example.com`,
            i % 7 === 0 ? null : 20 + i,
            (i * 1.5).toFixed(2),
            i % 2 === 0 ? 'active' : 'inactive',
            '2024-06-01 08:30:00',
            i % 4 === 0 ? `note-${i}` : null,
            i % 6 === 0 ? null : Buffer.from([0x00, 0x01, 0xff, i % 256]),
          ],
        );
      }
      await conn.execute(`CREATE TABLE cf_txn (id NUMBER(9) GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, marker VARCHAR2(100 CHAR) NOT NULL)`);
      await conn.execute('COMMIT');
    });
  }, 120_000);

  afterAll(async () => {
    // fixture 表清理 + cf_db_* 残留 schema 清扫 + cf_test 整删（尽力而为）
    await withApp((conn) => dropFixtureTables(conn)).catch(() => undefined);
    await withAdmin(async (admin) => {
      const leftovers = await admin
        .execute(`SELECT username FROM all_users WHERE username LIKE 'CF\\_DB\\_%' ESCAPE '\\'`)
        .catch(() => undefined);
      for (const row of leftovers?.rows ?? []) {
        await admin.execute(`DROP USER ${String((row as unknown[])[0])} CASCADE`).catch(() => undefined);
      }
      await admin.execute(`DROP USER cf_test CASCADE`).catch(() => undefined);
    }).catch(() => undefined);
  }, 120_000);

  it('connection 组（错误密码 E_AUTH / 不可达 E_CONN / dispose 幂等）', async () => {
    const summary = await runConnectionChecks(makeConn);
    logFailures(summary);
    expect(summary.failed).toBe(0);
    expect(summary.results.filter((r) => !r.skipped)).toHaveLength(3);
  }, 120_000);

  it('lazy-cell 组（能力门控：fetchCell 未实现即整组跳过）', async () => {
    const summary = await runLazyCellChecks(makeConn);
    logFailures(summary);
    expect(summary.failed).toBe(0);
  });

  it('metadata 组（D-23：listDatabases=schema，当前用户首位）', async () => {
    const summary = await runMetadataChecks(makeConn);
    logFailures(summary);
    expect(summary.failed).toBe(0);
  }, 120_000);

  it('pagination 组（OFFSET/FETCH + 主键兜底稳定翻页）', async () => {
    const summary = await runPaginationChecks(makeConn);
    logFailures(summary);
    expect(summary.failed).toBe(0);
    expect(summary.results.filter((r) => !r.skipped)).toHaveLength(4);
  }, 120_000);

  it('filter-pushdown 组（13 FilterOp + 组合 + search + whereSql）', async () => {
    const summary = await runFilterPushdownChecks(makeConn, { supportsWhereSql: true });
    logFailures(summary);
    expect(summary.failed).toBe(0);
    expect(summary.results.filter((r) => !r.skipped)).toHaveLength(16);
  }, 120_000);

  it('changeset 组（短事务 + RETURNING 回填 + 乐观锁）', async () => {
    const summary = await runChangesetChecks(makeConn);
    logFailures(summary);
    expect(summary.failed).toBe(0);
    expect(summary.results.filter((r) => !r.skipped)).toHaveLength(5);
  }, 120_000);

  it('cancellation 组（supportsCancel=true，break() → ORA-01013）', async () => {
    const summary = await runCancellationChecks(makeConn, {
      supportsCancel: true,
      // DBMS_SESSION.SLEEP：12.2+ PUBLIC 可执行（DBMS_LOCK 需显式授权，D-23 否决案）
      longQuerySql: (seconds) => `BEGIN DBMS_SESSION.SLEEP(${Math.min(Math.max(seconds, 1), 9)}); END;`,
      probeSql: 'SELECT 1 AS one FROM dual',
    });
    logFailures(summary);
    expect(summary.failed).toBe(0);
    expect(summary.results.filter((r) => !r.skipped)).toHaveLength(3);
  }, 120_000);

  it('sql-value-encoding 组（§5.7 编码往返；空串→NULL 特化断言）', async () => {
    const summary = await runSqlValueEncodingChecks(makeConn, {
      db: USER.toUpperCase(),
      cases: ORACLE_VE_CASES,
      pkDataType: 'NUMBER(9)',
    });
    logFailures(summary);
    expect(summary.failed).toBe(0);
    expect(summary.results.filter((r) => !r.skipped)).toHaveLength(ORACLE_VE_CASES.length + 2);
  }, 120_000);

  it('ddl 组（表结构编辑，Oracle 方言：IDENTITY/两半段/键外键索引 roundtrip）', async () => {
    const summary = await runDdlChecks(makeConn);
    logFailures(summary);
    expect(summary.failed).toBe(0);
    // 原 7 项 + 键/外键/索引段 6 项 - 1（增删外键 skip：Oracle 禁止同形外键重复——契约 fixture 的
    // 追加外键与既有 cf_fk_ref 同形（同列引用同目标），buildAlterTable 连接层探测后按
    // E_UNSUPPORTED 声明边界（ORA-02275），套件 fkAlterSupported=false 走 skip（P-19 口径））
    expect(summary.results.filter((r) => !r.skipped)).toHaveLength(12);
    expect(summary.results.filter((r) => r.skipped)).toHaveLength(1);
  }, 120_000);

  it('relation-graph 组（M8-ER / D-22：单列/复合/自引用 FK + selection 裁剪；动作 deleteCascadeOnly 裁剪）', async () => {
    // Oracle 写侧无 ON UPDATE 语法、ON DELETE 仅 CASCADE/SET NULL（D-23）——动作断言按方言裁剪
    const summary = await runRelationGraphChecks(makeConn, { fkActions: 'deleteCascadeOnly' });
    logFailures(summary);
    expect(summary.failed).toBe(0);
    expect(summary.results.filter((r) => !r.skipped)).toHaveLength(9);
  }, 240_000);

  it('database-ddl 组（M8-DBDDL / D-19：CREATE/DROP USER 周期 + 标识符 fail-closed；无 ALTER 跳过）', async () => {
    const summary = await runDatabaseDdlChecks(createOracleDriver(), makeConn, {
      // CREATE USER 必须携带密码（ADR D-23 岔口 8；套件 createSpec 选项 @since M8-Oracle）
      createSpec: (name) => ({ name, password: `Cf_db_${name.slice(-6)}_pw` }),
    });
    logFailures(summary);
    expect(summary.failed).toBe(0);
    // 实跑 2 项：标识符 fail-closed（supportsSQL）+ create/drop USER 周期；alter 未实现跳过
    expect(summary.results.filter((r) => !r.skipped)).toHaveLength(2);
    expect(summary.results.filter((r) => r.skipped)).toHaveLength(1);
  }, 120_000);

  it('interactive-transaction 组（D-09，Oracle 读不锁写）', async () => {
    const summary = await runInteractiveTransactionChecks(makeConn, {
      insertSql: (k) => `INSERT INTO cf_txn (marker) VALUES ('${k}')`,
      countSql: (k) => `SELECT COUNT(*) AS cnt FROM cf_txn WHERE marker = '${k}'`,
      cleanupSql: (k) => `DELETE FROM cf_txn WHERE marker = '${k}'`,
    });
    logFailures(summary);
    expect(summary.failed).toBe(0);
    expect(summary.results.filter((r) => !r.skipped)).toHaveLength(5);
  }, 120_000);

  it('连接失败映射：错误密码 → E_AUTH；不可达 → E_CONN', async () => {
    const driver = createOracleDriver();
    const badAuth = await driver.testConnection({ ...cfg, id: 'cf-bad-auth' }, 'wrong-password');
    expect(badAuth.ok).toBe(false);
    expect(badAuth.error?.code).toBe('E_AUTH');

    const badConn = await driver.testConnection(
      {
        ...cfg,
        id: 'cf-bad-conn',
        options: { ...cfg.options, port: 59999, connectTimeout: 2000 },
      },
      PASSWORD,
    );
    expect(badConn.ok).toBe(false);
    expect(badConn.error?.code).toBe('E_CONN');
  }, 120_000);
});

/**
 * Oracle 方言值编码用例（驱动规范 §5.7 / C-7 / ADR D-23 岔口 4·6）。
 * 相对 mysql/pg/mssql 用例的如实裁剪与特化（非遗漏）：
 * - c_empty：**空串写入 → 读回 null**（Oracle 无「空串 ≠ NULL」值域——引擎语义测死，非裁剪）
 * - uuid：无原生类型（RAW(16) 形态由 c_bin 承载）；boolean/json：19c 无原生类型（CLOB 文本承载由 c_clob 覆盖）
 * - 时间列用 DATE（秒精度，毫秒补 .000）/TIMESTAMP(3) 承载；TSTZ 读写同经客户端本地时区（往返对称）
 */
const ORACLE_VE_CASES: SqlValueEncodingCase[] = [
  { column: 'c_str', dataType: 'VARCHAR2(64 CHAR)', write: "it's ✓ 汉" },
  { column: 'c_empty', dataType: 'VARCHAR2(64 CHAR)', write: '', read: null },
  { column: 'c_int', dataType: 'NUMBER(9)', write: 42 },
  { column: 'c_bigint', dataType: 'NUMBER(20)', write: '9007199254740993' },
  { column: 'c_dec', dataType: 'NUMBER(12, 2)', write: '12345.67' },
  { column: 'c_float', dataType: 'BINARY_DOUBLE', write: 1.5 },
  { column: 'c_date', dataType: 'DATE', write: '2024-06-01 08:30:00.000' },
  { column: 'c_ts', dataType: 'TIMESTAMP(3)', write: '2024-06-01 08:30:00.123' },
  { column: 'c_tstz', dataType: 'TIMESTAMP(3) WITH TIME ZONE', write: '2024-06-01 08:30:00.123' },
  { column: 'c_bin', dataType: 'RAW(16)', write: 'AAEC/w==' },
  { column: 'c_blob', dataType: 'BLOB', write: 'AAEC/w==' },
  { column: 'c_clob', dataType: 'CLOB', write: '{"k":1,"s":"汉"}' },
];

function logFailures(summary: {
  failed: number;
  results: Array<{ ok: boolean; group: string; name: string; error?: string }>;
}): void {
  const failed = summary.results.filter((r) => !r.ok);
  if (failed.length > 0) {
    console.error(JSON.stringify(failed, null, 2));
    // CI 注记只显示断言/抛错 message——把 check 级失败详情塞进抛错文本（mssql 同款）
    throw new Error(
      `契约组失败 ${failed.length} 项：\n${failed
        .map((f) => `- [${f.group}] ${f.name}: ${f.error ?? '（无错误文本）'}`)
        .join('\n')}`,
    );
  }
}
