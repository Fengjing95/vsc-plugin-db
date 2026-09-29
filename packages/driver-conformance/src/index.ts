import type { FilterCondition, FilterOp, IConnection, NormalizedType } from '@db-explorer/core';

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
  const table = (await conn.listObjects(dbs[0].name)).find((o) => o.kind === 'table');
  assert(table !== undefined, '首个库没有表');
  return { db: dbs[0].name, obj: table.name };
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

/** 在首个满足条件的库中取样例表：优先含 NULL 值的表（覆盖 isNull/isNotNull），退而求其次取 ≥minRows 行表 */
async function findSampleTable(conn: IConnection, minRows: number): Promise<SampleTable | undefined> {
  const dbs = await conn.listDatabases();
  for (const db of dbs) {
    let fallback: SampleTable | undefined;
    const objs = await conn.listObjects(db.name);
    for (const obj of objs.filter((o) => o.kind === 'table' || o.kind === 'view')) {
      const rs = await conn.fetchRows({ db: db.name, obj: obj.name, limit: SAMPLE_LIMIT, timeoutMs: SAMPLE_TIMEOUT_MS });
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

/** 筛选下推组（M3）：每个 FilterOp 与内存过滤一致、组合条件+排序+分页、search 子串语义 */
export async function runFilterPushdownChecks(create: () => Promise<IConnection>): Promise<ConformanceSummary> {
  const results: CheckResult[] = [];
  const conn = await create();
  try {
    const sample = await findSampleTable(conn, 10);
    if (!sample) {
      results.push({ group: 'filter-pushdown', name: '样例表（≥10 行）', ok: true, skipped: true });
      return summarize(results);
    }
    const { db, obj, primaryKey } = sample;

    const fetchFiltered = (filters: FilterCondition[], extra?: { sorts?: Array<{ column: string; dir: 'asc' | 'desc' }>; limit?: number; offset?: number; search?: string }) =>
      conn.fetchRows({
        db,
        obj,
        filters,
        limit: extra?.limit ?? SAMPLE_LIMIT,
        offset: extra?.offset,
        sorts: extra?.sorts,
        search: extra?.search,
        timeoutMs: SAMPLE_TIMEOUT_MS,
      });

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
