import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  runChangesetChecks,
  runConnectionChecks,
  runDdlChecks,
  runFilterPushdownChecks,
  runInteractiveTransactionChecks,
  runMetadataChecks,
  runPaginationChecks,
  runSqlValueEncodingChecks,
  type SqlValueEncodingCase,
} from '@db-explorer/driver-conformance';
import { createSqliteDriver, SQLITE_DRIVER_ID } from './index';

/**
 * SQLite 契约测试（驱动规范 §11）：进程内实跑（临时 .db 文件，无需数据库实例）。
 * 引擎随驱动固定（sql.js 内嵌 SQLite，D-16），本地与 CI 同一套件恒跑，无需门控。
 * fixture：cf_* 前缀表（临时目录内 .db 文件，afterAll 整目录清理），禁止触碰其他文件。
 * 种子数据经 applyChanges 参数化写入（P-9：测试数据亦走参数化）；
 * 字符串种子全小写——SQLite LIKE 大小写不敏感（§5.4），契约内存基准为大小写敏感 includes。
 */

const requireSelf = createRequire(import.meta.url);

const SEED_ROWS = 25;

const SEED_AVATAR = Buffer.from([0x00, 0x01, 0xff, 0x2a]).toString('base64');

interface Fixture {
  dir: string;
  dbPath: string;
}

function makeFixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'dbx-sqlite-cf-'));
  const dbPath = join(dir, 'cf.db');
  // 0 字节文件 = SQLite 合法新库（§5.4：驱动不自动创建，测试自备空文件）
  writeFileSync(dbPath, Buffer.alloc(0));
  return { dir, dbPath };
}

function cfgOf(f: Fixture, id: string) {
  return {
    id,
    name: `SQLite 契约（${id}）`,
    driverId: SQLITE_DRIVER_ID,
    options: { path: f.dbPath },
    secretRef: `dbExplorer.secrets.${id}`,
  };
}

/** 建表 + 种子（经驱动自身 query/applyChanges，顺带自证语句链路与多批次落盘） */
async function seed(dbPath: string, wasmPath?: string): Promise<void> {
  const driver = createSqliteDriver({ wasmPath });
  const cfg = cfgOf({ dbPath, dir: '' }, 'conformance-seed');
  const conn = await driver.connect(cfg, '');
  try {
    await conn.query({
      sql: `CREATE TABLE IF NOT EXISTS cf_users (
        id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        email TEXT,
        age INTEGER,
        balance NUMERIC(12, 2) NOT NULL,
        status TEXT NOT NULL,
        data TEXT,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        avatar BLOB
      )`,
      db: 'main',
      maxRows: 1,
      timeoutMs: 8000,
    });
    await conn.query({
      sql: 'CREATE TABLE IF NOT EXISTS cf_txn (id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT, marker TEXT NOT NULL)',
      db: 'main',
      maxRows: 1,
      timeoutMs: 8000,
    });
    // 分批 applyChanges（每批 5 行，覆盖多批次落盘）
    for (let batch = 0; batch < SEED_ROWS / 5; batch++) {
      const inserts = [];
      for (let i = batch * 5 + 1; i <= batch * 5 + 5; i++) {
        inserts.push({
          tempId: `seed-${i}`,
          values: {
            name: `user-${String(i).padStart(2, '0')}`,
            email: i % 5 === 0 ? null : `user${i}@example.com`,
            age: i % 7 === 0 ? null : 20 + i,
            balance: (i * 1.5).toFixed(2),
            status: i % 2 === 0 ? 'active' : 'inactive',
            data: i % 4 === 0 ? null : JSON.stringify({ idx: i, tags: ['a', 'b'] }),
            created_at: '2024-06-01 08:30:00.000',
            avatar: i % 6 === 0 ? null : SEED_AVATAR,
          },
        });
      }
      await conn.applyChanges('main', 'cf_users', { inserts, updates: [], deletes: [] });
    }
  } finally {
    await conn.dispose();
  }
}

/** SQLite 方言值编码用例（驱动规范 §5.4） */
const SQLITE_VE_CASES: SqlValueEncodingCase[] = [
  { column: 'c_str', dataType: 'TEXT', write: "it's ✓ 汉" },
  { column: 'c_empty', dataType: 'TEXT', write: '' },
  { column: 'c_int', dataType: 'INTEGER', write: 42 },
  { column: 'c_bigint', dataType: 'INTEGER', write: '9007199254740993' },
  { column: 'c_dec', dataType: 'NUMERIC', write: '42.42' },
  { column: 'c_float', dataType: 'DOUBLE', write: 1.5 },
  { column: 'c_bool', dataType: 'BOOLEAN', write: true },
  { column: 'c_date', dataType: 'DATE', write: '2024-06-01' },
  { column: 'c_time', dataType: 'TIME', write: '08:30:00.000' },
  { column: 'c_ts', dataType: 'DATETIME', write: '2024-06-01 08:30:00.000' },
  { column: 'c_json', dataType: 'json', write: { k: 1, arr: [1, 2, null], s: '汉' } },
  { column: 'c_bin', dataType: 'BLOB', write: 'AAEC/w==' },
];

function logFailures(summary: { failed: number; results: Array<{ ok: boolean; name: string; error?: string }> }): void {
  if (summary.failed > 0) {
    console.error(JSON.stringify(summary.results.filter((r) => !r.ok), null, 2));
  }
}

describe('sqlite conformance（sql.js 引擎，进程内实跑）', () => {
  let fixture: Fixture;
  let wasmPath: string | undefined;
  try {
    wasmPath = requireSelf.resolve('sql.js/dist/sql-wasm.wasm');
  } catch {
    wasmPath = undefined;
  }

  beforeAll(async () => {
    fixture = makeFixture();
    await seed(fixture.dbPath, wasmPath);
  });

  afterAll(() => {
    rmSync(fixture.dir, { recursive: true, force: true });
  });

  const makeConn = () => createSqliteDriver({ wasmPath }).connect(cfgOf(fixture, 'conformance-sqlite'), '');

  it('connection 组', async () => {
    const summary = await runConnectionChecks(makeConn);
    logFailures(summary);
    expect(summary.failed).toBe(0);
    expect(summary.results.filter((r) => !r.skipped)).toHaveLength(3);
  });

  it('metadata 组（D-16：listDatabases 恒 main）', async () => {
    const summary = await runMetadataChecks(makeConn);
    logFailures(summary);
    expect(summary.failed).toBe(0);
    const conn = await makeConn();
    try {
      const dbs = await conn.listDatabases();
      expect(dbs.map((x) => x.name)).toEqual(['main']);
    } finally {
      await conn.dispose();
    }
  });

  it('pagination 组（offset + 主键兜底序，P-10）', async () => {
    const summary = await runPaginationChecks(makeConn);
    logFailures(summary);
    expect(summary.failed).toBe(0);
    expect(summary.results.filter((r) => !r.skipped)).toHaveLength(4);
  });

  it('filter-pushdown 组（13 FilterOp + 组合 + search + whereSql）', async () => {
    const summary = await runFilterPushdownChecks(makeConn, { supportsWhereSql: true });
    logFailures(summary);
    expect(summary.failed).toBe(0);
    expect(summary.results.filter((r) => !r.skipped)).toHaveLength(16);
  });

  it('changeset 组（短事务 + RETURNING 回填 + 乐观锁 + IS NULL）', async () => {
    const summary = await runChangesetChecks(makeConn);
    logFailures(summary);
    expect(summary.failed).toBe(0);
    expect(summary.results.filter((r) => !r.skipped)).toHaveLength(5);
  });

  it('sql-value-encoding 组（§5.4 编码往返）', async () => {
    const summary = await runSqlValueEncodingChecks(makeConn, {
      db: 'main',
      fixtureTable: 'cf_valenc_t',
      pkDataType: 'bigint',
      cases: SQLITE_VE_CASES,
    });
    logFailures(summary);
    expect(summary.failed).toBe(0);
    expect(summary.results.filter((r) => !r.skipped)).toHaveLength(SQLITE_VE_CASES.length + 2);
  });

  it('ddl 组（表结构编辑：加列/删列/PK 重建，SQLite 方言）', async () => {
    const summary = await runDdlChecks(makeConn);
    logFailures(summary);
    expect(summary.failed).toBe(0);
    expect(summary.results.filter((r) => !r.skipped)).toHaveLength(7);
  });

  it('interactive-transaction 组（D-09；commit 落盘对其他连接可见）', async () => {
    const summary = await runInteractiveTransactionChecks(makeConn, {
      insertSql: (k) => `INSERT INTO cf_txn (marker) VALUES ('${k}')`,
      countSql: (k) => `SELECT COUNT(*) FROM cf_txn WHERE marker = '${k}'`,
      cleanupSql: (k) => `DELETE FROM cf_txn WHERE marker = '${k}'`,
    });
    logFailures(summary);
    expect(summary.failed).toBe(0);
    expect(summary.results.filter((r) => !r.skipped)).toHaveLength(5);
  });

  it('连接失败映射：文件不存在 → E_NOT_FOUND；非 SQLite 文件 → E_VALIDATION', async () => {
    const driver = createSqliteDriver({ wasmPath });
    const missing = await driver.testConnection(
      { ...cfgOf(fixture, 'cf-missing'), options: { path: join(fixture.dir, 'no-such.db') } },
      '',
    );
    expect(missing.ok).toBe(false);
    expect(missing.error?.code).toBe('E_NOT_FOUND');

    const junkPath = join(fixture.dir, 'junk.db');
    writeFileSync(junkPath, Buffer.from('definitely not a sqlite database file'));
    const junk = await driver.testConnection({ ...cfgOf(fixture, 'cf-junk'), options: { path: junkPath } }, '');
    expect(junk.ok).toBe(false);
    expect(junk.error?.code).toBe('E_VALIDATION');
  });

  it('写批次后原子落盘（D-16）：提交 → 断开 → 重连读回', async () => {
    const driver = createSqliteDriver({ wasmPath });
    const cfg = cfgOf(fixture, 'cf-persist');
    const conn = await driver.connect(cfg, '');
    const marker = `persist-${Date.now()}`;
    await conn.applyChanges('main', 'cf_txn', {
      inserts: [{ tempId: 'p1', values: { marker } }],
      updates: [],
      deletes: [],
    });
    await conn.dispose();

    const reopened = await driver.connect(cfg, '');
    try {
      const rs = await reopened.query({
        sql: `SELECT COUNT(*) FROM cf_txn WHERE marker = '${marker}'`,
        db: 'main',
        maxRows: 1,
        timeoutMs: 8000,
      });
      expect(Number(rs[0]?.rows[0]?.[0])).toBe(1);
    } finally {
      await reopened.dispose();
    }
  });
});
