import { createRequire } from 'node:module';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MetadataCache } from '../packages/core/src/services/metadataCache';
import type { CompletionSource } from '../packages/core/src/model/rows';
import { MYSQL_DRIVER_ID, createMysqlDriver } from '../packages/driver-mysql/src/index';
import { runBench, type BenchTarget } from './lib/bench';

/**
 * MySQL 基准（概要设计 §9 / §12.4）：环境变量门控（MYSQL_HOST，契约同口径）——
 * 本地无实例 skip、CI perf workflow（workflow_dispatch，mysql:8 service）实跑。
 * 基线首跑只打印实测值（baselines/mysql.json 未录），回填后启用 ×1.2 回归闸。
 */

const req = createRequire(join(process.cwd(), 'packages/driver-mysql/package.json'));
// mysql2/promise 经 driver-mysql 包内依赖解析（perf/ 自身无该依赖）
const createConnection = req('mysql2/promise').default as (typeof import('mysql2/promise'))['createConnection'];

const HOST = process.env.MYSQL_HOST ?? '127.0.0.1';
const PORT = Number(process.env.MYSQL_PORT ?? 3306);
const USER = process.env.MYSQL_USER ?? 'root';
const PASSWORD = process.env.MYSQL_PASSWORD ?? 'root';
const DATABASE = 'perf_test';

const WIDE_COLS = 20;
const WIDE_ROWS = 1000;
const BIG_ROWS = 50_000;

// 本地无 MySQL → 整组 skip（CI 实跑）
const d = process.env.MYSQL_HOST ? describe : describe.skip;

let admin: Awaited<ReturnType<typeof createConnection>> | null = null;

d('mysql perf（§9 四项指标）', () => {
  beforeAll(async () => {
    admin = await createConnection({ host: HOST, port: PORT, user: USER, password: PASSWORD });
    await admin.query(`DROP DATABASE IF EXISTS \`${DATABASE}\``);
    await admin.query(`CREATE DATABASE \`${DATABASE}\``);
  });

  afterAll(async () => {
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS \`${DATABASE}\``).catch(() => undefined);
      await admin.end().catch(() => undefined);
      admin = null;
    }
  });

  it('四项指标过设计阈值与入库基线', async () => {
    const driver = createMysqlDriver();
    const conn = await driver.connect(
      {
        id: 'perf-mysql',
        name: 'MySQL 基准',
        driverId: MYSQL_DRIVER_ID,
        options: { host: HOST, port: PORT, username: USER, database: DATABASE },
        secretRef: 'dbExplorer.secrets.perf-mysql',
      },
      PASSWORD,
    );
    const cache = new MetadataCache();
    const target: BenchTarget = {
      driver: 'mysql',
      db: DATABASE,
      wideObj: 'perf_wide',
      bigObj: 'perf_big',
      async prepare() {
        const wideCols = Array.from({ length: WIDE_COLS - 1 }, (_, i) => `c${i + 1} TEXT`).join(', ');
        await conn.query({ sql: `CREATE TABLE perf_wide (id INT NOT NULL AUTO_INCREMENT PRIMARY KEY, ${wideCols}) ENGINE=InnoDB`, maxRows: 1, timeoutMs: 60_000 });
        for (let batch = 0; batch < WIDE_ROWS / 200; batch++) {
          const tuples = Array.from({ length: 200 }, (_, i) => {
            const id = batch * 200 + i + 1;
            const vals = Array.from({ length: WIDE_COLS - 1 }, (_, c) => `'v${id}-${c + 1}'`).join(', ');
            return `(${vals})`;
          });
          await conn.query({ sql: `INSERT INTO perf_wide (c1, c2, c3, c4, c5, c6, c7, c8, c9, c10, c11, c12, c13, c14, c15, c16, c17, c18, c19) VALUES ${tuples.join(', ')}`, maxRows: 1, timeoutMs: 60_000 });
        }
        await conn.query({ sql: 'CREATE TABLE perf_big (id INT NOT NULL AUTO_INCREMENT PRIMARY KEY, name VARCHAR(64) NOT NULL, val VARCHAR(32), n INT) ENGINE=InnoDB', maxRows: 1, timeoutMs: 60_000 });
        for (let batch = 0; batch < BIG_ROWS / 1000; batch++) {
          const tuples = Array.from({ length: 1000 }, (_, i) => {
            const id = batch * 1000 + i + 1;
            return `('name-${id}', 'v-${id % 100}', ${id % 1000})`;
          });
          await conn.query({ sql: `INSERT INTO perf_big (name, val, n) VALUES ${tuples.join(', ')}`, maxRows: 1, timeoutMs: 120_000 });
        }
      },
      fetchRows: (r) => conn.fetchRows(r),
      applyChanges: (db, obj, cs) => conn.applyChanges(db, obj, cs),
      loadCompletion: async (): Promise<CompletionSource> =>
        cache.getCompletionSource('perf-mysql', DATABASE, () => conn.getCompletionSource(DATABASE)),
      dispose: () => conn.dispose(),
    };
    try {
      const report = await runBench(target);
      expect(report.allOk, report.verdicts.filter((v) => !v.ok).map((v) => `${v.key} 超限：${v.measuredMs}ms`).join('; ')).toBe(true);
    } finally {
      await conn.dispose();
    }
  }, 600_000);
});
