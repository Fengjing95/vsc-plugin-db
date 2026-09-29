import { expect, it } from 'vitest';
import { createMockDriver } from './index';

const cfg = { id: 'perf', name: 'perf', driverId: 'mock', options: {}, secretRef: 's' } as const;

/** M3 DoD（概要设计 §10）：1000 行×20 列打开 <1.5s；5 万行分页取尽吞吐 */
it('M3 DoD-1：1000 行 × 20 列取数 <1.5s', async () => {
  const conn = await createMockDriver().connect({ ...cfg }, '');
  const t0 = Date.now();
  const rs = await conn.fetchRows({ db: 'demo', obj: 'wide', limit: 1000, timeoutMs: 15000 });
  const ms = Date.now() - t0;
  expect(rs.rowCount).toBe(1000);
  expect(rs.columns).toHaveLength(20);
  expect(ms).toBeLessThan(1500);
  await conn.dispose();
});

it('M3 DoD-2：5 万行分页取尽（500 行/页 × 100 页）', async () => {
  const conn = await createMockDriver().connect({ ...cfg }, '');
  const t0 = Date.now();
  let total = 0;
  let page = 0;
  for (;;) {
    const rs = await conn.fetchRows({ db: 'big', obj: 't001', limit: 500, offset: page * 500, timeoutMs: 15000 });
    total += rs.rowCount;
    if (rs.rowCount < 500) break;
    page++;
  }
  expect(total).toBe(50_000);
  expect(Date.now() - t0).toBeLessThan(5000);
  await conn.dispose();
});

it('筛选/排序/搜索组合下推返回一致结果', async () => {
  const conn = await createMockDriver().connect({ ...cfg }, '');
  const rs = await conn.fetchRows({
    db: 'demo',
    obj: 'wide',
    limit: 500,
    filters: [
      { column: 'category', op: 'eq', value: 'vip' },
      { column: 'id', op: 'lt', value: 500 },
    ],
    sorts: [{ column: 'id', dir: 'desc' }],
    search: '用户1',
    timeoutMs: 15000,
  });
  // id<500 且 name 含 "用户1" 且 category=vip：vip 行满足 id ≡ 1 (mod 3)
  let prevId = Number.POSITIVE_INFINITY;
  expect(rs.rows.length).toBeGreaterThan(0);
  for (const row of rs.rows) {
    const id = row[0] as number;
    expect(id).toBeLessThan(500);
    expect((id - 1) % 3).toBe(0);
    expect(row[1]).toContain('用户1');
    expect(row[3]).toBe('vip');
    expect(id).toBeLessThan(prevId); // desc 排序
    prevId = id;
  }
  await conn.dispose();
});
