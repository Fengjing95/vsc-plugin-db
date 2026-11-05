import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { afterAll, describe, expect, it } from 'vitest';
import { InProcessDriverHost, type ColumnMeta, type IConnection } from '@db-explorer/core';
import { createSqliteDriver } from '@db-explorer/driver-sqlite';
import type { ConnectionManager } from './connectionManager';
import type { EditGuard } from './editGuard';
import type { MetadataCache } from '@db-explorer/core';
import { ImportTaskRunner, type ImportHostUi, type ImportTaskDeps } from './importTasks';

/**
 * 数据导入 5 万行实跑评估（D-32 实机确认项；P-29/D05 口径：IMPORT_EVAL=1 门控，不进门禁）：
 * IMPORT_EVAL=1 npx vitest run packages/extension/src/services/import.perf.eval.test.ts
 * 断言：50,000 行 CSV（100 批 × 500）经真实 sqlite 驱动（进程内 sql.js）全部落库 + 用时记录。
 */
const sqlJsAvailable = process.env.IMPORT_EVAL === '1';

function writeBigCsv(dir: string, rows: number): string {
  const file = path.join(dir, 'big.csv');
  const lines: string[] = ['id,name,city,created_at'];
  for (let i = 1; i <= rows; i++) {
    lines.push(`${i},n-${i},${i % 2 === 0 ? '北京' : ''},2026-01-01 00:00:00.000`);
  }
  fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8');
  return file;
}

describe.skipIf(!sqlJsAvailable)('ImportTaskRunner 5 万行实跑（D-32 实机确认）', () => {
  let tmpDir: string;

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('50,000 行 × 500/批 → sqlite 全部落库', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbexp-import-eval-'));
    const dbPath = path.join(tmpDir, 'eval.db');
    // 0 字节文件 = 合法新库（driver 打开前魔数校验放行，P-49 口径）
    fs.writeFileSync(dbPath, '');
    const req = createRequire(path.join(process.cwd(), 'package.json'));
    const wasmPath = req.resolve('sql.js/dist/sql-wasm.wasm');
    const driver = createSqliteDriver({ wasmPath, resolvePath: (p) => p });
    const conn: IConnection = await driver.connect(
      {
        id: 'eval',
        name: 'eval',
        driverId: 'sqlite',
        options: { path: dbPath },
        secretRef: 'dbExplorer.secrets.eval',
      },
      '',
    );
    await conn.query({ sql: 'CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT, city TEXT, created_at TEXT)', maxRows: 1, timeoutMs: 5000 });

    const progressEvents: number[] = [];
    let canceled = 0;
    const ui: ImportHostUi = {
      pickImportFile: async () => undefined,
      showProgress: async (_t, onCancel) => {
        void onCancel;
        return { close: () => undefined };
      },
      showMessage: async () => undefined,
    };
    const deps: ImportTaskDeps = {
      ui,
      events: {
        progress: (p) => progressEvents.push(p.written),
        done: (p) => {
          if (p.status === 'canceled') {
            canceled = p.written;
          }
          expect(p.status).toBe('ok');
          expect(p.written).toBe(50_000);
          expect(p.skipped).toBe(0);
        },
      },
      log: () => undefined,
    };
    const runner = new ImportTaskRunner(
      {
        connections: { ensureConnected: async () => conn } as unknown as ConnectionManager,
        host: new InProcessDriverHost(60_000),
        cache: {
          getColumns: async () =>
            [
              ['id', 'integer'],
              ['name', 'string'],
              ['city', 'string'],
              ['created_at', 'datetime'],
            ].map(([name, type], i) => ({
              name: name as string,
              dataType: name as string,
              normalizedType: type as ColumnMeta['normalizedType'],
              nullable: true,
              isPrimaryKey: name === 'id',
              ordinal: i + 1,
            })),
        } as unknown as MetadataCache,
        editGuard: { getPermission: async () => ({ enabled: true }), confirmApply: async () => true } as unknown as EditGuard,
        batchRows: 500,
        timeoutMs: 60_000,
      },
      deps,
    );

    const csv = writeBigCsv(tmpDir, 50_000);
    const started = Date.now();
    const ack = await runner.run({
      connId: 'eval',
      db: 'main',
      obj: 't',
      format: 'csv',
      file: csv,
      mapping: [
        { fileColumn: 'id', tableColumn: 'id', type: 'integer' },
        { fileColumn: 'name', tableColumn: 'name', type: 'string' },
        { fileColumn: 'city', tableColumn: 'city', type: 'string' },
        { fileColumn: 'created_at', tableColumn: 'created_at', type: 'datetime' },
      ],
      emptyAsNull: true,
    });
    // 等待终态（done 事件内断言 50,000 行）
    const deadline = Date.now() + 120_000;
    while (progressEvents.length === 0 || progressEvents[progressEvents.length - 1] < 50_000) {
      if (Date.now() > deadline) {
        throw new Error(`评估超时：最后进度 ${progressEvents[progressEvents.length - 1]}`);
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    const rs = await conn.query({ sql: 'SELECT COUNT(*) AS n FROM t', maxRows: 1, timeoutMs: 5000 });
    expect(rs[0]?.rows[0]?.[0]).toBe(50_000);
    void ack;
    void canceled;
    console.log(`[import-eval] 50,000 行导入用时 ${Date.now() - started}ms，进度事件 ${progressEvents.length} 次`);
    await conn.dispose();
  }, 180_000);
});
