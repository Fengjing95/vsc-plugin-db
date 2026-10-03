import type { ChangeSet, ColumnMeta, FilterCondition, FilterOp, IConnection, NormalizedType, RowKey } from '@db-explorer/core';

/**
 * 驱动契约测试套件（概要设计 §12.2）。
 * 各驱动在自己的 CI 中调用并必须全部通过。
 * 组清单：connection（M0）、metadata（M2）、pagination / filter-pushdown（M3）。
 * 说明：「生成语句必须参数化」无法经 IConnection 观测，由各驱动的 SQL 构建层单测覆盖
 * （如 driver-mysql sql.test.ts 对每个 FilterOp 断言占位符，无值拼接）。
 */
export interface CheckResult {
  group: string;
  name: string;
  ok: boolean;
  skipped?: boolean;
  error?: string;
}

export interface ConformanceSummary {
  passed: number;
  failed: number;
  results: CheckResult[];
}

async function check(
  results: CheckResult[],
  group: string,
  name: string,
  run: () => Promise<void>,
): Promise<void> {
  try {
    await run();
    results.push({ group, name, ok: true });
  } catch (err) {
    results.push({ group, name, ok: false, error: String(err) });
  }
}

async function skip(
  results: CheckResult[],
  group: string,
  name: string,
  reason: string,
): Promise<void> {
  results.push({ group, name, ok: true, skipped: true, error: reason });
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

async function firstTable(conn: IConnection): Promise<{ db: string; obj: string }> {
  const dbs = await conn.listDatabases();
  assert(dbs.length > 0, 'listDatabases 返回空数组');
  const objs = await conn.listObjects(dbs[0].name);
  // 优先 table/view（SQL 数据源）；键值数据源退回 collection（M6）。
  // 跳过取列失败（E_UNSUPPORTED，如 stream 键）或空列的条目
  const candidates = [
    ...objs.filter((o) => o.kind === 'table' || o.kind === 'view'),
    ...objs.filter((o) => o.kind === 'collection'),
  ];
  for (const obj of candidates) {
    try {
      const cols = await conn.listColumns(dbs[0].name, obj.name);
      if (cols.length > 0) {
        return { db: dbs[0].name, obj: obj.name };
      }
    } catch {
      continue; // 该条目不支持列展示，尝试下一个
    }
  }
  assert(false, '首个库没有可取样的对象');
  return { db: dbs[0].name, obj: '?' };
}

/** connection 组：ping、库列表非空、dispose 幂等 */
export async function runConnectionChecks(create: () => Promise<IConnection>): Promise<ConformanceSummary> {
  const results: CheckResult[] = [];
  const conn = await create();
  try {
    await check(results, 'connection', 'ping 成功', async () => {
      await conn.ping();
    });
    await check(results, 'connection', 'listDatabases 非空', async () => {
      const dbs = await conn.listDatabases();
      assert(dbs.length > 0, 'listDatabases 返回空数组');
    });
    await check(results, 'connection', 'dispose 幂等', async () => {
      await conn.dispose();
      await conn.dispose();
    });
  } finally {
    await conn.dispose();
  }

  const failed = results.filter((r) => !r.ok).length;
  return { passed: results.length - failed, failed, results };
}

function summarize(results: CheckResult[]): ConformanceSummary {
  const failed = results.filter((r) => !r.ok).length;
  return { passed: results.length - failed, failed, results };
}

// ───────────────────────── M3：分页 / 筛选下推 ─────────────────────────

const SAMPLE_TIMEOUT_MS = 15000;
const SAMPLE_LIMIT = 100_000;

interface SampleTable {
  db: string;
  obj: string;
  primaryKey: string[];
  /** 无筛选基线（limit 500，驱动稳定顺序） */
  rows: unknown[][];
  columns: Array<{ name: string; type: NormalizedType }>;
}

/** 在首个满足条件的库中取样例表：优先含 NULL 值的表（覆盖 isNull/isNotNull），退而求其次取 ≥minRows 行表。
 *  键值数据源（kind=collection）在无 table/view 时兜底参与（M6）。 */
async function findSampleTable(conn: IConnection, minRows: number): Promise<SampleTable | undefined> {
  const dbs = await conn.listDatabases();
  for (const db of dbs) {
    let fallback: SampleTable | undefined;
    const objs = await conn.listObjects(db.name);
    const candidates = objs.filter(
      (o) => o.kind === 'table' || o.kind === 'view' || o.kind === 'collection',
    );
    for (const obj of candidates) {
      let rs;
      try {
        // 条目级容错：E_UNSUPPORTED（如 stream 键）跳过，不中断取样
        rs = await conn.fetchRows({ db: db.name, obj: obj.name, limit: SAMPLE_LIMIT, timeoutMs: SAMPLE_TIMEOUT_MS });
      } catch {
        continue;
      }
      if (rs.rowCount < minRows) {
        continue;
      }
      const columns = await conn.listColumns(db.name, obj.name);
      const sample: SampleTable = {
        db: db.name,
        obj: obj.name,
        primaryKey: rs.primaryKey ?? columns.filter((c) => c.isPrimaryKey).map((c) => c.name),
        rows: rs.rows,
        columns: rs.columns,
      };
      const hasNull = sample.columns.some((_c, i) => sample.rows.some((r) => r[i] === null));
      if (hasNull) {
        return sample;
      }
      fallback ??= sample;
    }
    if (fallback) {
      return fallback;
    }
  }
  return undefined;
}

function cellToString(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function toNumber(v: unknown): number | undefined {
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return undefined;
  if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) return Number(v);
  return undefined;
}

function valEq(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  const na = toNumber(a);
  const nb = toNumber(b);
  if (na !== undefined && nb !== undefined) return na === nb;
  if (typeof a === 'object' && typeof b === 'object') {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return false;
}

function valCmp(a: unknown, b: unknown): number {
  const na = toNumber(a);
  const nb = toNumber(b);
  if (na !== undefined && nb !== undefined) return na - nb;
  const sa = cellToString(a);
  const sb = cellToString(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

/**
 * SQL 三值逻辑内存基准（概要设计 §12.2-4：筛选结果必须与内存过滤一致）：
 * 与 NULL 的任何比较均为 unknown → 行被排除，仅 isNull/isNotNull 涉及 NULL。
 */
function sqlMatch(row: unknown[], cond: FilterCondition, idx: number): boolean {
  const v = row[idx];
  if (cond.op === 'isNull') return v === null;
  if (cond.op === 'isNotNull') return v !== null;
  if (v === null || v === undefined) return false;

  switch (cond.op) {
    case 'eq':
      return valEq(v, cond.value);
    case 'ne':
      return !valEq(v, cond.value);
    case 'gt':
      return valCmp(v, cond.value) > 0;
    case 'ge':
      return valCmp(v, cond.value) >= 0;
    case 'lt':
      return valCmp(v, cond.value) < 0;
    case 'le':
      return valCmp(v, cond.value) <= 0;
    case 'like':
      return cellToString(v).includes(cellToString(cond.value));
    case 'notLike':
      return !cellToString(v).includes(cellToString(cond.value));
    case 'in':
      return (cond.values ?? []).some((x) => valEq(v, x));
    case 'notIn':
      return !(cond.values ?? []).some((x) => valEq(v, x));
    case 'between': {
      const [lo, hi] = cond.values ?? [];
      return valCmp(v, lo) >= 0 && valCmp(v, hi) <= 0;
    }
    default:
      throw new Error(`未知 FilterOp: ${cond.op}`);
  }
}

function indexOfColumn(cols: SampleTable['columns'], name: string): number {
  const idx = cols.findIndex((c) => c.name === name);
  assert(idx >= 0, `列 ${name} 不在结果集中`);
  return idx;
}

function sortedKeys(rows: unknown[][], idx: number): unknown[] {
  return rows.map((r) => r[idx]).sort(valCmp);
}

function sameKeySet(a: unknown[][], b: unknown[][], idx: number): boolean {
  if (a.length !== b.length) return false;
  const ka = sortedKeys(a, idx);
  const kb = sortedKeys(b, idx);
  return ka.every((v, i) => valEq(v, kb[i]));
}

function rowsEqual(a: unknown[][], b: unknown[][]): boolean {
  if (a.length !== b.length) return false;
  return a.every((row, i) => row.every((v, j) => valEq(v, b[i][j])));
}

function rowEq(a: unknown[], b: unknown[]): boolean {
  return a.length === b.length && a.every((v, j) => valEq(v, b[j]));
}

/** 分页组（M3）：limit 截断、offset 稳定无重叠、排序下推、totalCount 语义 */
export async function runPaginationChecks(create: () => Promise<IConnection>): Promise<ConformanceSummary> {
  const results: CheckResult[] = [];
  const conn = await create();
  try {
    const sample = await findSampleTable(conn, 20);
    if (!sample) {
      results.push({ group: 'pagination', name: '样例表（≥20 行）', ok: true, skipped: true });
      return summarize(results);
    }
    const { db, obj, primaryKey } = sample;

    await check(results, 'pagination', 'limit 截断生效且 rowCount 一致', async () => {
      const rs = await conn.fetchRows({ db, obj, limit: 10, timeoutMs: SAMPLE_TIMEOUT_MS });
      assert(rs.rowCount === rs.rows.length, 'rowCount 与 rows.length 不一致');
      assert(rs.rows.length === 10, `limit=10 应返回满页 10 行，实际 ${rs.rows.length}`);
    });

    await check(results, 'pagination', 'offset 翻页稳定且无重叠', async () => {
      const p1a = await conn.fetchRows({ db, obj, limit: 10, offset: 0, timeoutMs: SAMPLE_TIMEOUT_MS });
      const p1b = await conn.fetchRows({ db, obj, limit: 10, offset: 0, timeoutMs: SAMPLE_TIMEOUT_MS });
      const p2 = await conn.fetchRows({ db, obj, limit: 10, offset: 10, timeoutMs: SAMPLE_TIMEOUT_MS });
      assert(rowsEqual(p1a.rows, p1b.rows), '两次取同一页结果不一致（翻页不稳定）');
      const overlap = p1a.rows.some((r1) => p2.rows.some((r2) => rowEq(r1, r2)));
      assert(!overlap, '第 1 页与第 2 页存在重叠行');
    });

    await check(results, 'pagination', 'sorts 下推排序生效（asc/desc）', async () => {
      assert(primaryKey.length > 0, '样例表无主键，无法验证排序');
      const pk = primaryKey[0];
      const asc = await conn.fetchRows({ db, obj, limit: 20, sorts: [{ column: pk, dir: 'asc' }], timeoutMs: SAMPLE_TIMEOUT_MS });
      const pkIdx = indexOfColumn(asc.columns, pk);
      for (let i = 1; i < asc.rows.length; i++) {
        assert(valCmp(asc.rows[i - 1][pkIdx], asc.rows[i][pkIdx]) <= 0, 'asc 排序未生效');
      }
      const desc = await conn.fetchRows({ db, obj, limit: 20, sorts: [{ column: pk, dir: 'desc' }], timeoutMs: SAMPLE_TIMEOUT_MS });
      const pkIdx2 = indexOfColumn(desc.columns, pk);
      for (let i = 1; i < desc.rows.length; i++) {
        assert(valCmp(desc.rows[i - 1][pkIdx2], desc.rows[i][pkIdx2]) >= 0, 'desc 排序未生效');
      }
    });

    await check(results, 'pagination', 'totalCount 可缺省；定义时与分页汇总一致', async () => {
      const first = await conn.fetchRows({ db, obj, limit: 10, offset: 0, timeoutMs: SAMPLE_TIMEOUT_MS });
      assert(first.totalCount === undefined || typeof first.totalCount === 'number', 'totalCount 类型非法');
      if (typeof first.totalCount === 'number') {
        const all: unknown[][] = [];
        for (let offset = 0; offset < first.totalCount; offset += 10) {
          const page = await conn.fetchRows({ db, obj, limit: 10, offset, timeoutMs: SAMPLE_TIMEOUT_MS });
          all.push(...page.rows);
          if (page.rows.length < 10) break;
        }
        assert(all.length === first.totalCount, `分页汇总 ${all.length} 行 ≠ totalCount ${first.totalCount}`);
      }
    });
  } finally {
    await conn.dispose();
  }
  return summarize(results);
}

interface OpCase {
  cond: FilterCondition;
  colIdx: number;
}

function firstNonNull(rows: unknown[][], idx: number): unknown {
  return rows.map((r) => r[idx]).find((v) => v !== null && v !== undefined);
}

/** 从样例数据构造各操作符的条件；样例不足时返回 undefined（该用例跳过） */
function buildOpCase(op: FilterOp, sample: SampleTable): OpCase | undefined {
  const { rows, columns } = sample;
  const pick = (pred: (c: SampleTable['columns'][number]) => boolean) =>
    columns.find(pred)?.name;
  const strCol = pick((c) => c.type === 'string');
  const numCol = pick((c) => c.type === 'integer' || c.type === 'float' || c.type === 'decimal');
  const nullableCol = columns.find((c) => rows.some((r) => r[indexOfColumn(columns, c.name)] === null))?.name;
  const strIdx = strCol !== undefined ? indexOfColumn(columns, strCol) : -1;
  const numIdx = numCol !== undefined ? indexOfColumn(columns, numCol) : -1;

  switch (op) {
    case 'eq':
    case 'ne': {
      const col = strCol ?? numCol;
      if (col === undefined) return undefined;
      const idx = strIdx >= 0 ? strIdx : numIdx;
      const value = firstNonNull(rows, idx);
      if (value === undefined) return undefined;
      return { cond: { column: col, op, value }, colIdx: idx };
    }
    case 'gt':
    case 'ge':
    case 'lt':
    case 'le': {
      if (numCol === undefined) return undefined;
      const value = firstNonNull(rows, numIdx);
      if (value === undefined) return undefined;
      return { cond: { column: numCol, op, value }, colIdx: numIdx };
    }
    case 'like':
    case 'notLike': {
      if (strCol === undefined) return undefined;
      const raw = firstNonNull(rows, strIdx);
      if (typeof raw !== 'string' || raw.length < 2) return undefined;
      // 契约：like 值按子串匹配，通配符由驱动转义；用不含通配符的子串构造
      const substr = raw.slice(0, 2).replace(/[%_\\]/g, '');
      if (!substr) return undefined;
      return { cond: { column: strCol, op, value: substr }, colIdx: strIdx };
    }
    case 'in':
    case 'notIn': {
      const col = strCol ?? numCol;
      const idx = strIdx >= 0 ? strIdx : numIdx;
      if (col === undefined) return undefined;
      const values = [...new Set(rows.map((r) => r[idx]).filter((v) => v !== null && v !== undefined))].slice(0, 2);
      if (values.length < 2) return undefined;
      return { cond: { column: col, op, values }, colIdx: idx };
    }
    case 'isNull':
    case 'isNotNull': {
      if (nullableCol === undefined) return undefined;
      return { cond: { column: nullableCol, op }, colIdx: indexOfColumn(columns, nullableCol) };
    }
    case 'between': {
      if (numCol === undefined) return undefined;
      const nums = rows.map((r) => r[numIdx]).filter((v) => v !== null && v !== undefined);
      if (nums.length < 2) return undefined;
      const sorted = [...nums].sort(valCmp);
      return { cond: { column: numCol, op, values: [sorted[0], sorted[sorted.length - 1]] }, colIdx: numIdx };
    }
    default:
      return undefined;
  }
}

const FILTER_OPS: FilterOp[] = [
  'eq', 'ne', 'gt', 'ge', 'lt', 'le',
  'like', 'notLike', 'in', 'notIn', 'isNull', 'isNotNull', 'between',
];

export interface FilterPushdownOptions {
  /** Redis 类键值驱动不支持用户手写 WHERE 片段（E_VALIDATION）→ 跳过该检查 */
  supportsWhereSql?: boolean;
  /** 排序语义：server = 服务端下推全局序（默认）；page = 页内局部排序
   *  （SCAN 类数据源无服务端排序且禁止取全表）→ 组合 filters+sorts+offset 的
   *  全局序检查按 skip 处理，sorts 页内有序仍由 pagination 组验证 */
  sorts?: 'server' | 'page';
}

/** 筛选下推组（M3）：每个 FilterOp 与内存过滤一致、组合条件+排序+分页、search 子串语义 */
export async function runFilterPushdownChecks(
  create: () => Promise<IConnection>,
  opts?: FilterPushdownOptions,
): Promise<ConformanceSummary> {
  const results: CheckResult[] = [];
  const conn = await create();
  try {
    const sample = await findSampleTable(conn, 10);
    if (!sample) {
      results.push({ group: 'filter-pushdown', name: '样例表（≥10 行）', ok: true, skipped: true });
      return summarize(results);
    }
    const { db, obj, primaryKey } = sample;

    const fetchFiltered = (filters: FilterCondition[], extra?: { sorts?: Array<{ column: string; dir: 'asc' | 'desc' }>; limit?: number; offset?: number; search?: string; whereSql?: string }) =>
      conn.fetchRows({
        db,
        obj,
        filters,
        limit: extra?.limit ?? SAMPLE_LIMIT,
        offset: extra?.offset,
        sorts: extra?.sorts,
        search: extra?.search,
        whereSql: extra?.whereSql,
        timeoutMs: SAMPLE_TIMEOUT_MS,
      });

    // 用户手写 WHERE 片段（驱动规范 §4）：原样拼接且必须生效——1=1 不改变结果集。
    // 不支持的驱动（Redis 类）在收到的片段上抛 E_VALIDATION → 按能力跳过
    if (opts?.supportsWhereSql === false) {
      await skip(results, 'filter-pushdown', 'whereSql 拼接生效（驱动不支持手写片段，跳过）', 'supportsWhereSql=false');
    } else {
      await check(results, 'filter-pushdown', 'whereSql 拼接生效（1=1 结果集不变）', async () => {
        const base = await conn.fetchRows({ db, obj, limit: SAMPLE_LIMIT, timeoutMs: SAMPLE_TIMEOUT_MS });
        const spliced = await conn.fetchRows({
          db,
          obj,
          limit: SAMPLE_LIMIT,
          whereSql: '1 = 1',
          timeoutMs: SAMPLE_TIMEOUT_MS,
        });
        assert(spliced.rowCount === base.rowCount, `拼接 1=1 后行数变化：${base.rowCount} → ${spliced.rowCount}`);
      });
    }

    for (const op of FILTER_OPS) {
      const case_ = buildOpCase(op, sample);
      if (!case_) {
        await skip(results, 'filter-pushdown', `筛选下推 ${op}（样例数据不足，跳过）`, '无合适列/值');
        continue;
      }
      await check(results, 'filter-pushdown', `筛选下推 ${op} 与内存过滤一致`, async () => {
        const rs = await fetchFiltered([case_.cond]);
        const expected = sample.rows.filter((r) => sqlMatch(r, case_.cond, case_.colIdx));
        assert(rs.rowCount === rs.rows.length, 'rowCount 与 rows.length 不一致');
        const pkIdx = primaryKey.length > 0 ? indexOfColumn(rs.columns, primaryKey[0]) : 0;
        assert(
          rs.rows.length === expected.length,
          `行数不一致：下推 ${rs.rows.length} vs 内存 ${expected.length}（${op}）`,
        );
        assert(sameKeySet(rs.rows, expected, pkIdx), `${op} 结果集与内存过滤不一致`);
      });
    }

    if (opts?.sorts === 'page') {
      await skip(
        results,
        'filter-pushdown',
        '组合 filters+sorts+limit+offset（页内排序语义，跳过全局序检查）',
        'sorts=page',
      );
    } else {
      await check(results, 'filter-pushdown', '组合 filters+sorts+limit+offset 与内存流程一致', async () => {
        const case1 = buildOpCase('eq', sample) ?? buildOpCase('gt', sample);
        const case2 = buildOpCase('like', sample);
        assert(case1 !== undefined && case2 !== undefined, '样例数据不足');
        assert(primaryKey.length > 0, '样例表无主键');
        const filters = [case1!.cond, case2!.cond];
        const rs = await fetchFiltered(filters, {
          sorts: [{ column: primaryKey[0], dir: 'asc' }],
          limit: 5,
          offset: 2,
        });
        const expected = sample.rows
          .filter(
            (r) =>
              sqlMatch(r, case1!.cond, case1!.colIdx) && sqlMatch(r, case2!.cond, case2!.colIdx),
          )
          .sort((a, b) => valCmp(a[indexOfColumn(sample.columns, primaryKey[0])], b[indexOfColumn(sample.columns, primaryKey[0])]))
          .slice(2, 7);
        assert(rowsEqual(rs.rows, expected), '组合下推结果与内存过滤+排序+分页不一致');
      });
    }

    await check(results, 'filter-pushdown', 'search 子串语义且特殊字符不抛错', async () => {
      const caseLike = buildOpCase('like', sample);
      if (caseLike === undefined) {
        await skip(results, 'filter-pushdown', 'search 子串语义（无字符串列，跳过）', '样例不足');
        return;
      }
      const kw = String(caseLike.cond.value);
      const rs = await fetchFiltered([], { search: kw });
      const strIdxs = sample.columns.map((c, i) => (c.type === 'string' ? i : -1)).filter((i) => i >= 0);
      for (const row of rs.rows) {
        assert(
          strIdxs.some((i) => cellToString(row[i]).includes(kw)),
          `search 结果行不含关键字 "${kw}"`,
        );
      }
      const weird = await fetchFiltered([], { search: '100%_\\' });
      assert(weird.rowCount === weird.rows.length, 'rowCount 与 rows.length 不一致');
    });
  } finally {
    await conn.dispose();
  }
  return summarize(results);
}
/** metadata 组（M2）：ordinal、唯一性、PK/KeyMeta 一致性、DDL */
export async function runMetadataChecks(create: () => Promise<IConnection>): Promise<ConformanceSummary> {
  const results: CheckResult[] = [];
  const conn = await create();
  try {
    await check(results, 'metadata', 'listDatabases：非空且名称唯一', async () => {
      const dbs = await conn.listDatabases();
      const names = dbs.map((d) => d.name);
      assert(names.length > 0, '库列表为空');
      assert(new Set(names).size === names.length, '库名存在重复');
    });

    await check(results, 'metadata', 'listObjects：kind 合法', async () => {
      const dbs = await conn.listDatabases();
      const objs = await conn.listObjects(dbs[0].name);
      assert(objs.length > 0, '对象列表为空');
      const kinds = new Set(['table', 'view', 'materialized-view', 'collection']);
      for (const o of objs) {
        assert(kinds.has(o.kind), `非法 kind: ${o.kind}`);
      }
    });

    await check(results, 'metadata', 'listColumns：ordinal 严格递增、名称唯一', async () => {
      const { db, obj } = await firstTable(conn);
      const cols = await conn.listColumns(db, obj);
      assert(cols.length > 0, '列列表为空');
      const ords = cols.map((c) => c.ordinal);
      for (let i = 1; i < ords.length; i++) {
        assert(ords[i] > ords[i - 1], 'ordinal 未严格递增');
      }
      const names = cols.map((c) => c.name);
      assert(new Set(names).size === names.length, '列名存在重复');
    });

    await check(results, 'metadata', 'listKeys 与列级 PK 标记一致', async () => {
      const { db, obj } = await firstTable(conn);
      const cols = await conn.listColumns(db, obj);
      const pkCols = cols.filter((c) => c.isPrimaryKey).map((c) => c.name);
      if (!conn.listKeys) {
        return; // 可选能力
      }
      const pkKeys = (await conn.listKeys(db, obj)).filter((k) => k.kind === 'PK');
      assert(
        pkKeys.length === 0 || pkKeys[0].columns.join(',') === pkCols.join(','),
        'KeyMeta PK 与列级 isPrimaryKey 不一致',
      );
    });

    await check(results, 'metadata', 'listIndexes/listKeys：名称唯一、columns 非空', async () => {
      const { db, obj } = await firstTable(conn);
      if (conn.listIndexes) {
        const idx = await conn.listIndexes(db, obj);
        const names = idx.map((i) => i.name);
        assert(new Set(names).size === names.length, '索引名重复');
        for (const i of idx) {
          assert(i.columns.length > 0, `索引 ${i.name} 未声明列`);
        }
      }
      if (conn.listKeys) {
        const keys = await conn.listKeys(db, obj);
        const names = keys.map((k) => k.name);
        assert(new Set(names).size === names.length, '键名重复');
      }
    });

    await check(results, 'metadata', 'getDdl：已实现时输出非空（可选能力，未实现跳过）', async () => {
      if (typeof conn.getDdl !== 'function') {
        return;
      }
      const { db, obj } = await firstTable(conn);
      const ddl = await conn.getDdl(db, obj);
      assert(typeof ddl === 'string' && ddl.trim().length > 0, 'DDL 为空');
    });
  } finally {
    await conn.dispose();
  }

  const failed = results.filter((r) => !r.ok).length;
  return { passed: results.length - failed, failed, results };
}

// ───────────────────────── M4：变更集 ─────────────────────────

const CT: Record<string, unknown> = {
  string: 'cf-str',
  integer: 999_991,
  decimal: '42.42',
  float: 1.5,
  boolean: true,
  date: '2024-06-01',
  time: '08:30:00.000',
  datetime: '2024-06-01 08:30:00.000',
  json: { cf: 1 },
  binary: 'Y2Y=',
  uuid: '00000000-0000-0000-0000-000000000000',
  unknown: 'cf-unknown',
};

/** 按列类型构造契约测试值（值编码契约 §5） */
function sampleValueFor(c: ColumnMeta, salt: string): unknown {
  const base = CT[c.normalizedType] ?? CT.unknown;
  const isTimestampLike = c.normalizedType === 'date' || c.normalizedType === 'time' || c.normalizedType === 'datetime' || c.normalizedType === 'uuid';
  if (typeof base === 'string' && !isTimestampLike) {
    return salt ? `${base}-${salt}` : base;
  }
  return base;
}

/** 变更用新值：与原值可区分且类型合法 */
function mutateValue(v: unknown, type: NormalizedType, salt: string): unknown {
  if (v === null || v === undefined) {
    return sampleValueFor({ name: 'x', dataType: 'x', nullable: true, isPrimaryKey: false, ordinal: 1, normalizedType: type } as ColumnMeta, salt);
  }
  switch (type) {
    case 'integer':
      return (typeof v === 'number' ? v : Number(v)) + 100_000;
    case 'float':
      return (typeof v === 'number' ? v : Number(v)) + 1.5;
    case 'decimal':
      return '77.77';
    case 'boolean':
      return typeof v === 'boolean' ? !v : true;
    default:
      return `cf-${salt}`;
  }
}

function idxOfName(cols: Array<{ name: string }>, name: string): number {
  return cols.findIndex((c) => c.name === name);
}

/** 从结果行抽取主键映射（RowKey，禁止行号——概要设计 §4.5） */
function rowKeyOf(row: unknown[], cols: Array<{ name: string }>, primaryKey: string[]): RowKey {
  const key: RowKey = {};
  for (const name of primaryKey) {
    key[name] = row[idxOfName(cols, name)];
  }
  return key;
}

function pkFilters(pkMap: RowKey): FilterCondition[] {
  return Object.entries(pkMap).map(([column, value]) => ({ column, op: 'eq' as const, value }));
}

/** 挑一个可编辑的非主键列：首行该列非 NULL、类型可构造值 */
function pickMutableColumn(
  cols: Array<{ name: string; type: NormalizedType }>,
  row: unknown[],
  primaryKey: string[],
): { name: string; type: NormalizedType } | undefined {
  return cols.find(
    (c) =>
      !primaryKey.includes(c.name) &&
      ['string', 'integer', 'float', 'decimal'].includes(c.type) &&
      row[idxOfName(cols, c.name)] !== null,
  );
}

function toChangeSet(cs: Partial<ChangeSet>): ChangeSet {
  return { inserts: cs.inserts ?? [], updates: cs.updates ?? [], deletes: cs.deletes ?? [] };
}

function isConflict(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'E_CONFLICT';
}

function isCode(err: unknown, code: string): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === code;
}

function describeError(err: unknown): string {
  return typeof err === 'object' && err !== null
    ? `${(err as { code?: string }).code ?? ''} ${(err as { message?: string }).message ?? ''}`.trim()
    : String(err);
}

/** 值一致（数值化比较，兼容 DECIMAL 字符串与 number） */
function cellSame(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  const num = (v: unknown) => (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v)) ? Number(v) : undefined);
  const na = typeof a === 'number' ? a : num(a);
  const nb = typeof b === 'number' ? b : num(b);
  if (na !== undefined && nb !== undefined) return na === nb;
  return String(a) === String(b);
}

/**
 * 变更集组（M4，概要设计 §12.2-5 / 驱动规范 §8）：
 * insert 回填主键；update 冲突 → E_CONFLICT 且库中数据未变（无半提交）；
 * 混合事务原子性；NULL 原值按 IS NULL 匹配。
 * 语句形状（参数化/无值拼接）由各驱动 SQL 构建层单测覆盖（同 M3 筛选下推的处理，P-9）。
 */
export async function runChangesetChecks(create: () => Promise<IConnection>): Promise<ConformanceSummary> {
  const results: CheckResult[] = [];
  const conn = await create();
  try {
    // 能力探测：编辑未实现（E_UNSUPPORTED）→ 整组跳过；其余错误（如探测用表不存在）
    // 恰说明编辑已实现，继续跑组（契约测试按能力裁剪，规范 §11）
    try {
      await conn.applyChanges('cf', 'cf', toChangeSet({}));
      const preview = await conn.previewChanges('cf', 'cf', toChangeSet({}));
      assert(Array.isArray(preview), 'previewChanges 应返回数组');
    } catch (err) {
      if (isCode(err, 'E_UNSUPPORTED')) {
        await skip(results, 'changeset', '变更集组（驱动未实现编辑，跳过）', describeError(err));
        return summarize(results);
      }
    }

    const sample = await findSampleTable(conn, 5);
    if (!sample || sample.primaryKey.length === 0) {
      await skip(results, 'changeset', '变更集组（无带主键的样例表，跳过）', '样例不足');
      return summarize(results);
    }
    const { db, obj, primaryKey } = sample;
    const columns = await conn.listColumns(db, obj);

    await check(results, 'changeset', 'insert 回填生成主键且按其可查回', async () => {
      const values: Record<string, unknown> = {};
      for (const c of columns) {
        if (c.isPrimaryKey && c.autoIncrement) continue;
        values[c.name] = sampleValueFor(c, c.isPrimaryKey ? `cfk${Date.now() % 100000}` : 'ins');
      }
      const apply = await conn.applyChanges(db, obj, toChangeSet({
        inserts: [{ tempId: 'cf-ins', values }],
      }));
      const item = apply.items.find((i) => i.kind === 'insert' && i.tempId === 'cf-ins');
      assert(item !== undefined, 'ApplyResult 缺少 insert 项');
      assert(item.rowKey !== undefined && Object.keys(item.rowKey!).length > 0, 'insert 未回填生成主键');
      const after = await conn.fetchRows({ db, obj, filters: pkFilters(item.rowKey!), limit: 5, timeoutMs: SAMPLE_TIMEOUT_MS });
      assert(after.rowCount === 1, `按回填主键应查回 1 行，实际 ${after.rowCount}`);
      // 清理
      await conn.applyChanges(db, obj, toChangeSet({ deletes: [{ rowKey: item.rowKey!, original: {} }] }));
    });

    await check(results, 'changeset', 'preview 语句带参数化 params（? 数量 = params 长度）', async () => {
      // PreviewItem.params 是 IConnection 层可观测的（区别于 P-9 的 SQL 形状）：
      // Webview 预览回填实际值依赖它，占位符语句缺失 params 会让预览只剩 ?
      const rs = await conn.fetchRows({
        db, obj, limit: 1,
        sorts: primaryKey.map((c) => ({ column: c, dir: 'asc' as const })),
        timeoutMs: SAMPLE_TIMEOUT_MS,
      });
      const row = rs.rows[0];
      assert(row !== undefined, '表为空');
      const cols = rs.columns;
      const target = pickMutableColumn(cols, row, primaryKey);
      if (!target) {
        await skip(results, 'changeset', 'preview 参数化（无可变更列，跳过）', '样例不足');
        return;
      }
      const pkMap = rowKeyOf(row, cols, primaryKey);
      const current = row[idxOfName(cols, target.name)];
      const nextValue = mutateValue(current, target.type, 'other');
      const values: Record<string, unknown> = {};
      for (const c of columns) {
        if (c.isPrimaryKey && c.autoIncrement) continue;
        values[c.name] = sampleValueFor(c, 'prev');
      }
      const preview = await conn.previewChanges(db, obj, toChangeSet({
        inserts: [{ tempId: 'cf-prev', values }],
        updates: [{ rowKey: pkMap, original: pkMap, changes: { [target.name]: { old: current, new: nextValue } } }],
        deletes: [{ rowKey: pkMap, original: pkMap }],
      }));
      assert(preview.length >= 3, `预览应覆盖 insert/update/delete，实际 ${preview.length} 条`);
      for (const item of preview) {
        const marks = (item.sql.match(/\?/g) ?? []).length;
        if (marks === 0) continue; // 以字面量内联的语句无占位符，不约束
        assert(item.params !== undefined, `${item.kind} 语句含 ${marks} 个 ? 但未携带 params`);
        assert(item.params!.length === marks, `${item.kind} ? 数量 ${marks} ≠ params 长度 ${item.params!.length}`);
      }
    });

    await check(results, 'changeset', 'update 冲突 → E_CONFLICT 且库中数据未变（无半提交）', async () => {
      const rs = await conn.fetchRows({
        db, obj, limit: 1,
        sorts: primaryKey.map((c) => ({ column: c, dir: 'asc' as const })),
        timeoutMs: SAMPLE_TIMEOUT_MS,
      });
      const row = rs.rows[0];
      assert(row !== undefined, '表为空');
      const cols = rs.columns;
      const target = pickMutableColumn(cols, row, primaryKey);
      if (!target) {
        await skip(results, 'changeset', 'update 冲突（无可变更列，跳过）', '样例不足');
        return;
      }
      const pkMap = rowKeyOf(row, cols, primaryKey);
      const current = row[idxOfName(cols, target.name)];
      const otherValue = mutateValue(current, target.type, 'other');

      // 他人先改：目标行变更列变为 otherValue
      await conn.applyChanges(db, obj, toChangeSet({
        updates: [{ rowKey: pkMap, original: pkMap, changes: { [target.name]: { old: current, new: otherValue } } }],
      }));

      // 陈旧 changeset（基于 old=current）+ 混入 insert：update 冲突必须整体回滚
      let thrown: unknown;
      try {
        await conn.applyChanges(db, obj, toChangeSet({
          inserts: [{ tempId: 'cf-stale', values: Object.fromEntries(columns.map((c) => [c.name, sampleValueFor(c, 'stale')])) }],
          updates: [{ rowKey: pkMap, original: pkMap, changes: { [target.name]: { old: current, new: 'cf-stale-value' } } }],
        }));
      } catch (err) {
        thrown = err;
      }
      assert(thrown !== undefined, '陈旧 update 未抛错');
      assert(isConflict(thrown), `应抛 E_CONFLICT，实际 ${describeError(thrown)}`);

      // 库中数据未变：变更列仍是 otherValue
      const after = await conn.fetchRows({ db, obj, filters: pkFilters(pkMap), limit: 5, timeoutMs: SAMPLE_TIMEOUT_MS });
      assert(after.rowCount === 1, '冲突后原行丢失');
      const nowValue = after.rows[0][idxOfName(after.columns, target.name)];
      assert(cellSame(nowValue, otherValue), `冲突后变更列被意外改写：${String(nowValue)} ≠ ${String(otherValue)}`);
      // insert 未半提交：按 salt 特征值查应无行
      const probe = await conn.fetchRows({ db, obj, limit: 5, timeoutMs: SAMPLE_TIMEOUT_MS, search: 'cf-str-stale' });
      assert(probe.rowCount === 0, '冲突事务中的 insert 半提交（违反原子性）');

      // 清理：恢复原值
      await conn.applyChanges(db, obj, toChangeSet({
        updates: [{ rowKey: pkMap, original: pkMap, changes: { [target.name]: { old: otherValue, new: current } } }],
      }));
    });

    await check(results, 'changeset', 'insert/update/delete 混合事务原子性', async () => {
      const rs = await conn.fetchRows({
        db, obj, limit: 2,
        sorts: primaryKey.map((c) => ({ column: c, dir: 'asc' as const })),
        timeoutMs: SAMPLE_TIMEOUT_MS,
      });
      assert(rs.rows.length >= 2, '样例行不足 2 行');
      const cols = rs.columns;
      const rowA = rs.rows[0];
      const target = pickMutableColumn(cols, rowA, primaryKey);
      if (!target) {
        await skip(results, 'changeset', '混合原子性（无可变更列，跳过）', '样例不足');
        return;
      }
      const keyA = rowKeyOf(rowA, cols, primaryKey);
      const keyB = rowKeyOf(rs.rows[1], cols, primaryKey);
      const oldA = rowA[idxOfName(cols, target.name)];
      const newA = mutateValue(oldA, target.type, 'mix');

      // delete 指向不存在的主键 → 最后一条失败，前面已执行的必须全部回滚
      const ghostKey: RowKey = {};
      for (const [k, v] of Object.entries(keyB)) {
        ghostKey[k] = typeof v === 'number' ? -999_999_999 : 'cf-ghost-key';
      }
      let thrown: unknown;
      try {
        await conn.applyChanges(db, obj, toChangeSet({
          inserts: [{ tempId: 'cf-mix', values: Object.fromEntries(columns.map((c) => [c.name, sampleValueFor(c, 'mix')])) }],
          updates: [{ rowKey: keyA, original: keyA, changes: { [target.name]: { old: oldA, new: newA } } }],
          deletes: [{ rowKey: ghostKey, original: {} }],
        }));
      } catch (err) {
        thrown = err;
      }
      assert(thrown !== undefined, '幽灵主键 DELETE 未抛错');
      assert(isConflict(thrown), `应抛 E_CONFLICT，实际 ${describeError(thrown)}`);

      const checkA = await conn.fetchRows({ db, obj, filters: pkFilters(keyA), limit: 2, timeoutMs: SAMPLE_TIMEOUT_MS });
      assert(cellSame(checkA.rows[0][idxOfName(checkA.columns, target.name)], oldA), '混合事务中 update 半提交');
      const checkB = await conn.fetchRows({ db, obj, filters: pkFilters(keyB), limit: 2, timeoutMs: SAMPLE_TIMEOUT_MS });
      assert(checkB.rowCount === 1, '混合事务中 delete 半提交（幽灵键不应删除任何行）');
      const probe = await conn.fetchRows({ db, obj, limit: 5, timeoutMs: SAMPLE_TIMEOUT_MS, search: 'cf-str-mix' });
      assert(probe.rowCount === 0, '混合事务中 insert 半提交');
    });

    await check(results, 'changeset', '含 NULL 原值的变更列按 IS NULL 匹配', async () => {
      const nullableCol = sample.columns.find(
        (c) => !primaryKey.includes(c.name) && ['string', 'integer', 'float', 'decimal'].includes(c.type)
          && sample.rows.some((r) => r[idxOfName(sample.columns, c.name)] === null),
      );
      if (!nullableCol) {
        await skip(results, 'changeset', 'NULL 原值匹配（样例无 NULL 可变更列，跳过）', '样例不足');
        return;
      }
      const colIdx = idxOfName(sample.columns, nullableCol.name);
      const nullRow = sample.rows.find((r) => r[colIdx] === null)!;
      const pkMap = rowKeyOf(nullRow, sample.columns, primaryKey);

      // 原值 NULL → 新值：若驱动生成 col = NULL 则永不匹配，apply 将以 E_CONFLICT 失败
      const filled = mutateValue(null, nullableCol.type, 'nullfill');
      await conn.applyChanges(db, obj, toChangeSet({
        updates: [{ rowKey: pkMap, original: pkMap, changes: { [nullableCol.name]: { old: null, new: filled } } }],
      }));
      const after = await conn.fetchRows({ db, obj, filters: pkFilters(pkMap), limit: 2, timeoutMs: SAMPLE_TIMEOUT_MS });
      const now = after.rows[0][idxOfName(after.columns, nullableCol.name)];
      assert(cellSame(now, filled), `NULL 原值列未被更新（IS NULL 匹配失效）：${String(now)}`);

      // 反向：再用原值 NULL 的陈旧 changeset 提交 → 当前已非 NULL，必须冲突
      let thrown: unknown;
      try {
        await conn.applyChanges(db, obj, toChangeSet({
          updates: [{ rowKey: pkMap, original: pkMap, changes: { [nullableCol.name]: { old: null, new: 'cf-stale-null' } } }],
        }));
      } catch (err) {
        thrown = err;
      }
      assert(thrown !== undefined && isConflict(thrown), 'IS NULL 匹配失效：陈旧 NULL 原值未引发冲突');

      // 清理：恢复 NULL
      await conn.applyChanges(db, obj, toChangeSet({
        updates: [{ rowKey: pkMap, original: pkMap, changes: { [nullableCol.name]: { old: filled, new: null } } }],
      }));
    });
  } finally {
    await conn.dispose();
  }
  return summarize(results);
}

// ───────────────────────── M6：cursor 分页 / SCAN 语义 / 值编码 ─────────────────────────

export interface CursorPaginationOptions {
  /** 仅 pagination='cursor' 的驱动跑本组，其余整组跳过 */
  pagination?: 'offset' | 'cursor' | 'none';
}

/** cursor 分页组（M6）：nextCursor 存在性与翻页闭环（沿游标走完 = 全量取，无重复无遗漏） */
export async function runCursorPaginationChecks(
  create: () => Promise<IConnection>,
  opts?: CursorPaginationOptions,
): Promise<ConformanceSummary> {
  const results: CheckResult[] = [];
  if (opts?.pagination !== 'cursor') {
    await skip(results, 'cursor-pagination', 'cursor 分页组（驱动非 cursor 分页，跳过）', 'pagination≠cursor');
    return summarize(results);
  }
  const conn = await create();
  try {
    const sample = await findSampleTable(conn, 5);
    if (!sample) {
      await skip(results, 'cursor-pagination', '样例对象（≥5 行，跳过）', '样例不足');
      return summarize(results);
    }
    const { db, obj, primaryKey } = sample;
    assert(primaryKey.length > 0, 'cursor 组样例无主键列');
    const pkIdx = indexOfColumn(sample.columns, primaryKey[0]);

    await check(results, 'cursor-pagination', 'cursor 翻页闭环：走完游标 = 全量取（无重复无遗漏）', async () => {
      const full = await conn.fetchRows({ db, obj, limit: SAMPLE_LIMIT, timeoutMs: SAMPLE_TIMEOUT_MS });
      const walked: unknown[][] = [];
      const seen = new Set<string>();
      let cursor: string | undefined;
      let pages = 0;
      do {
        const page = await conn.fetchRows({
          db, obj, limit: 3, cursor, timeoutMs: SAMPLE_TIMEOUT_MS,
        });
        for (const row of page.rows) {
          const key = JSON.stringify(row[pkIdx]);
          assert(!seen.has(key), `cursor 翻页出现重复行：${key}`);
          seen.add(key);
          walked.push(row);
        }
        cursor = page.nextCursor;
        pages++;
        assert(pages < 10_000, 'cursor 翻页未收敛（疑似游标环）');
      } while (cursor !== undefined);
      assert(
        walked.length === full.rows.length,
        `cursor 走完 ${walked.length} 行 ≠ 全量 ${full.rows.length} 行`,
      );
      assert(
        sameKeySet(walked, full.rows, pkIdx),
        'cursor 走完的键集合与全量取不一致',
      );
    });

    await check(results, 'cursor-pagination', '满页时返回 nextCursor；相邻页无重叠', async () => {
      const page = await conn.fetchRows({ db, obj, limit: 3, timeoutMs: SAMPLE_TIMEOUT_MS });
      const full = await conn.fetchRows({ db, obj, limit: SAMPLE_LIMIT, timeoutMs: SAMPLE_TIMEOUT_MS });
      if (full.rows.length > 3) {
        assert(typeof page.nextCursor === 'string' && page.nextCursor.length > 0, '未取尽时应返回 nextCursor');
        const nextPage = await conn.fetchRows({
          db, obj, limit: 3, cursor: page.nextCursor, timeoutMs: SAMPLE_TIMEOUT_MS,
        });
        const overlap = page.rows.some((r1) => nextPage.rows.some((r2) => rowEq(r1, r2)));
        assert(!overlap, '相邻两 cursor 页存在重叠行');
      } else {
        assert(page.nextCursor === undefined, '已取尽时不应返回 nextCursor');
      }
    });
  } finally {
    await conn.dispose();
  }
  return summarize(results);
}

export interface ScanSemanticsOptions {
  pagination?: 'offset' | 'cursor' | 'none';
}

const KV_TYPE_VALUES = new Set(['string', 'hash', 'list', 'set', 'zset', 'stream']);

/** glob → RegExp（* ? [class] 足够覆盖测试模式；仅用于契约基准，不做完整 glob） */
function globToRegExp(pattern: string): RegExp {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '*') re += '[\\s\\S]*';
    else if (ch === '?') re += '[\\s\\S]';
    else if (ch === '[') {
      const end = pattern.indexOf(']', i);
      if (end < 0) re += '\\[';
      else {
        re += pattern.slice(i, end + 1);
        i = end;
      }
    } else re += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

/** SCAN 语义组（M6，键值数据源）：模式匹配正确、type 列合法、__ttl 整数 */
export async function runScanSemanticsChecks(
  create: () => Promise<IConnection>,
  opts?: ScanSemanticsOptions,
): Promise<ConformanceSummary> {
  const results: CheckResult[] = [];
  if (opts?.pagination !== 'cursor') {
    await skip(results, 'scan-semantics', 'SCAN 语义组（驱动非 cursor 分页，跳过）', 'pagination≠cursor');
    return summarize(results);
  }
  const conn = await create();
  try {
    // 键目录样例：需列含 key/type（模式节点）。findSampleTable 可能命中类型分组下的
    // 单键内容表（无 key/type 列），此处按列形状自行探测
    let sample: SampleTable | undefined;
    const dbs = await conn.listDatabases();
    outer: for (const db of dbs) {
      const objs = await conn.listObjects(db.name);
      for (const obj of objs.filter((o) => o.kind === 'collection')) {
        let rs;
        try {
          rs = await conn.fetchRows({ db: db.name, obj: obj.name, limit: SAMPLE_LIMIT, timeoutMs: SAMPLE_TIMEOUT_MS });
        } catch {
          continue; // E_UNSUPPORTED 等条目（如 stream 键）跳过
        }
        if (rs.columns.some((c) => c.name === 'key') && rs.columns.some((c) => c.name === 'type')) {
          sample = {
            db: db.name,
            obj: obj.name,
            primaryKey: rs.primaryKey ?? [],
            rows: rs.rows,
            columns: rs.columns,
          };
          break outer;
        }
      }
    }
    if (!sample || !sample.columns.some((c) => c.name === 'key') || !sample.columns.some((c) => c.name === 'type')) {
      await skip(results, 'scan-semantics', 'SCAN 语义组（样例无 key/type 列，跳过）', '样例不足');
      return summarize(results);
    }
    const { obj } = sample;
    const keyIdx = indexOfColumn(sample.columns, 'key');
    const typeIdx = indexOfColumn(sample.columns, 'type');
    const pattern = globToRegExp(obj);

    await check(results, 'scan-semantics', '模式浏览行全部匹配 obj 模式（SCAN MATCH 下推）', async () => {
      assert(sample.rows.length > 0, '模式浏览返回空');
      for (const row of sample.rows) {
        const key = row[keyIdx];
        assert(typeof key === 'string', `key 列应为字符串，实际 ${typeof key}`);
        assert(pattern.test(key), `键 "${key}" 不匹配模式 "${obj}"`);
      }
    });

    await check(results, 'scan-semantics', 'type 列为合法 Redis 类型', async () => {
      for (const row of sample.rows) {
        const type = row[typeIdx];
        assert(typeof type === 'string' && KV_TYPE_VALUES.has(type), `非法 type 列值: ${String(type)}`);
      }
    });

    const ttlCol = sample.columns.find((c) => c.name === '__ttl');
    if (ttlCol) {
      await check(results, 'scan-semantics', '__ttl 列为整数（-1=无过期，≥0=剩余秒）', async () => {
        const ttlIdx = indexOfColumn(sample.columns, '__ttl');
        for (const row of sample.rows) {
          const ttl = row[ttlIdx];
          const n = toNumber(ttl);
          assert(n !== undefined && Number.isInteger(n), `__ttl 应为整数，实际 ${String(ttl)}`);
          assert(n >= -1, `__ttl 非法（应 ≥ -1）: ${String(ttl)}`);
        }
      });
    }
  } finally {
    await conn.dispose();
  }
  return summarize(results);
}

export interface ValueEncodingFixtures {
  db?: string;
  /** 预置键名（驱动测试负责写入已知数据）：断言内容表列形状与值 JSON 安全 */
  hash?: string;
  list?: string;
  set?: string;
  zset?: string;
  string?: string;
  /** 二进制值键：断言单元格为合法 base64 */
  binary?: string;
}

/** 值编码组（M6，概要 §4.4 / 驱动规范 §5.3）：单元格 JSON 安全 + 类型化内容表形状 */
export async function runValueEncodingChecks(
  create: () => Promise<IConnection>,
  fixtures?: ValueEncodingFixtures,
): Promise<ConformanceSummary> {
  const results: CheckResult[] = [];
  const conn = await create();
  try {
    const dbs = await conn.listDatabases();
    assert(dbs.length > 0, 'listDatabases 返回空数组');
    const db = fixtures?.db ?? dbs[0].name;

    await check(results, 'value-encoding', '样例行全部 JSON 安全（无二进制泄漏/循环引用）', async () => {
      const sample = await findSampleTable(conn, 1);
      if (!sample) {
        await skip(results, 'value-encoding', '样例行 JSON 安全（无样例，跳过）', '样例不足');
        return;
      }
      const rs = await conn.fetchRows({ db: sample.db, obj: sample.obj, limit: SAMPLE_LIMIT, timeoutMs: SAMPLE_TIMEOUT_MS });
      for (const row of rs.rows) {
        for (const cell of row) {
          const json = JSON.stringify(cell ?? null);
          assert(json !== undefined, `单元格不可 JSON 序列化: ${String(cell)}`);
          // Buffer 实例会序列化为 {type:'Buffer',...}——IConnection 层不允许泄漏
          assert(!Buffer.isBuffer(cell), '单元格为 Buffer 实例（违反值编码契约）');
        }
      }
    });

    const contentShape: Array<[keyof ValueEncodingFixtures, string[], (name: string) => string]> = [
      ['hash', ['field', 'value'], (n) => `hash 键 "${n}" 应为 field/value 两列`],
      ['list', ['index', 'value'], (n) => `list 键 "${n}" 应为 index/value 两列`],
      ['set', ['member'], (n) => `set 键 "${n}" 应为 member 列`],
      ['zset', ['member', 'score'], (n) => `zset 键 "${n}" 应为 member/score 两列`],
      ['string', ['value'], (n) => `string 键 "${n}" 应为 value 列`],
    ];

    for (const [fixtureKey, expectedCols, failMsg] of contentShape) {
      const keyName = fixtures?.[fixtureKey];
      if (typeof keyName !== 'string') {
        continue;
      }
      await check(results, 'value-encoding', `内容表形状：${String(fixtureKey)}（${keyName}）`, async () => {
        const rs = await conn.fetchRows({ db, obj: keyName, limit: 100, timeoutMs: SAMPLE_TIMEOUT_MS });
        assert(rs.columns.map((c) => c.name).join(',') === expectedCols.join(','), failMsg(keyName));
        assert(rs.rows.length > 0, `内容表 ${keyName} 为空`);
        for (const row of rs.rows) {
          for (const cell of row) {
            assert(!Buffer.isBuffer(cell), '单元格为 Buffer 实例（违反值编码契约）');
            if (typeof cell === 'object' && cell !== null) {
              assert(JSON.stringify(cell) !== undefined, 'json 值不可序列化');
            }
          }
        }
      });
    }

    if (typeof fixtures?.binary === 'string') {
      await check(results, 'value-encoding', `二进制值 → base64（${fixtures.binary}）`, async () => {
        const rs = await conn.fetchRows({ db, obj: fixtures.binary!, limit: 10, timeoutMs: SAMPLE_TIMEOUT_MS });
        assert(rs.rows.length === 1, '二进制 string 键应返回 1 行');
        const cell = rs.rows[0][0];
        assert(typeof cell === 'string' && cell.length > 0, '二进制值应为非空 base64 字符串');
        assert(/^[A-Za-z0-9+/=]+$/.test(cell), `值非合法 base64: ${String(cell).slice(0, 20)}…`);
      });
    }
  } finally {
    await conn.dispose();
  }
  return summarize(results);
}
