import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MetadataCache } from '../packages/core/src/services/metadataCache';
import type { CompletionSource } from '../packages/core/src/model/rows';
import { SQLITE_DRIVER_ID, createSqliteDriver } from '../packages/driver-sqlite/src/index';
import { runBench, type BenchTarget } from './lib/bench';

/**
 * SQLite 基准（概要设计 §9 / §12.4）：sql.js 进程内零网络依赖，本地恒跑。
 * 门禁不感知本目录（根 vitest 只收 packages 各自 src 下的测试）；独立入口 `pnpm perf`。
 * 断言 = §9 设计绝对阈值 + baselines/sqlite.json 入库基线 ×1.2 双闸（PERF_RECORD=1 重录）。
 */

// sql.js wasm 经 driver-sqlite 包内依赖解析（perf/ 自身无该依赖，锚定其 package.json）
const req = createRequire(join(process.cwd(), 'packages/driver-sqlite/package.json'));
const wasmPath = req.resolve('sql.js/dist/sql-wasm.wasm');

const WIDE_COLS = 20; // 含主键 id
const WIDE_ROWS = 1000;
const BIG_ROWS = 50_000;

let dir: string;
let dbPath: string;
let target: BenchTarget & { dbPath: string };

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'dbx-perf-sqlite-'));
  dbPath = join(dir, 'perf.db');
  writeFileSync(dbPath, Buffer.alloc(0)); // 0 字节 = 合法新库（§5.4）
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('sqlite perf（§9 四项指标）', () => {
  it('四项指标过设计阈值与入库基线', async () => {
    const driver = createSqliteDriver({ wasmPath });
    const conn = await driver.connect(
      { id: 'perf-sqlite', name: 'SQLite 基准', driverId: SQLITE_DRIVER_ID, options: { path: dbPath }, secretRef: 'dbExplorer.secrets.perf-sqlite' },
      '',
    );
    const cache = new MetadataCache();
    let disposed = false;
    target = {
      driver: 'sqlite',
      db: 'main',
      wideObj: 'perf_wide',
      bigObj: 'perf_big',
      dbPath,
      async prepare() {
        // wide：1000 行 × 20 列（id + c1..c19）
        const wideCols = Array.from({ length: WIDE_COLS - 1 }, (_, i) => `c${i + 1} TEXT`).join(', ');
        await conn.query({ sql: `CREATE TABLE perf_wide (id INTEGER PRIMARY KEY AUTOINCREMENT, ${wideCols})`, maxRows: 1, timeoutMs: 60_000 });
        for (let batch = 0; batch < WIDE_ROWS / 200; batch++) {
          const tuples = Array.from({ length: 200 }, (_, i) => {
            const id = batch * 200 + i + 1;
            const vals = Array.from({ length: WIDE_COLS - 1 }, (_, c) => `'v${id}-${c + 1}'`).join(', ');
            return `(${vals})`;
          });
          await conn.query({ sql: `INSERT INTO perf_wide (c1, c2, c3, c4, c5, c6, c7, c8, c9, c10, c11, c12, c13, c14, c15, c16, c17, c18, c19) VALUES ${tuples.join(', ')}`, maxRows: 1, timeoutMs: 60_000 });
        }
        // big：5 万行（id 主键 + name/val/n；name-<id> 供提交指标的原值匹配）
        await conn.query({ sql: 'CREATE TABLE perf_big (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, val TEXT, n INTEGER)', maxRows: 1, timeoutMs: 60_000 });
        for (let batch = 0; batch < BIG_ROWS / 500; batch++) {
          const tuples = Array.from({ length: 500 }, (_, i) => {
            const id = batch * 500 + i + 1;
            return `('name-${id}', 'v-${id % 100}', ${id % 1000})`;
          });
          await conn.query({ sql: `INSERT INTO perf_big (name, val, n) VALUES ${tuples.join(', ')}`, maxRows: 1, timeoutMs: 60_000 });
        }
      },
      fetchRows: (req) => conn.fetchRows(req),
      applyChanges: (db, obj, cs) => conn.applyChanges(db, obj, cs),
      loadCompletion: async (): Promise<CompletionSource> =>
        cache.getCompletionSource('perf-sqlite', 'main', () => conn.getCompletionSource('main')),
      async dispose() {
        if (disposed) return;
        disposed = true;
        await conn.dispose();
      },
    };
    try {
      const report = await runBench(target);
      expect(report.allOk, report.verdicts.filter((v) => !v.ok).map((v) => `${v.key} 超限：${v.measuredMs}ms`).join('; ')).toBe(true);
    } finally {
      await target.dispose();
    }
  });
});
