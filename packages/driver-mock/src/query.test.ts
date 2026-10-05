import { beforeEach, describe, expect, it } from 'vitest';
import { DriverError, type QueryRequest } from '@db-explorer/core';
import { MockConnection, resetMockStore } from './index';

/**
 * M5 mock 驱动最小 query（Console 自测路径）：
 * SELECT/INSERT/UPDATE/DELETE 子集 + 值编码 + E_UNSUPPORTED 兜底。
 * P-18：共享物化存储，写操作跨连接可见 → 每个用例前 resetMockStore()。
 */

function makeConn(): MockConnection {
  return new MockConnection({
    id: 'q-test',
    name: 'q',
    driverId: 'mock',
    options: {},
    secretRef: 'dbExplorer.secrets.q-test',
  });
}

function req(sql: string, db = 'demo'): QueryRequest {
  return { sql, db, maxRows: 1000, timeoutMs: 5000 };
}

describe('mock query：SELECT', () => {
  beforeEach(() => resetMockStore());

  it('SELECT * 带列类型与行数', async () => {
    const [rs] = await makeConn().query(req('SELECT * FROM users'));
    expect(rs.columns.map((c) => c.name)).toEqual(['id', 'name', 'email', 'created_at']);
    expect(rs.columns[0].type).toBe('integer');
    expect(rs.rowCount).toBe(60);
    expect(rs.rows[0]).toEqual([1, '用户1', 'user1@example.com', '2024-01-01 08:00:00']);
  });

  it('WHERE 复用 whereEval 语义（三值逻辑）', async () => {
    const [rs] = await makeConn().query(req("SELECT id FROM users WHERE id <= 3 AND name = '用户2'"));
    expect(rs.rowCount).toBe(1);
    expect(rs.rows[0]).toEqual([2]);
  });

  it('ORDER BY + LIMIT/OFFSET', async () => {
    const [rs] = await makeConn().query(req('SELECT id FROM demo.orders ORDER BY amount DESC LIMIT 2 OFFSET 1'));
    expect(rs.rowCount).toBe(2);
    const amounts = rs.rows.map((r) => Number(r[0]));
    expect(amounts).toEqual([29, 28]); // amount = id*15 降序，跳过第一名
  });

  it('COUNT(*)', async () => {
    const [rs] = await makeConn().query(req('SELECT COUNT(*) FROM demo.orders'));
    expect(rs.columns[0].name).toBe('COUNT(*)');
    expect(rs.rows).toEqual([[30]]);
  });

  it('库限定表名优先于连接默认库', async () => {
    const [rs] = await makeConn().query(req('SELECT COUNT(*) FROM analytics.events', 'demo'));
    expect(rs.rows).toEqual([[10]]);
  });

  it('表不存在 → E_NOT_FOUND；未知列 → E_VALIDATION', async () => {
    await expect(makeConn().query(req('SELECT * FROM nope'))).rejects.toMatchObject({ code: 'E_NOT_FOUND' });
    await expect(makeConn().query(req('SELECT nope FROM users'))).rejects.toMatchObject({ code: 'E_VALIDATION' });
  });
});

describe('mock query：写语句', () => {
  beforeEach(() => resetMockStore());

  it('INSERT 回填自增主键并持久到存储', async () => {
    const conn = makeConn();
    const [rs] = await conn.query(req("INSERT INTO users (name, email) VALUES ('甲', 'a@x.com'), ('乙', 'b@x.com')"));
    expect(rs.affectedRows).toBe(2);
    const [check] = await conn.query(req('SELECT COUNT(*) FROM users'));
    expect(check.rows).toEqual([[62]]); // 60 + 2
    const [last] = await conn.query(req('SELECT id FROM users ORDER BY id DESC LIMIT 1'));
    expect(last.rows).toEqual([[62]]); // 自增水位接续
  });

  it('UPDATE 带 WHERE 只改匹配行', async () => {
    const conn = makeConn();
    const [rs] = await conn.query(req("UPDATE users SET email = 'x@x.com' WHERE id = 5"));
    expect(rs.affectedRows).toBe(1);
    const [check] = await conn.query(req('SELECT email FROM users WHERE id = 5'));
    expect(check.rows).toEqual([['x@x.com']]);
  });

  it('UPDATE 无 WHERE 影响全表（Console 危险横幅前置确认）', async () => {
    const conn = makeConn();
    const [rs] = await conn.query(req("UPDATE orders SET status = 'paid'"));
    expect(rs.affectedRows).toBe(30);
  });

  it('DELETE 带 WHERE 删除匹配行', async () => {
    const conn = makeConn();
    const [rs] = await conn.query(req('DELETE FROM orders WHERE id > 25'));
    expect(rs.affectedRows).toBe(5);
    const [check] = await conn.query(req('SELECT COUNT(*) FROM orders'));
    expect(check.rows).toEqual([[25]]);
  });

  it('会话状态语句 → E_UNSUPPORTED（P1-5：mock 不支持 SET/USE）', async () => {
    await expect(makeConn().query(req('SET @x = 1'))).rejects.toMatchObject({ code: 'E_UNSUPPORTED' });
    await expect(makeConn().query(req('USE demo'))).rejects.toMatchObject({ code: 'E_UNSUPPORTED' });
  });

  it('多语句 → E_VALIDATION（supportsMultiStatement=false，core 应已切分）', async () => {
    await expect(makeConn().query(req('SELECT 1; SELECT 2'))).rejects.toMatchObject({ code: 'E_VALIDATION' });
  });
});

describe('mock query：值编码（C-7）', () => {
  beforeEach(() => resetMockStore());

  it('字符串引号转义与 NULL/布尔/数字字面量', async () => {
    const conn = makeConn();
    await conn.query(req("INSERT INTO users (name, email) VALUES ('O''Brien', 'ob@x.com')"));
    const [check] = await conn.query(req("SELECT name FROM users WHERE name = 'O''Brien'"));
    expect(check.rows).toEqual([["O'Brien"]]);
    await expect(conn.query(req('INSERT INTO users (name) VALUES (unknown)'))).rejects.toMatchObject({
      code: 'E_VALIDATION',
    });
  });

  it('json 列原样传对象（analytics.payload 为 json 类型）', async () => {
    const [rs] = await makeConn().query(req('SELECT payload FROM analytics.events WHERE id = 1'));
    expect(rs.rows[0][0]).toEqual({ page: '/p/1', ts: 1700000000000 });
  });
});

describe('mock query：契约防护', () => {
  it('DriverError 形状（code + message）：未支持语句 E_UNSUPPORTED', async () => {
    resetMockStore();
    try {
      // M8-B2 起限定库的 CREATE/ALTER/DROP TABLE 走 DDL 执行链（ddl 契约组覆盖）；
      // 其余语句仍 E_UNSUPPORTED（TRUNCATE 不在 DDL 路由白名单）
      await makeConn().query(req('TRUNCATE TABLE demo.users'));
      expect.unreachable('应抛出 E_UNSUPPORTED');
    } catch (err) {
      expect(DriverError.is(err)).toBe(true);
      expect((err as DriverError).code).toBe('E_UNSUPPORTED');
    }
  });
});
