import { createPool, type Pool, type PoolConnection } from 'mysql2/promise';
import {
  DriverError,
  type ApplyResult,
  type ChangeSet,
  type ColumnMeta,
  type CompletionSource,
  type ConnectionConfig,
  type DatabaseMeta,
  type DriverCapabilities,
  type FetchRowsRequest,
  type FormSchema,
  type IConnection,
  type IDatabaseDriver,
  type IndexMeta,
  type KeyMeta,
  type NormalizedType,
  type ObjectMeta,
  type PreviewItem,
  type QueryRequest,
  type ResultSet,
  type RowKey,
  type TestResult,
} from '@db-explorer/core';
import { buildChangeStatements } from './changes';
import { buildSelect, encodeValue, fragmentHasColumn, normalizeMysqlType, quoteMysqlIdentifier, toDriverError } from './sql';

/**
 * MySQL 驱动（mysql2/promise）。
 * M1 交付范围：连接/测试、元数据自省、分页取数、只读查询。
 * M4 交付范围：previewChanges/applyChanges（短事务 + 字段级乐观锁，驱动规范 §8）。
 */
export const MYSQL_DRIVER_ID = 'mysql';

const capabilities: DriverCapabilities = {
  supportsSQL: true,
  supportsTransaction: true,
  supportsInteractiveTransaction: false, // P2：openSession
  supportsMultipleDatabases: true,
  supportsMultiStatement: false, // 收紧注入面；Console 按单语句执行
  supportsCancel: false, // mysql2 无法可靠中止已下发语句，契约如实声明
  supportsDdl: true,
  hierarchy: ['connection', 'database', 'folder', 'table', 'view', 'column', 'key', 'index'],
  editable: true,
  pagination: 'offset',
};

const formSchema: FormSchema = {
  fields: [
    { key: 'host', label: '主机', type: 'string', required: true, placeholder: '127.0.0.1' },
    { key: 'port', label: '端口', type: 'number', required: true, default: 3306, validator: 'port' },
    { key: 'username', label: '用户名', type: 'string', required: true },
    { key: 'password', label: '密码', type: 'password' },
    { key: 'database', label: '默认库', type: 'string' },
    {
      key: 'connectTimeout',
      label: '连接超时（ms）',
      type: 'number',
      default: 10000,
      group: '高级',
    },
    { key: 'connectionLimit', label: '连接池上限', type: 'number', default: 4, group: '高级' },
    { key: 'ssl', label: '启用 SSL', type: 'boolean', group: '高级' },
  ],
};

const KEYWORDS = [
  'SELECT', 'FROM', 'WHERE', 'ORDER BY', 'GROUP BY', 'HAVING', 'LIMIT', 'OFFSET',
  'JOIN', 'LEFT JOIN', 'INNER JOIN', 'ON', 'INSERT INTO', 'VALUES', 'UPDATE', 'SET',
  'DELETE FROM', 'CREATE TABLE', 'ALTER TABLE', 'DROP TABLE', 'AND', 'OR', 'NOT',
  'NULL', 'IS NULL', 'LIKE', 'IN', 'BETWEEN', 'DISTINCT', 'AS', 'ASC', 'DESC',
];

const FUNCTIONS = [
  'COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'NOW', 'DATE_FORMAT', 'COALESCE',
  'IFNULL', 'CONCAT', 'SUBSTRING', 'JSON_EXTRACT', 'GROUP_CONCAT',
];

interface RawColumnRow {
  name: string;
  ctype: string;
  dtype: string;
  nullable: string;
  ckey: string;
  extra: string;
  comment: string;
  ord: number;
}

export class MysqlConnection implements IConnection {
  readonly connectionId: string;
  private readonly pool: Pool;

  constructor(private readonly cfg: ConnectionConfig, secret: string) {
    const o = cfg.options;
    this.connectionId = cfg.id;
    this.pool = createPool({
      host: String(o.host ?? '127.0.0.1'),
      port: Number(o.port ?? 3306),
      user: String(o.username ?? ''),
      password: secret,
      database: o.database ? String(o.database) : undefined,
      connectionLimit: Number(o.connectionLimit ?? 4),
      connectTimeout: Number(o.connectTimeout ?? 10_000),
      ssl: o.ssl ? { rejectUnauthorized: true } : undefined,
      // 值编码契约（驱动开发规范 §5）：
      // dateStrings → DATE/TIME/DATETIME 原样字符串；bigNumberStrings → BIGINT 不丢精度；
      // DECIMAL 默认即为字符串（decimalNumbers: false）
      dateStrings: true,
      supportBigNumbers: true,
      bigNumberStrings: true,
    });
  }

  private async queryRows(sql: string, params?: unknown[]): Promise<Record<string, unknown>[]> {
    const [rows] = await this.pool.query(sql, params);
    return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
  }

  async ping(): Promise<void> {
    try {
      await this.pool.query('SELECT 1');
    } catch (err) {
      throw toDriverError(err);
    }
  }

  async listDatabases(): Promise<DatabaseMeta[]> {
    try {
      const rows = await this.queryRows(
        'SELECT SCHEMA_NAME AS name, DEFAULT_CHARACTER_SET_NAME AS charset FROM information_schema.SCHEMATA ORDER BY SCHEMA_NAME',
      );
      return rows.map((r) => ({ name: String(r.name), charset: r.charset ? String(r.charset) : undefined }));
    } catch (err) {
      throw toDriverError(err);
    }
  }

  async listObjects(db: string): Promise<ObjectMeta[]> {
    try {
      const rows = await this.queryRows(
        'SELECT TABLE_NAME AS name, TABLE_TYPE AS kind, TABLE_COMMENT AS comment, TABLE_ROWS AS est FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME',
        [db],
      );
      return rows.map((r) => ({
        name: String(r.name),
        kind: r.kind === 'VIEW' ? ('view' as const) : ('table' as const),
        comment: commentOrUndefined(r.comment),
        rowEstimate: r.est !== null ? Number(r.est) : undefined,
      }));
    } catch (err) {
      throw toDriverError(err);
    }
  }

  async listColumns(db: string, obj: string): Promise<ColumnMeta[]> {
    try {
      const rows = await this.queryRows(
        'SELECT COLUMN_NAME AS name, COLUMN_TYPE AS ctype, DATA_TYPE AS dtype, IS_NULLABLE AS nullable, COLUMN_KEY AS ckey, EXTRA AS extra, COLUMN_COMMENT AS comment, ORDINAL_POSITION AS ord FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION',
        [db, obj],
      );
      return (rows as unknown as RawColumnRow[]).map((r) => ({
        name: r.name,
        dataType: r.ctype,
        normalizedType: normalizeMysqlType(r.dtype),
        nullable: r.nullable === 'YES',
        isPrimaryKey: r.ckey === 'PRI',
        autoIncrement: r.extra.includes('auto_increment'),
        comment: r.comment || undefined,
        ordinal: Number(r.ord),
      }));
    } catch (err) {
      throw toDriverError(err);
    }
  }

  async listIndexes(db: string, obj: string): Promise<IndexMeta[]> {
    try {
      const rows = await this.queryRows(
        'SELECT INDEX_NAME AS name, NON_UNIQUE AS nu, INDEX_TYPE AS itype, COLUMN_NAME AS col FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY INDEX_NAME, SEQ_IN_INDEX',
        [db, obj],
      );
      const grouped = new Map<string, IndexMeta>();
      for (const r of rows) {
        const name = String(r.name);
        const idx = grouped.get(name) ?? {
          name,
          columns: [],
          unique: Number(r.nu) === 0,
          type: r.itype ? String(r.itype) : undefined,
        };
        idx.columns.push(String(r.col));
        grouped.set(name, idx);
      }
      return [...grouped.values()];
    } catch (err) {
      throw toDriverError(err);
    }
  }

  async listKeys(db: string, obj: string): Promise<KeyMeta[]> {
    try {
      const keys: KeyMeta[] = [];
      const cols = await this.listColumns(db, obj);
      const pk = cols.filter((c) => c.isPrimaryKey).map((c) => c.name);
      if (pk.length > 0) {
        keys.push({ name: 'PRIMARY', kind: 'PK', columns: pk });
      }

      const fks = await this.queryRows(
        'SELECT CONSTRAINT_NAME AS name, COLUMN_NAME AS col, REFERENCED_TABLE_NAME AS refTable, REFERENCED_COLUMN_NAME AS refCol FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND REFERENCED_TABLE_NAME IS NOT NULL ORDER BY CONSTRAINT_NAME, ORDINAL_POSITION',
        [db, obj],
      );
      for (const r of fks) {
        keys.push({
          name: String(r.name),
          kind: 'FK',
          columns: [String(r.col)],
          refTable: String(r.refTable),
          refColumns: [String(r.refCol)],
        });
      }

      const uniques = (await this.listIndexes(db, obj)).filter(
        (i) => i.unique && i.name !== 'PRIMARY',
      );
      for (const u of uniques) {
        keys.push({ name: u.name, kind: 'UNIQUE', columns: u.columns });
      }
      return keys;
    } catch (err) {
      throw toDriverError(err);
    }
  }

  async fetchRows(req: FetchRowsRequest): Promise<ResultSet> {
    try {
      const cols = await this.listColumns(req.db, req.obj);
      // 翻页稳定性契约（概要设计 §12.2-3 / P-10）：主键升序作为兜底排序。
      // v0.1.3 起用户 ORDER BY 片段优先——兜底主键改为追加在其后（片段未含主键时），
      // 避免默认前置主键使唯一主键下的手写排序失效
      const pkCols = cols.filter((c) => c.isPrimaryKey).map((c) => c.name);
      const userOrder = req.orderBySql?.trim() ?? '';
      const tailSorts: Array<{ column: string; dir: 'asc' | 'desc' }> = [];
      if (userOrder) {
        if (!pkCols.some((pk) => fragmentHasColumn(userOrder, pk))) {
          tailSorts.push(...pkCols.map((c) => ({ column: c, dir: 'asc' as const })));
        }
      } else if (!req.sorts?.length) {
        tailSorts.push(...pkCols.map((c) => ({ column: c, dir: 'asc' as const })));
      }
      const built = buildSelect({
        db: req.db,
        obj: req.obj,
        columns: req.columns,
        filters: req.filters,
        sorts: req.sorts,
        search: req.search,
        whereSql: req.whereSql,
        orderBySql: req.orderBySql,
        tailSorts,
        searchColumns: cols.map((c) => c.name),
        limit: req.limit,
        offset: req.offset,
      });

      const started = Date.now();
      const rows = await this.queryRows(built.sql, built.params);
      const outCols =
        req.columns && req.columns.length > 0
          ? cols.filter((c) => req.columns?.includes(c.name))
          : cols;
      const data = rows.map((r) => outCols.map((c) => encodeValue(r[c.name])));

      return {
        columns: outCols.map((c) => ({ name: c.name, type: c.normalizedType })),
        rows: data,
        rowCount: data.length,
        totalCount: undefined, // 默认不做全表 COUNT（概要设计 5.4.4）
        primaryKey: cols.filter((c) => c.isPrimaryKey).map((c) => c.name),
        executionMs: Date.now() - started,
      };
    } catch (err) {
      throw toDriverError(err);
    }
  }

  async query(req: QueryRequest): Promise<ResultSet[]> {
    try {
      const started = Date.now();
      const [rows, fields] = await this.pool.query({ sql: req.sql, values: req.params ?? [] });
      const executionMs = Date.now() - started;

      if (Array.isArray(rows)) {
        const all = rows as Record<string, unknown>[];
        const sliced = all.slice(0, req.maxRows);
        const rawFields = (fields ?? []) as RawField[];
        const cols = rawFields.map((f) => ({
          name: f.name ?? '',
          type: guessType(f.type, all[0]?.[f.name ?? '']),
        }));
        return [
          {
            columns: cols,
            rows: sliced.map((r) => cols.map((c) => encodeValue(r[c.name]))),
            rowCount: sliced.length,
            executionMs,
            truncated: all.length > req.maxRows,
          },
        ];
      }

      const ok = rows as { affectedRows?: number; insertId?: number; message?: string };
      return [
        {
          columns: [],
          rows: [],
          rowCount: 0,
          affectedRows: ok.affectedRows ?? 0,
          messages: ok.message ? [ok.message] : undefined,
          executionMs,
          truncated: false,
        },
      ];
    } catch (err) {
      throw toDriverError(err);
    }
  }

  previewChanges(db: string, obj: string, cs: ChangeSet): Promise<PreviewItem[]> {
    return Promise.resolve(buildChangeStatements(db, obj, cs));
  }

  /** 短事务提交（驱动规范 §8）：单连接 BEGIN…COMMIT/ROLLBACK，任一 affectedRows ≠ 1 → E_CONFLICT 回滚，禁止半提交 */
  async applyChanges(db: string, obj: string, cs: ChangeSet): Promise<ApplyResult> {
    const started = Date.now();
    const statements = buildChangeStatements(db, obj, cs);
    if (statements.length === 0) {
      return { items: [], executionMs: 0 };
    }
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      const pkCols = (await this.listColumns(db, obj))
        .filter((c) => c.isPrimaryKey)
        .map((c) => c.name);
      const items: ApplyResult['items'] = [];
      for (const stmt of statements) {
        const [res] = await conn.query(stmt.sql, stmt.params);
        const affectedRows = (res as { affectedRows?: number }).affectedRows ?? 0;
        if (affectedRows !== 1) {
          throw new DriverError('E_CONFLICT', '数据已被他人修改，本次提交已回滚', {
            meta: { kind: stmt.kind, tempId: stmt.tempId, rowKey: stmt.rowKey },
          });
        }
        items.push({
          kind: stmt.kind,
          tempId: stmt.tempId,
          rowKey:
            stmt.kind === 'insert'
              ? await this.backfillInsertKey(
                  pkCols,
                  stmt.tempId ? cs.inserts.find((i) => i.tempId === stmt.tempId) : undefined,
                  conn,
                )
              : stmt.rowKey,
          sql: stmt.sql,
          affectedRows,
        });
      }
      await conn.commit();
      return { items, executionMs: Date.now() - started };
    } catch (err) {
      await conn.rollback().catch(() => undefined);
      throw DriverError.is(err) ? err : toDriverError(err);
    } finally {
      conn.release();
    }
  }

  /** insert 主键回填（规范 §8-3）：值里带了主键用原值，缺省的自增主键经 LAST_INSERT_ID() 取回 */
  private async backfillInsertKey(
    pkCols: string[],
    insert: ChangeSet['inserts'][number] | undefined,
    conn: PoolConnection,
  ): Promise<RowKey | undefined> {
    if (pkCols.length === 0) {
      return undefined;
    }
    const rowKey: RowKey = {};
    let missing: string | undefined;
    for (const pk of pkCols) {
      const provided = insert?.values[pk];
      if (provided !== undefined && provided !== null) {
        rowKey[pk] = provided;
      } else {
        missing = pk;
      }
    }
    if (missing !== undefined) {
      const rows = await conn.query('SELECT LAST_INSERT_ID() AS lid');
      const lid = (rows[0] as Array<Record<string, unknown>>)[0]?.lid;
      if (lid === undefined || lid === null) {
        return Object.keys(rowKey).length > 0 ? rowKey : undefined;
      }
      rowKey[missing] = Number(lid);
    }
    return rowKey;
  }

  async getCompletionSource(db?: string): Promise<CompletionSource> {
    const base: CompletionSource = {
      keywords: KEYWORDS,
      functions: FUNCTIONS,
      databases: (await this.listDatabases()).map((d) => d.name),
      tables: [],
      columns: [],
    };
    if (!db) {
      return base;
    }
    const objs = await this.listObjects(db);
    base.tables = objs.map((o) => ({ name: o.name }));
    for (const o of objs.filter((x) => x.kind === 'table').slice(0, 200)) {
      const cols = await this.listColumns(db, o.name);
      base.columns.push(...cols.map((c) => ({ table: o.name, name: c.name })));
    }
    return base;
  }

  quoteIdentifier(name: string): string {
    return quoteMysqlIdentifier(name);
  }

  async getDdl(db: string, obj: string): Promise<string> {
    try {
      const rows = await this.queryRows(
        `SHOW CREATE TABLE ${quoteMysqlIdentifier(db)}.${quoteMysqlIdentifier(obj)}`,
      );
      const first = rows[0] ?? {};
      return String(first['Create Table'] ?? first['Create View'] ?? '');
    } catch (err) {
      throw toDriverError(err);
    }
  }

  dispose(): void | Promise<void> {
    return this.pool.end().catch(() => undefined);
  }
}

function commentOrUndefined(v: unknown): string | undefined {
  const s = v === null || v === undefined ? '' : String(v);
  // MySQL 对视图的空注释以 'VIEW' 占位
  return s && s !== 'VIEW' ? s : undefined;
}

/** console 结果列类型：优先 mysql2 字段类型，退化为按值嗅探（mysql2/promise 不导出 FieldInfo，此处用本地结构） */
interface RawField {
  name?: string;
  type?: string;
}

function guessType(fieldType: string | undefined, sample: unknown): NormalizedType {
  switch (fieldType) {
    case 'LONGLONG':
    case 'LONG':
    case 'SHORT':
    case 'TINY':
    case 'INT24':
      return 'integer';
    case 'NEWDECIMAL':
    case 'DECIMAL':
      return 'decimal';
    case 'FLOAT':
    case 'DOUBLE':
      return 'float';
    case 'DATE':
      return 'date';
    case 'TIME':
      return 'time';
    case 'DATETIME':
    case 'TIMESTAMP':
      return 'datetime';
    case 'JSON':
      return 'json';
    case 'BLOB':
    case 'TINY_BLOB':
    case 'MEDIUM_BLOB':
    case 'LONG_BLOB':
    case 'GEOMETRY':
      return 'binary';
    default: {
      if (typeof sample === 'number') return 'float';
      if (typeof sample === 'boolean') return 'boolean';
      if (sample !== null && typeof sample === 'object') return 'json';
      if (typeof sample === 'string') return 'string';
      return 'unknown';
    }
  }
}

export function createMysqlDriver(): IDatabaseDriver {
  return {
    id: MYSQL_DRIVER_ID,
    displayName: 'MySQL',
    apiVersion: 1,
    capabilities,
    getConnectionFormSchema: () => formSchema,
    testConnection: async (cfg: ConnectionConfig, secret: string): Promise<TestResult> => {
      const o = cfg.options;
      const started = Date.now();
      let conn;
      try {
        const { createConnection } = await import('mysql2/promise');
        conn = await createConnection({
          host: String(o.host ?? '127.0.0.1'),
          port: Number(o.port ?? 3306),
          user: String(o.username ?? ''),
          password: secret,
          database: o.database ? String(o.database) : undefined,
          connectTimeout: Number(o.connectTimeout ?? 10_000),
          ssl: o.ssl ? { rejectUnauthorized: true } : undefined,
          dateStrings: true,
          supportBigNumbers: true,
          bigNumberStrings: true,
        });
        const [rows] = await conn.query('SELECT VERSION() AS v');
        const version =
          Array.isArray(rows) && rows.length > 0
            ? String((rows[0] as Record<string, unknown>).v ?? '')
            : undefined;
        return { ok: true, latencyMs: Date.now() - started, serverVersion: version };
      } catch (err) {
        return { ok: false, error: toDriverError(err) };
      } finally {
        await conn?.end().catch(() => undefined);
      }
    },
    connect: (cfg: ConnectionConfig, secret: string) =>
      Promise.resolve(new MysqlConnection(cfg, secret)),
  };
}
