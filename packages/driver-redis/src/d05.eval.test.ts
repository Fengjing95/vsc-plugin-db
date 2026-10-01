import { createClient } from 'redis';
import { describe, it } from 'vitest';
import { createRedisDriver } from './index';

/**
 * D-05 复核实测（概要设计 §7.6 / ADR D-05 裁决时点 = M6）——非门禁用例：
 *   D05_EVAL=1 npx vitest run packages/driver-redis/src/d05.eval.test.ts
 * 触发条件 1：驱动 CPU 密集操作（大结果集解析/序列化）导致 UI 命令响应 P95 > 200ms
 * 触发条件 2：某驱动 native 依赖崩溃（node-redis 纯 JS，天然不满足）
 * 方法：进程内并发——大结果集取数进行中，同进程模拟 UI 命令（ping），测 P95。
 * 结论写回 docs/概要设计.md 的 D-05 追加复核记录。
 */
const HOST = process.env.REDIS_HOST ?? '127.0.0.1';
const PORT = Number(process.env.REDIS_PORT ?? 6379);
const FIELDS = 50_000;
const KEY_COUNT = 20_000;
const BIG_VALUE = 'x'.repeat(1024 * 1024); // 1MB string

const fmt = (ms: number): string => `${ms.toFixed(1)}ms`;
const percentile = (xs: number[], p: number): number => xs[Math.min(xs.length - 1, Math.floor((xs.length * p) / 100))];

describe.skipIf(!process.env.D05_EVAL)('D-05 复核实测（手动触发）', () => {
  it(
    '大结果集序列化不阻塞进程内 UI 命令（§7.6 条件 1）',
    async () => {
      const admin = createClient({ socket: { host: HOST, port: PORT } });
      await admin.connect();
      try {
        console.log(`[seed] hash d05:big ${FIELDS} fields…`);
        const batch = admin.multi();
        for (let i = 0; i < FIELDS; i++) {
          batch.hSet('d05:big', `f${i}`, `v${i}-${BIG_VALUE.slice(0, 12)}`);
        }
        await batch.exec();
        console.log(`[seed] ${KEY_COUNT} string keys…`);
        for (let c = 0; c < KEY_COUNT / 1000; c++) {
          const b = admin.multi();
          for (let i = 0; i < 1000; i++) {
            b.set(`d05:k${c * 1000 + i}`, BIG_VALUE.slice(0, 64));
          }
          await b.exec();
        }
        await admin.set('d05:str-1mb', BIG_VALUE);

        const driver = createRedisDriver();
        const conn = await driver.connect(
          { id: 'd05', name: 'd05', driverId: 'redis', options: { host: HOST, port: PORT }, secretRef: 'x' },
          '',
        );

        const idlePings: number[] = [];
        for (let i = 0; i < 50; i++) {
          const t = performance.now();
          await conn.ping();
          idlePings.push(performance.now() - t);
        }
        idlePings.sort((a, b) => a - b);
        console.log(`[idle] ping P50=${fmt(percentile(idlePings, 50))} P95=${fmt(percentile(idlePings, 95))}`);

        const t0 = performance.now();
        const rs1 = await conn.fetchRows({ db: 'db0', obj: 'd05:str-1mb', limit: 10, timeoutMs: 30_000 });
        console.log(`[A] fetchRows 1MB string：${fmt(performance.now() - t0)}（bytes=${String(rs1.rows[0]![0]).length}）`);

        const timesB: number[] = [];
        for (let i = 0; i < 5; i++) {
          const t = performance.now();
          await conn.fetchRows({ db: 'db0', obj: 'd05:big', limit: 5000, timeoutMs: 30_000 });
          timesB.push(performance.now() - t);
        }
        timesB.sort((a, b) => a - b);
        console.log(`[B] fetchRows hash 5000 行 ×5：min=${fmt(timesB[0]!)} max=${fmt(timesB[4]!)}`);

        const t2 = performance.now();
        const rs3 = await conn.fetchRows({ db: 'db0', obj: 'd05:k*', limit: 5000, timeoutMs: 60_000 });
        console.log(`[C] fetchRows 模式 5000 键：${fmt(performance.now() - t2)}（rowCount=${rs3.rowCount}）`);

        const bigFetch = conn.fetchRows({ db: 'db0', obj: 'd05:big', limit: 50_000, timeoutMs: 60_000 });
        const concurrentPings: number[] = [];
        await new Promise((r) => setTimeout(r, 30));
        for (let i = 0; i < 50; i++) {
          const t = performance.now();
          await conn.ping();
          concurrentPings.push(performance.now() - t);
          await new Promise((r) => setTimeout(r, 10));
        }
        const rsBig = await bigFetch;
        concurrentPings.sort((a, b) => a - b);
        const p95 = percentile(concurrentPings, 95);
        console.log(
          `[D] 5 万行取数（rowCount=${rsBig.rowCount}）进行中：ping P50=${fmt(percentile(concurrentPings, 50))} P95=${fmt(p95)} → 条件1（P95>200ms）：${p95 > 200 ? '触发' : '未触发'}`,
        );
        console.log('[E] node-redis 为纯 JS 实现（无 .node 原生模块）→ 条件 2 天然不满足');

        await conn.dispose();
      } finally {
        await admin.del('d05:big');
        await admin.del('d05:str-1mb');
        let cursor = '0';
        do {
          const { cursor: next, keys } = await admin.scan(cursor, { MATCH: 'd05:k*', COUNT: 2000 });
          cursor = next;
          if (keys.length) {
            await admin.del(keys);
          }
        } while (cursor !== '0');
        await admin.quit();
        console.log('[cleanup] done');
      }
    },
    { timeout: 300_000 },
  );
});
