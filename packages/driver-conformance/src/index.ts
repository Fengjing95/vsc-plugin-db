import type { IConnection } from '@db-explorer/core';

/**
 * 驱动契约测试套件（概要设计 §12.2）。
 * 各驱动在自己的 CI 中调用并必须全部通过。
 * 组清单：connection（M0）、metadata（M2）；分页/筛选下推/变更集/取消/值编码随 M3/M4 扩充。
 */
export interface CheckResult {
  group: string;
  name: string;
  ok: boolean;
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
