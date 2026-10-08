import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'vitest';
import { openEngine } from './engine';
import { createSqliteDriver } from './index';

/**
 * D-05 复核实测（概要设计 §7.6 / ADR D-05）——非门禁用例：
 *   D05_EVAL=1 npx vitest run packages/driver-sqlite/src/d05.eval.test.ts
 * 触发条件 1：驱动同步执行（sql.js 整库载入/大查询/落盘序列化）期间 UI 命令 P95 > 200ms
 * 触发条件 2：native 依赖崩溃——sql.js 为 WASM 纯 JS 加载，无 .node 模块，天然不满足
 * 方法：进程内并发——重操作启动后按 10ms 间隔调度模拟 UI 命令（ping）；sql.js 同步执行
 * 阻塞事件循环，微任务边界不能插入 timer，故 ping 实测延迟 ≈ 其调度点距事件循环空出的
 * 等待时长（含被阻塞窗口）——即 UI 命令的真实体感延迟。
 * 结论写回 docs/概要设计.md 的 D-05 追加复核记录。
 */

const requireSelf = createRequire(import.meta.url);

const WASM = requireSelf.resolve('sql.js/dist/sql-wasm.wasm');
const ROWS_SMALL = 6_000; // ~6MB 文件
const ROWS_BIG = 50_000; // ~50MB 文件
const DATA = 'x'.repeat(1_000);

const fmt = (ms: number): string => `${ms.toFixed(1)}ms`;
const percentile = (xs: number[], p: number): number =>
  xs[Math.min(xs.length - 1, Math.floor((xs.length * p) / 100))];

async function seedDb(dbPath: string, rows: number): Promise<void> {
  writeFileSync(dbPath, Buffer.alloc(0)); // 0 字节 = 合法新库（驱动不自动创建）
  const engine = await openEngine(dbPath, { wasmPath: WASM });
  engine.exec('CREATE TABLE t (id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT, data TEXT NOT NULL)');
  // 一次多行 INSERT 100 行（200 参数），最后统一 export 一次（不经连接层落盘，避免写放大干扰建库）
  for (let i = 0; i < rows; i += 100) {
    const n = Math.min(100, rows - i);
    const placeholders = Array.from({ length: n }, () => '(?)').join(', ');
    engine.query(`INSERT INTO t (data) VALUES ${placeholders}`, Array.from({ length: n }, () => DATA));
  }
  writeFileSync(dbPath, engine.exportBytes());
  engine.close();
}

/**
 * 在 heavy 启动后按间隔调度模拟 UI 命令，测「调度 → 实际执行」的体感延迟：
 * sql.js 同步工作在微任务突发内完成（timer 无法插入），窗口内调度的命令只能等事件循环空出——
 * 实际执行时刻 - 计划执行时刻 = 被同步窗口阻塞的等待时长（UI 体感延迟）。
 */
async function pingsDuring(heavy: Promise<unknown>, count = 20, gapMs = 10): Promise<number[]> {
  const t0 = performance.now();
  const samples: Promise<number>[] = [];
  for (let i = 0; i < count; i++) {
    const due = gapMs * (i + 1);
    samples.push(
      new Promise<number>((resolve) => {
        setTimeout(() => {
          resolve(performance.now() - t0 - due);
        }, due);
      }),
    );
  }
  void (await heavy);
  return (await Promise.all(samples)).sort((a, b) => a - b);
}

describe.skipIf(!process.env.D05_EVAL)('D-05 复核实测（手动触发）', () => {
  it(
    'sql.js 同步执行对 UI 命令的阻塞实测（§7.6 条件 1）',
    async () => {
      const driver = createSqliteDriver({ wasmPath: WASM });
      const dir = mkdtempSync(join(tmpdir(), 'dbx-sqlite-d05-'));
      try {
        // 空载基线
        const tiny = join(dir, 'tiny.db');
        writeFileSync(tiny, Buffer.alloc(0));
        const tinyConn = await driver.connect(
          { id: 'd05-tiny', name: 'd05', driverId: 'sqlite', options: { path: tiny }, secretRef: 'x' },
          '',
        );
        const idle: number[] = [];
        for (let i = 0; i < 50; i++) {
          const t = performance.now();
          await tinyConn.ping();
          idle.push(performance.now() - t);
        }
        idle.sort((a, b) => a - b);
        await tinyConn.dispose();
        console.log(
          `[idle] 空载 ping P50=${fmt(percentile(idle, 50))} P95=${fmt(percentile(idle, 95))}（基线）`,
        );

        // 建库（引擎直写，最后一次性序列化）
        console.log('[seed] 建库中…');
        const small = join(dir, 'small.db');
        await seedDb(small, ROWS_SMALL);
        const big = join(dir, 'big.db');
        await seedDb(big, ROWS_BIG);

        const cfgOf = (id: string, path: string) => ({
          id,
          name: id,
          driverId: 'sqlite',
          options: { path },
          secretRef: 'x',
        });

        // [A] 打开 = 整库载入内存（连接建立含首次打开）
        const tSmall0 = performance.now();
        const smallConn = await driver.connect(cfgOf('d05-small', small), '');
        const openSmall = performance.now() - tSmall0;
        const tBig0 = performance.now();
        const bigConn = await driver.connect(cfgOf('d05-big', big), '');
        const openBig = performance.now() - tBig0;
        console.log(`[A] 整库载入：~6MB=${fmt(openSmall)} ~40MB=${fmt(openBig)}`);

        // [B] 大分页取数期间的 ping 延迟（同步阻塞窗口）
        const bigFetch = bigConn.fetchRows({ db: 'main', obj: 't', limit: 50_000, timeoutMs: 60_000 });
        const during = await pingsDuring(bigFetch);
        const tFetch = performance.now();
        const rs = await bigConn.fetchRows({ db: 'main', obj: 't', limit: 50_000, timeoutMs: 60_000 });
        const fetchMs = performance.now() - tFetch;
        console.log(
          `[B] 5 万行取数=${fmt(fetchMs)}（rowCount=${rs.rowCount}）；取数期间调度的模拟 UI 命令体感延迟 P50=${fmt(percentile(during, 50))} P95=${fmt(percentile(during, 95))} → 条件1（P95>200ms）：${percentile(during, 95) > 200 ? '触发' : '未触发'}`,
        );

        // [C] 写批次落盘成本（100 行 applyChanges，单批次原子覆写整库）
        const values = Array.from({ length: 100 }, (_, i) => ({
          tempId: `p${i}`,
          values: { data: 'y'.repeat(1_000) },
        }));
        const tWrite = performance.now();
        await bigConn.applyChanges('main', 't', { inserts: values, updates: [], deletes: [] });
        const writeMs = performance.now() - tWrite;
        console.log(`[C] applyChanges 100 行（含整库原子落盘）=${fmt(writeMs)}`);

        // [D] 单条小查询（中小库典型语句的阻塞窗口量级）
        const tQ = performance.now();
        await bigConn.query({ sql: 'SELECT COUNT(*) FROM t', db: 'main', maxRows: 1, timeoutMs: 60_000 });
        console.log(`[D] 40MB 库单条 COUNT(*)（全表扫描）=${fmt(performance.now() - tQ)}`);

        await smallConn.dispose();
        await bigConn.dispose();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    { timeout: 300_000 },
  );
});
