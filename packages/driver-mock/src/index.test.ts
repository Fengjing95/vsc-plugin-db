import { describe, expect, it } from 'vitest';
import { DriverError } from '@db-explorer/core';
import { createMockDriver } from './index';
import type { ConnectionConfig } from '@db-explorer/core';

const cfg: ConnectionConfig = {
  id: 'mock-local',
  name: '本地 Mock',
  driverId: 'mock',
  options: {},
  secretRef: 'dbExplorer.secrets.mock-local',
};

async function connection() {
  const conn = await createMockDriver().connect(cfg, '');
  return conn;
}

describe('driver-mock：M0 可插拔契约演示', () => {
  it('注册即接入（核心 0 改动的验收形态）', () => {
    const driver = createMockDriver();
    expect(driver.id).toBe('mock');
    expect(driver.apiVersion).toBe(1);
    expect(driver.capabilities.hierarchy).toContain('database');
  });

  it('三级结构：连接 → 库 → 表/视图', async () => {
    const conn = await connection();
    const dbs = await conn.listDatabases();
    expect(dbs.map((d) => d.name)).toEqual(['demo', 'analytics', 'big']);

    const objs = await conn.listObjects('demo');
    expect(objs).toHaveLength(4);
    expect(objs.filter((o) => o.kind === 'table').map((o) => o.name).sort()).toEqual([
      'orders',
      'users',
      'wide',
    ]);
    expect(objs.find((o) => o.kind === 'view')?.name).toBe('v_active_users');
  });

  it('M2 性能验收：展开 100 表库 < 1s（概要设计 §10 DoD）', async () => {
    const conn = await connection();
    const started = Date.now();
    const objs = await conn.listObjects('big');
    expect(objs).toHaveLength(100);
    const cols = await conn.listColumns('big', 't001');
    expect(cols).toHaveLength(3);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('getDdl：由元数据生成且包含表名（M2）', async () => {
    const conn = await connection();
    const ddl = await conn.getDdl!('demo', 'users');
    expect(ddl).toContain('CREATE TABLE `users`');
    expect(ddl).toContain('`id` bigint NOT NULL AUTO_INCREMENT');
    expect(ddl).toContain('PRIMARY KEY (`id`)');
    expect(ddl).toContain('UNIQUE KEY `idx_email`');
  });

  it('列元数据含主键标记', async () => {
    const conn = await connection();
    const cols = await conn.listColumns('demo', 'users');
    expect(cols).toHaveLength(4);
    expect(cols.find((c) => c.name === 'id')?.isPrimaryKey).toBe(true);
    expect(cols.map((c) => c.ordinal)).toEqual([1, 2, 3, 4]);
  });

  it('fetchRows：分页与总数', async () => {
    const conn = await connection();
    const page1 = await conn.fetchRows({ db: 'demo', obj: 'users', limit: 10, timeoutMs: 1000 });
    expect(page1.rowCount).toBe(10);
    expect(page1.totalCount).toBe(60);
    expect(page1.primaryKey).toEqual(['id']);

    const page2 = await conn.fetchRows({
      db: 'demo',
      obj: 'users',
      limit: 10,
      offset: 10,
      timeoutMs: 1000,
    });
    expect(page2.rows[0][0]).toBe(11);
  });

  it('fetchRows：排序与筛选下推', async () => {
    const conn = await connection();
    const desc = await conn.fetchRows({
      db: 'demo',
      obj: 'users',
      limit: 1,
      sorts: [{ column: 'id', dir: 'desc' }],
      timeoutMs: 1000,
    });
    expect(desc.rows[0][0]).toBe(60);

    const filtered = await conn.fetchRows({
      db: 'demo',
      obj: 'users',
      limit: 10,
      filters: [{ column: 'name', op: 'eq', value: '用户5' }],
      timeoutMs: 1000,
    });
    expect(filtered.rowCount).toBe(1);
    expect(filtered.rows[0][0]).toBe(5);
  });

  it('fetchRows：orderBySql 片段生效；未含主键时追加主键兜底（P-10）', async () => {
    const conn = await connection();
    const byNameDesc = await conn.fetchRows({
      db: 'demo',
      obj: 'users',
      limit: 2,
      orderBySql: 'name DESC',
      timeoutMs: 1000,
    });
    // name 为字符串序：'用户9' > '用户8' > ... > '用户60'；未含主键 → 主键升序兜底
    expect(byNameDesc.rows[0][0]).toBe(9);
    expect(byNameDesc.rows[1][0]).toBe(8);

    const byIdDesc = await conn.fetchRows({
      db: 'demo',
      obj: 'users',
      limit: 2,
      orderBySql: '`id` DESC',
      timeoutMs: 1000,
    });
    // 片段已含主键 → 不再追加兜底，首两行 60/59
    expect(byIdDesc.rows[0][0]).toBe(60);
    expect(byIdDesc.rows[1][0]).toBe(59);
  });

  it('M3 DoD 数据集：demo.wide 1000×20、big 库单表 5 万行', async () => {
    const conn = await connection();
    const wide = await conn.fetchRows({ db: 'demo', obj: 'wide', limit: 1, timeoutMs: 1000 });
    expect(wide.columns).toHaveLength(20);
    expect(wide.rows[0]).toHaveLength(20);
    expect(wide.totalCount).toBe(1000);

    const big = await conn.fetchRows({ db: 'big', obj: 't001', limit: 1, timeoutMs: 1000 });
    expect(big.totalCount).toBe(50_000);
  });

  it('不存在的表 → E_NOT_FOUND', async () => {
    const conn = await connection();
    const err = await conn
      .fetchRows({ db: 'demo', obj: 'nope', limit: 1, timeoutMs: 1000 })
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(DriverError.is(err)).toBe(true);
    expect(err && DriverError.is(err) && err.code).toBe('E_NOT_FOUND');
  });
});
