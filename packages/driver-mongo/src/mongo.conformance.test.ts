import { Binary, Decimal128, Long, MongoClient, ObjectId } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  runCancellationChecks,
  runChangesetChecks,
  runConnectionChecks,
  runCursorPaginationChecks,
  runFilterPushdownChecks,
  runMetadataChecks,
  runPaginationChecks,
  runScanSemanticsChecks,
  runValueEncodingChecks,
} from '@db-explorer/driver-conformance';
import { createMongoDriver, MONGO_DRIVER_ID, type MongoConnection } from './index';

/**
 * MongoDB 契约测试（驱动规范 §11）：需真实 MongoDB 实例。
 * - `MONGO_URI` 环境变量门控（PG 先例）：未设 → 整套 skip；CI mongo:7 service 实跑
 *   （.github/workflows/ci.yml，驱动规范 §11「MongoDB 门控与组取舍」注记）
 * - fixture 库 cf_mongo 由测试自持（beforeAll drop 重建 + 种子、afterAll drop）；
 *   种子经官方 mongodb 客户端写入（与被测驱动解耦）——禁止触碰其他库
 * - 编辑（D-18）：变更集组以 supportsTransaction=false 实跑（混合原子性两项按能力跳过）
 * - 值编码取舍：SQL 形态往返组依赖 buildCreateTable/applyChanges → P-19 探针跳过；
 *   通用 JSON 安全组实跑；BSON→§5 精确断言见下方驱动侧 describe
 * - 取消组模板：$where 有界忙循环（自终止，abort 先行返回 E_CANCELED，不留永久服务端负载）
 */

const URI = process.env.MONGO_URI ?? '';
const FIXTURE_DB = 'cf_mongo';

const cfg = {
  id: 'conformance-mongo',
  name: 'Mongo 契约',
  driverId: MONGO_DRIVER_ID,
  options: { uri: URI },
  secretRef: 'dbExplorer.secrets.conformance-mongo',
};

function makeConn(): Promise<MongoConnection> {
  return createMongoDriver().connect(cfg, '') as Promise<MongoConnection>;
}

// 未注入 MONGO_URI → 整套 skip（CI 实跑）
const d = URI ? describe : describe.skip;

async function connectAdmin(): Promise<MongoClient> {
  const client = new MongoClient(URI);
  await client.connect();
  return client;
}

beforeAll(async () => {
  if (!URI) {
    return; // MONGO_URI 门控：未注入实例时整套 skip（describe 已 skip，此处兜底空跑）
  }
  const admin = await connectAdmin();
  try {
    await admin.db(FIXTURE_DB).dropDatabase().catch(() => undefined);
    const db = admin.db(FIXTURE_DB);
    // cf_main：30 篇文档，字段覆盖 string/integer/double/decimal/long(安全+超限)/date/
    // binary/嵌套文档/数组/null，含 NULL 值（findSampleTable 优先含 NULL 样例 → isNull/isNotNull 覆盖）
    const docs: Array<Record<string, unknown>> = [];
    for (let i = 1; i <= 30; i++) {
      docs.push({
        name: `item-${String(i).padStart(2, '0')}`,
        category: i % 5 === 0 ? null : i % 2 === 1 ? 'alpha' : 'beta',
        note: i % 7 === 0 ? null : `note-${i}`,
        qty: i * 10,
        price: Decimal128.fromString(`${i}.25`),
        score: i / 2,
        active: i % 3 === 0,
        created: new Date(Date.UTC(2024, 0, i, 8, 30, 0, 500)),
        big: Long.fromNumber(3_000_000_000 + i),
        huge: Long.fromString('9007199254740993'),
        tags: [`t${i % 3}`, 'common'],
        meta: { nested: i, flag: i % 2 === 0 },
        bin: new Binary(Buffer.from([0x00, 0xff, i % 256, 0x10])),
        oid: new ObjectId(),
      });
    }
    await db.collection('cf_main').insertMany(docs);
    await db.collection('cf_small').insertMany([{ k: 1 }, { k: 2 }, { k: 3 }]);
    await db.collection('cf_cancel_t').insertOne({ k: 1 });
  } finally {
    await admin.close();
  }
}, 60_000);

afterAll(async () => {
  if (!URI) {
    return;
  }
  const admin = await connectAdmin();
  try {
    await admin.db(FIXTURE_DB).dropDatabase();
  } finally {
    await admin.close();
  }
}, 60_000);

function assertGroup(
  name: string,
  failed: number,
  results: Array<{ name: string; ok: boolean; error?: string; skipped?: boolean }>,
): void {
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

d('mongo 契约（真实 MongoDB，MONGO_URI 门控）', () => {
  it('connection 组', async () => {
    const s = await runConnectionChecks(makeConn);
    assertGroup('connection', s.failed, s.results);
    expect(s.results.filter((r) => !r.skipped)).toHaveLength(3);
  });

  it('metadata 组（动态列采样 / 索引自省）', async () => {
    const s = await runMetadataChecks(makeConn);
    assertGroup('metadata', s.failed, s.results);
  });

  it('pagination 组（offset 翻译为 skip 实跑）', async () => {
    const s = await runPaginationChecks(makeConn);
    assertGroup('pagination', s.failed, s.results);
    // limit 截断 / offset 稳定 / sorts 下推 / totalCount 缺省 全部实跑
    expect(s.results.filter((r) => !r.skipped)).toHaveLength(4);
  });

  it('filter-pushdown 组（查询文档下推与内存过滤一致；whereSql 按能力跳过）', async () => {
    const s = await runFilterPushdownChecks(makeConn, { supportsWhereSql: false });
    assertGroup('filter-pushdown', s.failed, s.results);
    // 13 个 FilterOp + 组合 filters+sorts+limit+offset + search 全实跑（whereSql 跳过）
    expect(s.results.filter((r) => !r.skipped)).toHaveLength(15);
  });

  it('changeset 组（D-18 编辑实跑；无事务 → 混合原子性两项按能力跳过）', async () => {
    const s = await runChangesetChecks(makeConn, { supportsTransaction: false });
    assertGroup('changeset', s.failed, s.results);
    // 实跑 3 项：insert 回填 / preview 参数化 / NULL 原值按 null 匹配；
    // 跳过 2 项：update 冲突无半提交 + 混合事务原子性（supportsTransaction=false）
    expect(s.results.filter((r) => !r.skipped)).toHaveLength(3);
    expect(s.results.filter((r) => r.skipped)).toHaveLength(2);
  });

  it('cursor-pagination 组（游标闭环：走完 = 全量，无重复无遗漏）', async () => {
    const s = await runCursorPaginationChecks(makeConn, { pagination: 'cursor' });
    assertGroup('cursor-pagination', s.failed, s.results);
    expect(s.results.filter((r) => !r.skipped)).toHaveLength(2);
  });

  it('scan-semantics 组（KV 语义不适用 → 按形状探测跳过）', async () => {
    const s = await runScanSemanticsChecks(makeConn, { pagination: 'cursor' });
    assertGroup('scan-semantics', s.failed, s.results);
    expect(s.results.filter((r) => !r.skipped)).toHaveLength(0);
  });

  it('value-encoding 组（样例行 JSON 安全实跑；SQL 形态组按探针缺考）', async () => {
    const s = await runValueEncodingChecks(makeConn, { db: FIXTURE_DB });
    assertGroup('value-encoding', s.failed, s.results);
    expect(s.results.filter((r) => !r.skipped).length).toBeGreaterThanOrEqual(1);
  });

  it('cancellation 组（$where 有界忙循环；supportsCancel 以实跑为准）', async () => {
    const s = await runCancellationChecks(makeConn, {
      supportsCancel: true,
      // db 参数缺省（suite 不传）→ 模板用 getSiblingDB 显式定位 fixture 库（chain.dbTarget）
      longQuerySql: (seconds) =>
        `db.getSiblingDB("cf_mongo").cf_cancel_t.find({ $where: function() { var start = Date.now(); while (Date.now() - start < ${seconds * 1000}) {} } })`,
      probeSql: 'db.runCommand({ ping: 1 })',
    });
    assertGroup('cancellation', s.failed, s.results);
  }, 30_000);
});

// ── BSON → §5 值编码精确断言（驱动规范 §5.5 映射表）─────────────────────────

d('mongo BSON 编码（§5.5 契约，驱动侧精确断言）', () => {
  let conn: MongoConnection;

  const fetchOne = async (name: string): Promise<{ columns: Array<{ name: string }>; row: unknown[] }> => {
    const rs = await conn.fetchRows({
      db: FIXTURE_DB,
      obj: 'cf_main',
      filters: [{ column: 'name', op: 'eq', value: name }],
      limit: 5,
      timeoutMs: 10_000,
    });
    expect(rs.rowCount, name).toBe(1);
    return { columns: rs.columns, row: rs.rows[0] };
  };
  const cellOf = (r: Awaited<ReturnType<typeof fetchOne>>, col: string): unknown =>
    r.row[r.columns.findIndex((c) => c.name === col)];

  beforeAll(async () => {
    conn = await makeConn();
  });

  afterAll(async () => {
    await conn.dispose();
  });

  it('_id(ObjectId) → 24 位 hex 字符串，primaryKey = ["_id"] 且恒为首列', async () => {
    const rs = await conn.fetchRows({ db: FIXTURE_DB, obj: 'cf_main', limit: 1, timeoutMs: 10_000 });
    expect(rs.primaryKey).toEqual(['_id']);
    expect(rs.columns[0].name).toBe('_id');
    const id = rs.rows[0][0] as string;
    expect(id).toMatch(/^[0-9a-f]{24}$/);
  });

  it('Date → UTC YYYY-MM-DD HH:mm:ss.SSS（无时区，C-7）', async () => {
    const r = await fetchOne('item-01');
    expect(cellOf(r, 'created')).toBe('2024-01-01 08:30:00.500');
    expect(cellOf(r, 'created')).not.toContain('+');
  });

  it('Long 安全范围内 → number；超限 → decimal 字符串；Decimal128 → 字符串', async () => {
    const r = await fetchOne('item-02');
    expect(cellOf(r, 'big')).toBe(3_000_000_002);
    expect(cellOf(r, 'huge')).toBe('9007199254740993');
    expect(cellOf(r, 'price')).toBe('2.25');
  });

  it('Binary → base64 且字节往返一致', async () => {
    const r = await fetchOne('item-03');
    const b64 = cellOf(r, 'bin') as string;
    expect(b64).toMatch(/^[A-Za-z0-9+/=]+$/);
    const raw = Buffer.from(b64, 'base64');
    expect([...raw]).toEqual([0x00, 0xff, 0x03, 0x10]);
  });

  it('嵌套文档 / 数组 → 已解析 json（C-7 深度转换）', async () => {
    const r = await fetchOne('item-04');
    expect(cellOf(r, 'meta')).toEqual({ nested: 4, flag: true });
    expect(cellOf(r, 'tags')).toEqual(['t1', 'common']);
  });

  it('显式 null 与缺失字段 → null（严格区分空串）', async () => {
    const r = await fetchOne('item-05'); // category = null
    expect(cellOf(r, 'category')).toBeNull();
    const missing = await conn.fetchRows({
      db: FIXTURE_DB,
      obj: 'cf_small',
      filters: [{ column: 'k', op: 'eq', value: 1 }],
      limit: 5,
      timeoutMs: 10_000,
    });
    // cf_small 只有 k 字段：other 字段不存在 → 按列并集补 null（动态列语义）
    const cols = missing.columns.map((c) => c.name);
    expect(cols).toEqual(['_id', 'k']);
  });
});

// ── 连接与错误映射（§6 基准表）─────────────────────────────────────────────

d('mongo 连接与错误映射（真实 MongoDB）', () => {
  it('不可达端口 → E_CONN（可重试）', async () => {
    const conn = await createMongoDriver().connect(
      { ...cfg, options: { host: '127.0.0.1', port: 1, connectTimeout: 1500 } },
      '',
    );
    await expect(conn.ping()).rejects.toMatchObject({ code: 'E_CONN', retryable: true });
    await conn.dispose();
  }, 20_000);

  it('错误密码 → E_AUTH（URI 携带凭据时）', async () => {
    if (!/\/\/[^/]*@/.test(URI)) {
      return; // MONGO_URI 无凭据（免认证实例）→ 跳过
    }
    const badUri = URI.replace(/\/\/([^:/@]+):([^@]+)@/, '//$1:wrong-password@');
    const bad = await createMongoDriver().testConnection(
      { ...cfg, options: { uri: badUri, connectTimeout: 5000 } },
      '',
    );
    expect(bad.ok).toBe(false);
    expect(bad.error?.code).toBe('E_AUTH');
  }, 20_000);

  it('dispose 后调用 → E_CONN（驱动规范 §7）', async () => {
    const conn = await makeConn();
    await conn.dispose();
    await expect(conn.ping()).rejects.toMatchObject({ code: 'E_CONN' });
  }, 20_000);

  it('编辑（D-18）：陈旧原值提交 → E_CONFLICT（字段级乐观锁）', async () => {
    const conn = await makeConn();
    try {
      const rs = await conn.fetchRows({
        db: FIXTURE_DB,
        obj: 'cf_main',
        filters: [{ column: 'name', op: 'eq', value: 'item-01' }],
        limit: 5,
        timeoutMs: 10_000,
      });
      const rowKey = { _id: rs.rows[0][0] };
      // 他人先改：note-1 → tmp
      await conn.applyChanges(FIXTURE_DB, 'cf_main', {
        inserts: [],
        updates: [{ rowKey, original: {}, changes: { note: { old: 'note-1', new: 'tmp' } } }],
        deletes: [],
      });
      // 陈旧 changeset（基于 old=note-1）→ matched 0 → E_CONFLICT
      await expect(
        conn.applyChanges(FIXTURE_DB, 'cf_main', {
          inserts: [],
          updates: [{ rowKey, original: {}, changes: { note: { old: 'note-1', new: 'stale' } } }],
          deletes: [],
        }),
      ).rejects.toMatchObject({ code: 'E_CONFLICT' });
      // 库中数据未变（仍是 tmp），恢复 note-1
      await conn.applyChanges(FIXTURE_DB, 'cf_main', {
        inserts: [],
        updates: [{ rowKey, original: {}, changes: { note: { old: 'tmp', new: 'note-1' } } }],
        deletes: [],
      });
      const after = await conn.fetchRows({
        db: FIXTURE_DB,
        obj: 'cf_main',
        filters: [{ column: 'name', op: 'eq', value: 'item-01' }],
        limit: 5,
        timeoutMs: 10_000,
      });
      expect(after.rows[0][after.columns.findIndex((c) => c.name === 'note')]).toBe('note-1');
    } finally {
      await conn.dispose();
    }
  }, 20_000);
});

// ── mongosh 命令控制台（§5.5 命令域）───────────────────────────────────────

d('mongo 命令控制台（mongosh 域，首批只读）', () => {
  let conn: MongoConnection;

  const q = (sql: string) => conn.query({ sql, db: FIXTURE_DB, maxRows: 100, timeoutMs: 10_000 });

  beforeAll(async () => {
    conn = await makeConn();
  });

  afterAll(async () => {
    await conn.dispose();
  });

  it('find → 动态列表格（primaryKey = ["_id"]）', async () => {
    const rs = await q('db.cf_main.find({ qty: { $gt: 280 } })');
    expect(rs).toHaveLength(1);
    expect(rs[0].rowCount).toBe(2); // qty 290 / 300
    expect(rs[0].columns.map((c) => c.name)[0]).toBe('_id');
    expect(rs[0].primaryKey).toEqual(['_id']);
  });

  it('find 第二参 options（sort/limit）', async () => {
    const rs = await q('db.cf_main.find({}, { sort: { qty: -1 }, limit: 3 })');
    const qtyIdx = rs[0].columns.findIndex((c) => c.name === 'qty');
    expect(rs[0].rowCount).toBe(3);
    expect(rs[0].rows[0][qtyIdx]).toBe(300);
  });

  it('count / distinct / aggregate → 标量与表结果集', async () => {
    const count = await q('db.cf_main.countDocuments({ category: "alpha" })');
    expect(count[0].rows).toEqual([[12]]); // 奇数 15 篇中 i%5==0（5/15/25）为 null → alpha = 12
    const distinct = await q('db.cf_main.distinct("category")');
    expect(distinct[0].rowCount).toBe(3); // alpha / beta / null
    const agg = await q('db.cf_main.aggregate([ { $match: { active: true } }, { $count: "n" } ])');
    expect(agg[0].rowCount).toBe(1);
    expect(agg[0].columns[0].name).toBe('n');
  });

  it('runCommand（读命令子集）→ key/value 行；show dbs / show collections', async () => {
    const ping = await q('db.runCommand({ ping: 1 })');
    expect(ping[0].columns.map((c) => c.name)).toEqual(['key', 'value']);
    const dbs = await q('show dbs');
    const names = dbs[0].rows.map((r) => r[0]);
    expect(names).toContain(FIXTURE_DB);
    expect(names).not.toContain('admin'); // 系统库过滤
    const cols = await q('show collections');
    expect(cols[0].rows.flat()).toContain('cf_main');
  });

  it('文档写命令放开（D-18）：经危险判定链后可执行，insert/update/delete 生效', async () => {
    // 草稿 collection 上走一轮写（危险横幅/只读判定在 Host 层，此处验证驱动执行面）；
    // 写结果为 key/value 行（objectToRows）
    const ins = await q("db.cf_console_t.insertOne({ name: 'w1', qty: 1 })");
    expect(ins[0].rows.map((r) => r[0])).toContain('insertedId'); // 回填 _id（hex 或字符串）
    const upd = await q("db.cf_console_t.updateOne({ name: 'w1' }, { $set: { qty: 2 } })");
    expect(upd[0].rowCount).toBe(3); // matchedCount / modifiedCount / upsertedId
    const cnt = await q('db.cf_console_t.countDocuments({ qty: 2 })');
    expect(cnt[0].rows).toEqual([[1]]);
    const del = await q("db.cf_console_t.deleteOne({ name: 'w1' })");
    expect(del[0].rows).toEqual([['deletedCount', 1]]); // key/value 行（objectToRows）
    const after = await q('db.cf_console_t.countDocuments({ name: "w1" })');
    expect(after[0].rows).toEqual([[0]]);
  });

  it('结构类命令恒 E_UNSUPPORTED（D-18 范围边界）；aggregate 带 $out 仍拒', async () => {
    for (const cmd of [
      'db.cf_main.drop()',
      'db.dropDatabase()',
      'db.createCollection("nope")',
      'db.cf_main.createIndex({ a: 1 })',
      'db.users.noSuchWrite({ a: 1 })',
      'db.cf_main.aggregate([ { $out: "copy" } ])',
      'db.runCommand({ dropDatabase: 1 })',
    ]) {
      await expect(q(cmd), cmd).rejects.toMatchObject({ code: 'E_UNSUPPORTED' });
    }
  });

  it('语法错误与形态限制：未知命令 / 多行 / 游标链式 / use → E_SYNTAX·E_VALIDATION', async () => {
    await expect(q('NOSUCH x')).rejects.toMatchObject({ code: 'E_SYNTAX' });
    await expect(q('db.cf_main.find({')).rejects.toMatchObject({ code: 'E_SYNTAX' });
    await expect(q('db.cf_main.find({ a: unknownIdent })')).rejects.toMatchObject({ code: 'E_SYNTAX' });
    await expect(q('db.a.find()\ndb.b.find()')).rejects.toMatchObject({ code: 'E_VALIDATION' });
    await expect(q('db.cf_main.find({}).limit(1)')).rejects.toMatchObject({ code: 'E_SYNTAX' });
    await expect(q('use other')).rejects.toMatchObject({ code: 'E_VALIDATION' }); // Host 拦截；驱动防御
  });

  it('取消：预中止 signal 立即拒绝（E_CANCELED）', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(
      conn.query({ sql: 'db.cf_main.find({})', db: FIXTURE_DB, maxRows: 10, timeoutMs: 5000, signal: ac.signal }),
    ).rejects.toMatchObject({ code: 'E_CANCELED' });
  });
});

// ── 补全词表（C-14 命令域全量）─────────────────────────────────────────────

describe('mongo 补全词表（C-14：命令域全量，规模达标）', () => {
  it('KEYWORDS > 50 / FUNCTIONS > 20 / SNIPPETS 非空', async () => {
    const { MONGO_KEYWORDS, MONGO_FUNCTIONS, MONGO_COMPLETION_SNIPPETS, mongoCompletionSource } =
      await import('./completion');
    expect(MONGO_KEYWORDS.length).toBeGreaterThan(50);
    expect(MONGO_FUNCTIONS.length).toBeGreaterThan(20);
    expect(MONGO_COMPLETION_SNIPPETS.length).toBeGreaterThan(0);
    const src = mongoCompletionSource([FIXTURE_DB]);
    expect(src.keywords).toEqual([...MONGO_KEYWORDS]);
    expect(src.databases).toContain(FIXTURE_DB);
  });
});
