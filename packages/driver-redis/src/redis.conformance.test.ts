import { createClient } from 'redis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DriverError } from '@db-explorer/core';
import {
  runChangesetChecks,
  runConnectionChecks,
  runCursorPaginationChecks,
  runFilterPushdownChecks,
  runMetadataChecks,
  runPaginationChecks,
  runScanSemanticsChecks,
  runValueEncodingChecks,
} from '@db-explorer/driver-conformance';
import { createRedisDriver, REDIS_DRIVER_ID, type RedisConnection } from './index';
import { ensureLocalRedis } from './testEnv';

/**
 * Redis 契约测试（驱动规范 §11）：需真实 Redis。
 * - 默认 127.0.0.1:6379（REDIS_HOST/REDIS_PORT 可覆盖）；实例应专用，测试只触碰 cf:* 与 fixture 键
 * - 错误密码用例需第二个带 requirepass 的实例（REDIS_AUTH_HOST/REDIS_AUTH_PORT，默认 6379:6390），
 *   CI 矩阵以 redis:7 --requirepass 提供
 * - 即起即用（M7 起，P-28：launchd 常驻已移除）：beforeAll 经 testEnv.ensureLocalRedis 探测端口，
 *   空闲则自起本地二进制（~/tools/redis），afterAll 停掉；已有服务直接复用不启停
 * - CI：services.redis（见 .github/workflows/ci.yml，评审 P2-3 矩阵补齐）
 */

const HOST = process.env.REDIS_HOST ?? '127.0.0.1';
const PORT = Number(process.env.REDIS_PORT ?? 6379);
const AUTH_PORT = Number(process.env.REDIS_AUTH_PORT ?? 6390);

const cfg = {
  id: 'conformance-redis',
  name: 'Redis 契约',
  driverId: REDIS_DRIVER_ID,
  options: { host: HOST, port: PORT, database: 0 },
  secretRef: 'dbExplorer.secrets.conformance-redis',
};

function makeConn(): Promise<RedisConnection> {
  return createRedisDriver().connect(cfg, '') as Promise<RedisConnection>;
}

/** fixture 键（契约测试专用前缀 cf:，结束统一清理；禁止 FLUSHDB——实例可能非专用） */
const FIXTURES = {
  patternPrefix: 'cf:',
  strPlain: 'cf:str-plain',
  strInt: 'cf:str-int',
  strJson: 'cf:str-json',
  strBinary: 'cf:str-binary',
  hash: 'cf:hash',
  list: 'cf:list',
  set: 'cf:set',
  zset: 'cf:zset',
  stream: 'cf:stream',
};

const SEEDED_BINARY = Buffer.from([0xff, 0xfe, 0x00, 0x01]);

async function scanAndDelete(admin: Awaited<ReturnType<typeof connectAdmin>>, pattern: string): Promise<void> {
  let cursor = '0';
  do {
    const { cursor: next, keys } = await admin.scan(cursor, { MATCH: pattern, COUNT: 500 });
    cursor = next;
    if (keys.length > 0) {
      await admin.del(keys);
    }
  } while (cursor !== '0');
}

async function connectAdmin(): Promise<ReturnType<typeof createClient>> {
  const admin = createClient({ socket: { host: HOST, port: PORT }, database: 0 });
  await admin.connect();
  return admin;
}

async function seed(): Promise<void> {
  const admin = await connectAdmin();
  try {
    // 清理历史 cf:* 键（模式浏览的采样基数确定性）
    await scanAndDelete(admin, 'cf:*');

    const multi = admin.multi();
    for (let i = 1; i <= 30; i++) {
      multi.set(`cf:${i}`, `v${i}`);
    }
    multi.set(FIXTURES.strPlain, 'hello world');
    multi.set(FIXTURES.strInt, '42');
    multi.set(FIXTURES.strJson, '{"a":1,"b":[1,2]}');
    multi.set(FIXTURES.strBinary, SEEDED_BINARY);
    multi.hSet(FIXTURES.hash, { f1: 'v1', f2: '{"x":9}', f3: '33', f4: SEEDED_BINARY });
    multi.rPush(FIXTURES.list, ['a', 'b', 'c', 'd', 'e']);
    multi.sAdd(FIXTURES.set, ['m1', 'm2', 'm3', 'm4', 'm5']);
    multi.zAdd(FIXTURES.zset, [
      { score: 1.5, value: 'one' },
      { score: 2.5, value: 'two' },
      { score: 3.5, value: 'three' },
    ]);
    // stream 条目：XADD 顺序即 id 序（同毫秒用递增序号区分）；fields 覆盖多字段与 JSON 值
    multi.xAdd(FIXTURES.stream, '*', { event: 'created', payload: '{"n":1}' });
    multi.xAdd(FIXTURES.stream, '*', { event: 'updated', payload: 'plain' });
    multi.xAdd(FIXTURES.stream, '*', { event: 'deleted', payload: '{"n":3}' });
    await multi.exec();
  } finally {
    await admin.quit();
  }
}

async function cleanup(): Promise<void> {
  const admin = await connectAdmin();
  try {
    await scanAndDelete(admin, 'cf:*');
  } finally {
    await admin.quit();
  }
}

/** 即起即用（P-28）：端口已有服务则复用（CI service / 本地手起），否则测试自起自停 */
const localProcs: Array<Awaited<ReturnType<typeof ensureLocalRedis>>> = [];

beforeAll(async () => {
  localProcs.push(
    await ensureLocalRedis({ port: PORT }),
    await ensureLocalRedis({ port: AUTH_PORT, requirepass: 'm6cipass' }),
  );
  await seed();
});

afterAll(async () => {
  await cleanup();
  for (const p of localProcs) {
    await p.stop();
  }
});

function assertGroup(name: string, failed: number, results: Array<{ name: string; ok: boolean; error?: string; skipped?: boolean }>): void {
  if (failed > 0) {
    console.error(
      `[${name}] 失败项：\n${results
        .filter((r) => !r.ok)
        .map((r) => `  - ${r.name}: ${r.error}`)
        .join('\n')}`,
    );
  }
  expect(failed, name).toBe(0);
}

describe('redis 契约（真实 Redis）', () => {
  it('connection 组', async () => {
    const s = await runConnectionChecks(makeConn);
    assertGroup('connection', s.failed, s.results);
    expect(s.results.filter((r) => !r.skipped)).toHaveLength(3);
  });

  it('metadata 组（collection 虚拟化列）', async () => {
    const s = await runMetadataChecks(makeConn);
    assertGroup('metadata', s.failed, s.results);
  });

  it('pagination 组（offset 翻译为 SCAN 跳过）', async () => {
    const s = await runPaginationChecks(makeConn);
    assertGroup('pagination', s.failed, s.results);
    // limit 截断 / offset 稳定 / sorts 页内有序 / totalCount 缺省 全部实跑
    expect(s.results.filter((r) => !r.skipped)).toHaveLength(4);
  });

  it('filter-pushdown 组（SCAN MATCH 下推 + 内存过滤一致；whereSql/sorts=page 按能力跳过）', async () => {
    const s = await runFilterPushdownChecks(makeConn, { supportsWhereSql: false, sorts: 'page' });
    assertGroup('filter-pushdown', s.failed, s.results);
  });

  it('changeset 组按 P-19 跳过（editable=false → E_UNSUPPORTED，非假绿）', async () => {
    const s = await runChangesetChecks(makeConn);
    const skipped = s.results.filter((r) => r.skipped);
    expect(s.failed).toBe(0);
    expect(skipped.length).toBeGreaterThan(0);
  });

  it('cursor-pagination 组（游标闭环：走完 = 全量，无重复无遗漏）', async () => {
    const s = await runCursorPaginationChecks(makeConn, { pagination: 'cursor' });
    assertGroup('cursor-pagination', s.failed, s.results);
    expect(s.results.filter((r) => !r.skipped)).toHaveLength(2);
  });

  it('scan-semantics 组（模式匹配 / type 合法 / __ttl 整数）', async () => {
    const s = await runScanSemanticsChecks(makeConn, { pagination: 'cursor' });
    assertGroup('scan-semantics', s.failed, s.results);
    expect(s.results.filter((r) => !r.skipped).length).toBeGreaterThanOrEqual(2);
  });

  it('value-encoding 组（JSON 安全 + 类型化内容表形状 + 二进制 base64）', async () => {
    const s = await runValueEncodingChecks(makeConn, FIXTURES);
    assertGroup('value-encoding', s.failed, s.results);
  });
});

describe('redis 值编码往返（§5.3 契约，驱动侧精确断言）', () => {
  let conn: RedisConnection;

  beforeAll(async () => {
    conn = await makeConn();
  });

  afterAll(async () => {
    await conn.dispose();
  });

  it('整数字符串 → integer（不丢前导零的值保持 string）', async () => {
    const rs = await conn.fetchRows({ db: 'db0', obj: FIXTURES.strInt, limit: 10, timeoutMs: 5000 });
    expect(rs.rows[0][0]).toBe(42);
  });

  it('JSON 对象/数组 → 已解析 json', async () => {
    const rs = await conn.fetchRows({ db: 'db0', obj: FIXTURES.strJson, limit: 10, timeoutMs: 5000 });
    expect(rs.rows[0][0]).toEqual({ a: 1, b: [1, 2] });
  });

  it('普通字符串 → string', async () => {
    const rs = await conn.fetchRows({ db: 'db0', obj: FIXTURES.strPlain, limit: 10, timeoutMs: 5000 });
    expect(rs.rows[0][0]).toBe('hello world');
  });

  it('二进制 → base64 且往返一致（§5.3：二进制 value → binary）', async () => {
    const rs = await conn.fetchRows({ db: 'db0', obj: FIXTURES.strBinary, limit: 10, timeoutMs: 5000 });
    expect(rs.rows[0][0]).toBe(SEEDED_BINARY.toString('base64'));
  });

  it('hash 字段值混合类型逐列编码（json 对象 / 整数 / 二进制）', async () => {
    const rs = await conn.fetchRows({ db: 'db0', obj: FIXTURES.hash, limit: 50, timeoutMs: 5000 });
    const byField = new Map(rs.rows.map((r) => [r[0], r[1]]));
    expect(byField.get('f1')).toBe('v1');
    expect(byField.get('f2')).toEqual({ x: 9 });
    expect(byField.get('f3')).toBe(33);
    expect(byField.get('f4')).toBe(SEEDED_BINARY.toString('base64'));
  });

  it('zset score → float number', async () => {
    const rs = await conn.fetchRows({ db: 'db0', obj: FIXTURES.zset, limit: 10, timeoutMs: 5000 });
    expect(rs.rows.map((r) => r[1])).toEqual([1.5, 2.5, 3.5]);
  });

  it('不存在的键 → E_NOT_FOUND', async () => {
    await expect(
      conn.fetchRows({ db: 'db0', obj: 'cf:no-such-key', limit: 10, timeoutMs: 5000 }),
    ).rejects.toMatchObject({ code: 'E_NOT_FOUND' });
  });
});

describe('redis 连接与错误映射（真实 Redis）', () => {
  it('不可达端口 → E_CONN（可重试）', async () => {
    const conn = await createRedisDriver().connect(
      { ...cfg, options: { host: HOST, port: 6391 } },
      '',
    );
    await expect(conn.ping()).rejects.toMatchObject({ code: 'E_CONN', retryable: true });
    await conn.dispose();
  });

  it('错误密码 → E_AUTH（需带 requirepass 的实例；不可达跳过）', async () => {
    let authed = false;
    const probe = createClient({ socket: { host: HOST, port: AUTH_PORT }, password: 'm6cipass' });
    try {
      await probe.connect();
      authed = true;
    } catch {
      return; // 本地未起 6390 / CI 矩阵缺失时跳过
    } finally {
      await probe.quit().catch(() => undefined);
    }
    expect(authed).toBe(true);
    const driver = createRedisDriver();
    const bad = await driver.testConnection(
      { ...cfg, options: { host: HOST, port: AUTH_PORT } },
      'wrong-password',
    );
    expect(bad.ok).toBe(false);
    expect(bad.error?.code).toBe('E_AUTH');
  }, 15000);

  it('dispose 后调用 → E_CONN（驱动规范 §7）', async () => {
    const conn = await makeConn();
    await conn.dispose();
    await expect(conn.ping()).rejects.toMatchObject({ code: 'E_CONN' });
  });

  it('未实现编辑：applyChanges 抛 E_UNSUPPORTED（P-19 探测路径）', async () => {
    const conn = await makeConn();
    try {
      await expect(
        conn.applyChanges('db0', 'cf:hash', { inserts: [], updates: [], deletes: [] }),
      ).rejects.toMatchObject({ code: 'E_UNSUPPORTED' });
    } finally {
      await conn.dispose();
    }
  });

  it('命令错误映射：unknown command → E_UNSUPPORTED；参数不足 → E_SYNTAX', async () => {
    const conn = await makeConn();
    try {
      await expect(
        conn.query({ sql: 'NOSUCHCMD x', db: 'db0', maxRows: 100, timeoutMs: 5000 }),
      ).rejects.toMatchObject({ code: 'E_UNSUPPORTED' });
      await expect(
        conn.query({ sql: 'GET', db: 'db0', maxRows: 100, timeoutMs: 5000 }),
      ).rejects.toMatchObject({ code: 'E_SYNTAX' });
      await expect(
        conn.query({ sql: 'SET k "unclosed', db: 'db0', maxRows: 100, timeoutMs: 5000 }),
      ).rejects.toMatchObject({ code: 'E_SYNTAX' });
      await expect(
        conn.query({ sql: 'GET a\nGET b', db: 'db0', maxRows: 100, timeoutMs: 5000 }),
      ).rejects.toMatchObject({ code: 'E_VALIDATION' });
    } finally {
      await conn.dispose();
    }
  });

  it('命令控制台：写命令生效 + HGETALL 类型化展示', async () => {
    const conn = await makeConn();
    try {
      const set = await conn.query({ sql: 'SET cf:console-k "cv"', db: 'db0', maxRows: 100, timeoutMs: 5000 });
      expect(set[0].rows).toEqual([['OK']]);
      const get = await conn.query({ sql: 'GET cf:console-k', db: 'db0', maxRows: 100, timeoutMs: 5000 });
      expect(get[0].rows).toEqual([['cv']]);
      const hgetall = await conn.query({ sql: `HGETALL ${FIXTURES.hash}`, db: 'db0', maxRows: 100, timeoutMs: 5000 });
      expect(hgetall[0].columns.map((c) => c.name)).toEqual(['field', 'value']);
      expect(hgetall[0].rowCount).toBe(4);
      const del = await conn.query({ sql: 'DEL cf:console-k', db: 'db0', maxRows: 100, timeoutMs: 5000 });
      expect(del[0].rows).toEqual([[1]]);
    } finally {
      await conn.dispose();
    }
  });

  it('只读连接约束不在此层（ConnectionManager/E-SQL 路径不适用）——命令白名单在 core 判定', () => {
    // core 侧 redisCommands.test.ts 已覆盖 provablyRead/dangerous；此处防遗漏导入检查
    expect(new DriverError('E_READONLY', 'x').code).toBe('E_READONLY');
  });

  // ── stream 内容展示（M7 收尾：XRANGE 位置分页，entry/fields 列）──────────
  it('stream 内容：列虚拟化（entry 主键 + fields json）', async () => {
    const conn = await makeConn();
    try {
      const cols = await conn.listColumns('db0', FIXTURES.stream);
      expect(cols.map((c) => c.name)).toEqual(['entry', 'fields']);
      // 内容列 PK 经 ResultSet.primaryKey 表达（与其他类型同口径，ColumnMeta.isPrimaryKey 恒 false）
      const rs = await conn.fetchRows({ db: 'db0', obj: FIXTURES.stream, limit: 5, offset: 0, timeoutMs: 5000 });
      expect(rs.primaryKey).toEqual(['entry']);
      expect(cols[1].normalizedType).toBe('json');
    } finally {
      await conn.dispose();
    }
  });

  it('stream 内容：XRANGE 顺序分页 + 游标闭环（offset 与 cursor 双路径）', async () => {
    const conn = await makeConn();
    try {
      // offset 路径（webview 现状）：首页 2 条
      const page1 = await conn.fetchRows({ db: 'db0', obj: FIXTURES.stream, limit: 2, offset: 0, timeoutMs: 5000 });
      expect(page1.rowCount).toBe(2);
      expect(page1.nextCursor).toBeTruthy();
      const fields1 = page1.rows[0][1] as Record<string, unknown>;
      expect(fields1.event).toBe('created');
      expect(fields1.payload).toEqual({ n: 1 }); // json 列已解析对象（C-7）
      // 第二页（offset=2）
      const page2 = await conn.fetchRows({ db: 'db0', obj: FIXTURES.stream, limit: 2, offset: 2, timeoutMs: 5000 });
      expect(page2.rowCount).toBe(1);
      expect((page2.rows[0][1] as Record<string, unknown>).event).toBe('deleted');
      // cursor 路径（透传预留）：游标推进不重复不遗漏
      const c1 = await conn.fetchRows({ db: 'db0', obj: FIXTURES.stream, limit: 2, offset: 0, timeoutMs: 5000 });
      const c2 = await conn.fetchRows({
        db: 'db0', obj: FIXTURES.stream, limit: 2, offset: 0, timeoutMs: 5000,
        cursor: c1.nextCursor,
      });
      expect(c2.rowCount).toBe(1);
      expect(c2.nextCursor).toBeUndefined(); // 走完 = 尽头
      const ids = [...c1.rows.map((r) => String(r[0])), ...c2.rows.map((r) => String(r[0]))];
      expect(new Set(ids).size).toBe(3);
    } finally {
      await conn.dispose();
    }
  });

  it('stream 内容：搜索命中 fields 内容', async () => {
    const conn = await makeConn();
    try {
      const rs = await conn.fetchRows({ db: 'db0', obj: FIXTURES.stream, limit: 10, offset: 0, timeoutMs: 5000, search: 'updated' });
      expect(rs.rowCount).toBe(1);
      expect((rs.rows[0][1] as Record<string, unknown>).event).toBe('updated');
    } finally {
      await conn.dispose();
    }
  });
});
