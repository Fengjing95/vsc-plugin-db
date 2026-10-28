import type { ColumnMeta, IndexMeta, KeyMeta, ObjectMeta } from '@db-explorer/core';
import { diffTable, diffTableSummaries, type TableBaseline } from '@db-explorer/core';
import {
  CompareSummaryParamsSchema,
  CompareTableParamsSchema,
  type CompareSummaryResult,
  type CompareTableResult,
} from '@db-explorer/protocol';
import type { MetadataCache } from '@db-explorer/core';

/**
 * 表结构对比服务（ADR D-29 / 交互稿 §17）：同连接两库的同名表结构 diff——只读展示。
 * 数据面 = 既有自省三件套（listObjects/listColumns/listKeys/listIndexes，经 MetadataCache
 * TTL 与失效联动，概要 §7.5）；对齐口径在 core schemaDiff（P-57① 形状对齐）。
 * 清单页需对全部同名表同步 diff——基线先有界并发预取（ER_SCAN_CONCURRENCY 同款口径），
 * 缓存命中时毫秒级直出。
 */

/** 基线预取并发上界（同 ER 元数据扫描口径，防百表库瞬时风暴） */
const BASELINE_CONCURRENCY = 8;

export class SchemaCompareService {
  /** 基线缓存（Promise 形态——table() 单表惰性） */
  private baselineCache = new Map<string, Promise<TableBaseline>>();
  /** 已就绪基线（list() 预取后填充，供同步 diff 消费） */
  private readyBaselines = new Map<string, TableBaseline>();

  constructor(
    private readonly deps: {
      connections: ConnectionManagerLike;
      cache: MetadataCache;
    },
  ) {}

  async list(raw: unknown): Promise<CompareSummaryResult> {
    const p = CompareSummaryParamsSchema.parse(raw);
    const conn = await this.deps.connections.ensureConnected(p.connId);
    const [objsA, objsB] = await Promise.all([
      this.deps.cache.getObjects(p.connId, p.dbA, () => conn.listObjects(p.dbA)),
      this.deps.cache.getObjects(p.connId, p.dbB, () => conn.listObjects(p.dbB)),
    ]);
    const tablesA = objsA.filter((o) => o.kind === 'table');
    const tablesB = objsB.filter((o) => o.kind === 'table');
    const namesB = new Set(tablesB.map((b) => b.name));
    const names = tablesA.filter((a) => namesB.has(a.name)).map((a) => a.name);

    // 有界并发预取两库基线（清单页 diff 是同步纯函数，基线必须先在手）
    let next = 0;
    const workers = Array.from({ length: Math.min(BASELINE_CONCURRENCY, names.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= names.length) {
          return;
        }
        const t = names[i];
        const [a, b] = await Promise.all([
          this.baseline(p.connId, p.dbA, t, conn),
          this.baseline(p.connId, p.dbB, t, conn),
        ]);
        this.readyBaselines.set(`${p.connId}/${p.dbA}/${t}`, a);
        this.readyBaselines.set(`${p.connId}/${p.dbB}/${t}`, b);
      }
    });
    await Promise.all(workers);

    const unwrap = (connId: string, db: string, obj: string): TableBaseline => {
      const cached = this.readyBaselines.get(`${connId}/${db}/${obj}`);
      if (!cached) {
        throw new Error(`schema compare 基线缺失: ${db}.${obj}`);
      }
      return cached;
    };

    return {
      tables: diffTableSummaries(
        tablesA,
        tablesB,
        (table) => {
          const a = unwrap(p.connId, p.dbA, table);
          const b = unwrap(p.connId, p.dbB, table);
          return diffTable(table, a, b);
        },
      ),
    };
  }

  async table(raw: unknown): Promise<CompareTableResult> {
    const p = CompareTableParamsSchema.parse(raw);
    const conn = await this.deps.connections.ensureConnected(p.connId);
    const [a, b] = await Promise.all([
      this.baseline(p.connId, p.dbA, p.table, conn),
      this.baseline(p.connId, p.dbB, p.table, conn),
    ]);
    const d = diffTable(p.table, a, b);
    return {
      table: d.table,
      columns: d.columns,
      primaryKey: d.primaryKey,
      indexes: d.indexes,
      foreignKeys: d.foreignKeys,
    };
  }

  private baseline(connId: string, db: string, obj: string, conn: ConnectionLike): Promise<TableBaseline> {
    const key = `${connId}/${db}/${obj}`;
    let p = this.baselineCache.get(key);
    if (!p) {
      p = (async () => {
        const columns: ColumnMeta[] = await this.deps.cache.getColumns(connId, db, obj, () => conn.listColumns(db, obj));
        const keys: KeyMeta[] =
          typeof conn.listKeys === 'function' ? await this.deps.cache.getKeys(connId, db, obj, () => conn.listKeys!(db, obj)) : [];
        const indexes: IndexMeta[] =
          typeof conn.listIndexes === 'function'
            ? await this.deps.cache.getIndexes(connId, db, obj, () => conn.listIndexes!(db, obj))
            : [];
        return { columns, keys, indexes };
      })();
      this.baselineCache.set(key, p);
    }
    return p;
  }
}

import type { IConnection } from '@db-explorer/core';

/** 连接的最小形状（IConnection 自省子集；listKeys/listIndexes 可选） */
interface ConnectionLike {
  listObjects(db: string): Promise<ObjectMeta[]>;
  listColumns(db: string, obj: string): Promise<ColumnMeta[]>;
  listKeys?(db: string, obj: string): Promise<KeyMeta[]>;
  listIndexes?(db: string, obj: string): Promise<IndexMeta[]>;
}

interface ConnectionManagerLike {
  ensureConnected(connId: string): Promise<IConnection>;
}
