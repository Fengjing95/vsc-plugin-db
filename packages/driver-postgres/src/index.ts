import pg from 'pg';
import type { PoolClient, QueryResult, QueryResultRow } from 'pg';
// 方言词表（M8 优化全量化：关键字/函数/补全片段，含窗口函数/CTE/UPSERT/JSONB/数组面）
import { COMPLETION_SNIPPETS, DATA_TYPES, FUNCTIONS, KEYWORDS } from './completion';
import {
  DriverError,
  type ApplyResult,
  type ChangeSet,
  type ColumnMeta,
  type CompletionSource,
  type ConnectionConfig,
  type DataTypeOption,
  type DatabaseMeta,
  type DdlStatement,
  type DriverCapabilities,
  type DialectInfo,
  type FetchRowsRequest,
  type FormSchema,
  type IConnection,
  type IDatabaseDriver,
  type ISession,
  type IndexMeta,
  type KeyMeta,
  type NormalizedType,
  type ObjectMeta,
  type PreviewItem,
  type QueryRequest,
  type ResultSet,
  type RowKey,
  type TableSpec,
  type TestResult,
} from '@db-explorer/core';
import { buildChangeStatements } from './changes';
import {
  buildCreateSchemaStatements,
  buildCreateTableStatements,
  buildAlterTableStatements,
  buildDropSchemaStatements,
} from './ddl';
import { toDriverError } from './errors';
import {
  bootstrapDatabaseCandidates,
  encodeCell,
  fragmentHasColumn,
  normalizePgType,
  normalizeTimeText,
  normalizeTimestampText,
  normalizeTimestamptzText,
  oidToNormalizedType,
  quotePgIdentifier,
  buildSelect,
} from './sql';

/**
 * PostgreSQL 驱动（pg / node-postgres，T-11）。
 * M8-PG 交付：连接/测试、元数据自省（D-15 schema 上树）、分页取数、参数化筛选下推、
 * 变更集（短事务 + 字段级乐观锁 + RETURNING 回填）、取消（client.cancel）、
 * DDL 生成器、交互式事务会话。
 * db 参数语义（D-15）：db = schema 名；连接绑定单一真库（表单 database 字段）。
 */
export const POSTGRES_DRIVER_ID = 'postgres';

/** PG 默认 search_path 基线；req.db = 连接真库名时视为「默认」（Console 绑定兜底口径，D-15） */
const DEFAULT_SCHEMA = 'public';

const capabilities: DriverCapabilities = {
  supportsSQL: true,
  supportsTransaction: true,
  supportsInteractiveTransaction: true, // openSession（SessionManager 空闲超时回收，§4.6/D-09）
  supportsMultipleDatabases: false, // PG 连接协议绑定单库，无跨库切换
  supportsMultiStatement: false, // 收紧注入面；Console 按单语句执行（对齐 mysql 口径）
  supportsCancel: true, // signal → client.cancel()，57014 → E_CANCELED（CI postgres service 实跑取消组）
  supportsDdl: true,
  supportsDdlEditor: true, // buildCreateTable/buildAlterTable（DDL 走 query() 执行）
  supportsDatabaseDdl: true, // M8-DBDDL / D-19：「库」= schema（D-15）——buildCreateDatabase/buildDropDatabase
  // 表设计器批次 B（交互稿 §12.2）：键/外键/索引全能力（约束式 UNIQUE/FK；PG 索引方法族）
  tableDesign: {
    uniqueKeys: true,
    foreignKeys: true,
    foreignKeyAlter: true,
    indexes: true,
    indexTypes: ['btree', 'hash', 'gin', 'gist', 'brin'],
  },
  hierarchy: ['connection', 'database', 'folder', 'table', 'view', 'column', 'key', 'index'],
  editable: true,
  pagination: 'offset',
};

const formSchema: FormSchema = {
  fields: [
    { key: 'host', label: '主机', type: 'string', required: true, placeholder: '127.0.0.1' },
    { key: 'port', label: '端口', type: 'number', required: true, default: 5432, validator: 'port' },
    { key: 'username', label: '用户名', type: 'string', required: true },
    { key: 'password', label: '密码', type: 'password' },
    {
      key: 'database',
      label: '默认库',
      type: 'string',
      placeholder: 'postgres',
      hint: 'PG 数据库名（连接级绑定，PG 协议不可跨库切换）；树上展开的「库」为该数据库内的 schema',
      dynamicOptions: 'databases',
    },
    {
      key: 'connectTimeout',
      label: '连接超时（ms）',
      type: 'number',
      default: 10000,
      group: '高级',
      section: '超时与连接池',
    },
    {
      key: 'maxConnections',
      label: '连接池上限',
      type: 'number',
      default: 4,
      group: '高级',
      section: '超时与连接池',
    },
    { key: 'ssl', label: '启用 SSL', type: 'boolean', group: '高级', section: 'SSL/TLS' },
    {
      key: 'sslInsecure',
      label: '跳过证书校验',
      type: 'boolean',
      default: false,
      group: '高级',
      section: 'SSL/TLS',
      toggle: 'ssl',
      hint: '不校验服务器证书（sslmode=require）——存在中间人风险，仅用于开发/自签环境',
    },
  ],
};

// ── 会话级类型解析器（禁用 JS Date 转换防时区漂移，驱动规范 §5.2；不污染全局 pg.types）──────────

const pgQueryTypes = {
  getTypeParser: (oid: number, format?: 'text' | 'binary'): ((v: unknown) => unknown) => {
    const builtin = pg.types.getTypeParser(oid, format);
    if (format === 'text') {
      switch (oid) {
        case 1082: // date → 服务端原文 'YYYY-MM-DD'
          return (v) => (typeof v === 'string' ? v : builtin(v));
        case 1083: // time
        case 1266: // timetz
          return (v) => (typeof v === 'string' ? normalizeTimeText(v) : builtin(v));
        case 1114: // timestamp
          return (v) => (typeof v === 'string' ? normalizeTimestampText(v) : builtin(v));
        case 1184: // timestamptz → 剥偏移保留会话时区墙上时间
          return (v) => (typeof v === 'string' ? normalizeTimestamptzText(v) : builtin(v));
      }
    }
    return builtin;
  },
};

/** 数组列 → string[]：SQL 侧已 ::text 强制 text[]（builtin 解析为数组）；string 形态
 *  （pg 数组字面量）兜底解析——只承载标识符名场景，带引号特殊名由主路径覆盖 */
function toNameArray(v: unknown): string[] {
  if (Array.isArray(v)) {
    return v.map((c) => String(c));
  }
  const s = String(v ?? '').trim();
  if (s.startsWith('{') && s.endsWith('}')) {
    const inner = s.slice(1, -1);
    return inner.length === 0 ? [] : inner.split(',').map((c) => c.replace(/^"(.*)"$/s, '$1').replace(/\\(.)/g, '$1'));
  }
  return [];
}

/** 建连/取数配置（连接与 testConnection 同源，防参数漂移） */
function buildClientConfig(cfg: ConnectionConfig, secret: string): pg.ClientConfig {
  const o = cfg.options;
  return {
    host: String(o.host ?? '127.0.0.1'),
    port: Number(o.port ?? 5432),
    user: String(o.username ?? ''),
    password: secret,
    database: o.database ? String(o.database) : undefined,
    connectionTimeoutMillis: Number(o.connectTimeout ?? 10_000),
    ssl: o.ssl ? { rejectUnauthorized: !o.sslInsecure } : undefined,
    types: pgQueryTypes,
  };
}

export class PostgresConnection implements IConnection {
  readonly connectionId: string;
  private readonly pool: pg.Pool;
  /** 连接真库名（表单 database 字段）：query(req.db) = 真库名时按「默认」处理（D-15） */
  private readonly defaultDatabase: string | undefined;
  private disposed = false;

  /** 方言信息（驱动规范 §3 DialectInfo）：Console SQL 格式化按 formatter 路由 */
  get dialect(): DialectInfo {
    return { id: 'postgresql', quote: ['"', '"'], formatter: 'postgresql', keywords: KEYWORDS };
  }

  constructor(private readonly cfg: ConnectionConfig, private readonly secret: string) {
    this.connectionId = cfg.id;
    this.defaultDatabase = cfg.options.database ? String(cfg.options.database) : undefined;
    this.pool = new pg.Pool(buildClientConfig(cfg, secret));
    // 空闲池连接的异步错误（服务端重启等）：吞掉防止未捕获异常毒化宿主进程（P-30 同族教训）
    this.pool.on('error', () => undefined);
  }

  private assertLive(): void {
    if (this.disposed) {
      throw new DriverError('E_CONN', '连接已关闭');
    }
  }

  private async queryRows(sql: string, params?: unknown[]): Promise<QueryResultRow[]> {
    const res = await this.pool.query(sql, params);
    return res.rows;
  }

  /** SQL 级服务端取消（契约 cancellation 组 CI 超时暴露）：pg 的 Client.cancel 会重置在途连接
   *  本身——池化/会话下毒化该连接（后续查询挂死）。改走 pg_cancel_backend(pid)：专用临时连接
   *  随用随建随关（取消为低频路径）。C-10：连接参数含密钥，仅闭包内使用、永不入日志 */
  private readonly cancelBackend = (pid: number): void => {
    const c = new pg.Client(buildClientConfig(this.cfg, this.secret));
    c.connect()
      .then(() => c.query('SELECT pg_cancel_backend($1)', [pid]))
      .catch(() => undefined)
      .finally(() => {
        c.end().catch(() => undefined);
      });
  };

  async ping(): Promise<void> {
    this.assertLive();
    try {
      await this.pool.query('SELECT 1');
    } catch (err) {
      throw toDriverError(err);
    }
  }

  /** D-15：返回非系统 schema（排除 pg_* 与 information_schema），树 database 层即 schema */
  async listDatabases(): Promise<DatabaseMeta[]> {
    this.assertLive();
    try {
      const rows = await this.queryRows(
        'SELECT n.nspname AS name, pg_catalog.obj_description(n.oid, \'pg_namespace\') AS comment FROM pg_catalog.pg_namespace n WHERE n.nspname <> \'information_schema\' AND n.nspname !~ \'^pg_\' ORDER BY n.nspname',
      );
      return rows.map((r) => ({ name: String(r.name), comment: r.comment ? String(r.comment) : undefined }));
    } catch (err) {
      throw toDriverError(err);
    }
  }

  async listObjects(db: string): Promise<ObjectMeta[]> {
    this.assertLive();
    try {
      const rows = await this.queryRows(
        'SELECT c.relname AS name, c.relkind AS kind, pg_catalog.obj_description(c.oid, \'pg_class\') AS comment, c.reltuples::bigint AS est FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relkind IN (\'r\', \'p\', \'v\', \'m\') ORDER BY c.relname',
        [db],
      );
      return rows.map((r) => {
        const est = Number(r.est);
        return {
          name: String(r.name),
          kind: r.kind === 'v' ? ('view' as const) : r.kind === 'm' ? ('materialized-view' as const) : ('table' as const),
          comment: r.comment ? String(r.comment) : undefined,
          rowEstimate: Number.isFinite(est) && est >= 0 ? est : undefined,
        };
      });
    } catch (err) {
      throw toDriverError(err);
    }
  }

  async listColumns(db: string, obj: string): Promise<ColumnMeta[]> {
    this.assertLive();
    try {
      const rows = await this.queryRows(
        "SELECT a.attname AS name, pg_catalog.format_type(a.atttypid, a.atttypmod) AS dtype, a.attnotnull AS notnull, a.attidentity AS identity, pg_catalog.pg_get_expr(ad.adbin, ad.adrelid) AS defaultexpr, pg_catalog.col_description(a.attrelid, a.attnum) AS comment, a.attnum AS ord, EXISTS (SELECT 1 FROM pg_catalog.pg_index i WHERE i.indrelid = a.attrelid AND i.indisprimary AND a.attnum = ANY (i.indkey)) AS ispk FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid = a.attrelid JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace LEFT JOIN pg_catalog.pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum",
        [db, obj],
      );
      return rows.map((r) => ({
        name: String(r.name),
        dataType: String(r.dtype),
        normalizedType: normalizePgType(String(r.dtype)),
        nullable: !r.notnull,
        isPrimaryKey: r.ispk === true,
        autoIncrement: r.identity === 'a' || r.identity === 'd',
        defaultValue: r.defaultexpr !== undefined && r.defaultexpr !== null ? String(r.defaultexpr) : undefined,
        comment: r.comment ? String(r.comment) : undefined,
        ordinal: Number(r.ord),
      }));
    } catch (err) {
      throw toDriverError(err);
    }
  }

  async listIndexes(db: string, obj: string): Promise<IndexMeta[]> {
    this.assertLive();
    try {
      // 列集：pg_get_indexdef 第二参是 1 起的列号——generate_series(1, indnatts) 直接传 k
      // （曾传 k+1 整体偏移一位：单列索引回 [""]、双列回 [第二列, ""]，树上索引列集恒错——CI 契约实跑抓到）
      const rows = await this.queryRows(
        'SELECT i.relname AS name, ix.indisunique AS uniq, ix.indisprimary AS ispk, am.amname AS itype, ARRAY (SELECT pg_catalog.pg_get_indexdef(ix.indexrelid, k, true) FROM pg_catalog.generate_series(1, ix.indnatts) AS k) AS cols FROM pg_catalog.pg_index ix JOIN pg_catalog.pg_class c ON c.oid = ix.indrelid JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace JOIN pg_catalog.pg_class i ON i.oid = ix.indexrelid JOIN pg_catalog.pg_am am ON am.oid = i.relam WHERE n.nspname = $1 AND c.relname = $2 ORDER BY i.relname',
        [db, obj],
      );
      return rows.map((r) => ({
        name: String(r.name),
        columns: (r.cols as unknown[]).map((c) => String(c)),
        unique: r.uniq === true,
        type: String(r.itype).toUpperCase(),
      }));
    } catch (err) {
      throw toDriverError(err);
    }
  }

  async listKeys(db: string, obj: string): Promise<KeyMeta[]> {
    this.assertLive();
    try {
      const keys: KeyMeta[] = [];
      const cols = await this.listColumns(db, obj);
      const pkCols = cols.filter((c) => c.isPrimaryKey).map((c) => c.name);
      if (pkCols.length > 0) {
        const pkName = await this.queryRows(
          "SELECT con.conname AS name FROM pg_catalog.pg_constraint con JOIN pg_catalog.pg_class c ON c.oid = con.conrelid JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = $2 AND con.contype = 'p'",
          [db, obj],
        );
        keys.push({ name: String(pkName[0]?.name ?? `${obj}_pkey`), kind: 'PK', columns: pkCols });
      }

      // 外键列集：attname 是 name 类型，ARRAY(SELECT …) 产出 name[]（OID 1003，pg builtin 无解析器
      // → 回原始字符串，r.cols.map 崩——CI 契约实跑抓到）；元素 ::text 强制产出 text[]（OID 1009，
      // builtin 解析为数组）。列序用 unnest WITH ORDINALITY 保约束顺序（ANY() 不保序，复合外键列序
      // 是 roundtrip/UI 成对映射的正确性前提）
      const fks = await this.queryRows(
        "SELECT con.conname AS name, ARRAY (SELECT a.attname::text FROM unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord) JOIN pg_catalog.pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum ORDER BY k.ord) AS cols, ft.relname AS reftable, ARRAY (SELECT fa.attname::text FROM unnest(con.confkey) WITH ORDINALITY AS fk(attnum, ord) JOIN pg_catalog.pg_attribute fa ON fa.attrelid = con.confrelid AND fa.attnum = fk.attnum ORDER BY fk.ord) AS refcols FROM pg_catalog.pg_constraint con JOIN pg_catalog.pg_class c ON c.oid = con.conrelid JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace JOIN pg_catalog.pg_class ft ON ft.oid = con.confrelid WHERE n.nspname = $1 AND c.relname = $2 AND con.contype = 'f' ORDER BY con.conname",
        [db, obj],
      );
      for (const r of fks) {
        keys.push({
          name: String(r.name),
          kind: 'FK',
          columns: toNameArray(r.cols),
          refTable: String(r.reftable),
          refColumns: toNameArray(r.refcols),
        });
      }

      const pkName = keys.find((k) => k.kind === 'PK')?.name;
      const uniques = (await this.listIndexes(db, obj)).filter(
        (i) => i.unique && i.name !== pkName,
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
    this.assertLive();
    try {
      const cols = await this.listColumns(req.db, req.obj);
      const typeByName = new Map(cols.map((c) => [c.name, c.normalizedType]));
      // 翻页稳定性契约（P-10）：主键升序兜底；用户 ORDER BY 片段优先（追加在其后，P-10 v0.1.3 口径）
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
        // search 走 LIKE：限定 string/uuid 列（PG 的 bytea/jsonb/数组无 LIKE 运算符）
        searchColumns: cols
          .filter((c) => c.normalizedType === 'string' || c.normalizedType === 'uuid')
          .map((c) => c.name),
        limit: req.limit,
        offset: req.offset,
        encodeParam: (col, v) => toNativeParam(col, v, typeByName),
      });

      const started = Date.now();
      const result = await this.withClient((client) =>
        runCancelableOn(client, built.sql, built.params, {
          timeoutMs: req.timeoutMs,
          signal: req.signal,
          cancelBackend: this.cancelBackend,
        }),
      );
      const single = Array.isArray(result) ? result[0] : result;
      const outCols =
        req.columns && req.columns.length > 0
          ? cols.filter((c) => req.columns?.includes(c.name))
          : cols;
      const data = single.rows.map((r) => outCols.map((c) => encodeCell(r[c.name], c.normalizedType)));

      return {
        columns: outCols.map((c) => ({ name: c.name, type: c.normalizedType })),
        rows: data,
        rowCount: data.length,
        totalCount: undefined, // 默认不做全表 COUNT（概要设计 5.4.4）
        primaryKey: pkCols,
        executionMs: Date.now() - started,
      };
    } catch (err) {
      throw toDriverError(err);
    }
  }

  async query(req: QueryRequest): Promise<ResultSet[]> {
    this.assertLive();
    const started = Date.now();
    try {
      const results = await this.withClient(async (client) => {
        // req.db = 连接真库名（Console 默认绑定兜底）或缺省 → 池默认 search_path；
        // req.db = schema（D-15）→ 专用连接 SET search_path 后执行、用毕 RESET（P-36 同族防池污染）
        if (req.db && req.db !== DEFAULT_SCHEMA && req.db !== this.defaultDatabase) {
          await client.query(`SET search_path TO ${quotePgIdentifier(req.db)}`);
          try {
            return await runCancelableOn(client, req.sql, req.params, {
              timeoutMs: req.timeoutMs,
              signal: req.signal,
              cancelBackend: this.cancelBackend,
            });
          } finally {
            await client.query('RESET search_path').catch(() => undefined);
          }
        }
        return await runCancelableOn(client, req.sql, req.params, {
          timeoutMs: req.timeoutMs,
          signal: req.signal,
          cancelBackend: this.cancelBackend,
        });
      });
      const executionMs = Date.now() - started;
      return mapQueryResults(results, req.maxRows, executionMs);
    } catch (err) {
      throw toDriverError(err);
    }
  }

  previewChanges(db: string, obj: string, cs: ChangeSet): Promise<PreviewItem[]> {
    return this.listColumns(db, obj).then((cols) =>
      buildChangeStatements(db, obj, cs, {
        pkColumns: cols.filter((c) => c.isPrimaryKey).map((c) => c.name),
      }),
    );
  }

  /** 短事务提交（驱动规范 §8）：单连接 BEGIN…COMMIT/ROLLBACK，任一 rowCount ≠ 1 → E_CONFLICT 回滚 */
  async applyChanges(db: string, obj: string, cs: ChangeSet): Promise<ApplyResult> {
    this.assertLive();
    const started = Date.now();
    try {
      const cols = await this.listColumns(db, obj);
      const pkCols = cols.filter((c) => c.isPrimaryKey).map((c) => c.name);
      const typeByName = new Map(cols.map((c) => [c.name, c.normalizedType]));
      const statements = buildChangeStatements(db, obj, cs, {
        pkColumns: pkCols,
        encodeParam: (col, v) => toNativeParam(col, v, typeByName),
      });
      if (statements.length === 0) {
        return { items: [], executionMs: 0 };
      }
      return await this.withClient(async (client) => {
        await client.query('BEGIN');
        try {
          const items: ApplyResult['items'] = [];
          for (const stmt of statements) {
            const res = await client.query(stmt.sql, stmt.params);
            const affectedRows = res.rowCount ?? 0;
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
                  ? this.backfillInsertKey(pkCols, res, typeByName, cs, stmt.tempId)
                  : stmt.rowKey,
              sql: stmt.sql,
              affectedRows,
            });
          }
          await client.query('COMMIT');
          return { items, executionMs: Date.now() - started };
        } catch (err) {
          // 失败必须回滚后归还：PG 连接带 aborted 事务回池会毒化后续查询
          // （25P02 current transaction is aborted 连坐，契约 changeset 组 CI 首跑暴露）
          await client.query('ROLLBACK').catch(() => undefined);
          throw err;
        }
      });
    } catch (err) {
      throw DriverError.is(err) ? err : toDriverError(err);
    }
  }

  /** insert 主键回填（§8-3）：RETURNING 主键列原值，经值编码契约整形（int8 安全转数值） */
  private backfillInsertKey(
    pkCols: string[],
    res: QueryResult,
    typeByName: Map<string, NormalizedType>,
    cs: ChangeSet,
    tempId: string | undefined,
  ): RowKey | undefined {
    if (pkCols.length === 0) {
      return undefined;
    }
    const row = res.rows[0];
    const provided = cs.inserts.find((i) => i.tempId === tempId)?.values;
    const rowKey: RowKey = {};
    for (const pk of pkCols) {
      const value = row && row[pk] !== undefined && row[pk] !== null ? row[pk] : provided?.[pk];
      if (value === undefined || value === null) {
        continue;
      }
      rowKey[pk] = encodeCell(value, typeByName.get(pk) ?? 'unknown');
    }
    return Object.keys(rowKey).length > 0 ? rowKey : undefined;
  }

  listDataTypes(): DataTypeOption[] {
    return DATA_TYPES;
  }

  async getCompletionSource(db?: string): Promise<CompletionSource> {
    const base: CompletionSource = {
      keywords: KEYWORDS,
      functions: FUNCTIONS,
      snippets: COMPLETION_SNIPPETS,
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
    return quotePgIdentifier(name);
  }

  /** DDL 查看：视图走 pg_get_viewdef；表按列/键拼装（M2 元数据组要求非空） */
  async getDdl(db: string, obj: string): Promise<string> {
    this.assertLive();
    try {
      const qualified = `${quotePgIdentifier(db)}.${quotePgIdentifier(obj)}`;
      const rel = await this.queryRows(
        'SELECT c.relkind AS kind FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = $2',
        [db, obj],
      );
      const kind = rel[0]?.kind;
      if (kind === 'v' || kind === 'm') {
        const def = await this.queryRows(
          `SELECT pg_catalog.pg_get_viewdef(${qualified}::regclass, true) AS def`,
        );
        const body = def[0]?.def ? String(def[0].def).trim() : '';
        return `${kind === 'm' ? 'CREATE MATERIALIZED VIEW' : 'CREATE OR REPLACE VIEW'} ${qualified} AS\n${body}`;
      }
      const cols = await this.listColumns(db, obj);
      const keys = await this.listKeys(db, obj);
      const lines = cols.map((c) =>
        [
          `  ${quotePgIdentifier(c.name)}`,
          c.dataType,
          c.autoIncrement ? 'GENERATED BY DEFAULT AS IDENTITY' : undefined,
          c.nullable ? undefined : 'NOT NULL',
          c.defaultValue ? `DEFAULT ${c.defaultValue}` : undefined,
        ]
          .filter(Boolean)
          .join(' '),
      );
      for (const k of keys) {
        if (k.kind === 'PK') {
          lines.push(`  PRIMARY KEY (${k.columns.map(quotePgIdentifier).join(', ')})`);
        } else if (k.kind === 'FK') {
          lines.push(
            `  FOREIGN KEY (${k.columns.map(quotePgIdentifier).join(', ')}) REFERENCES ${quotePgIdentifier(k.refTable ?? '')} (${(k.refColumns ?? []).map(quotePgIdentifier).join(', ')})`,
          );
        }
      }
      const commentLines = cols
        .filter((c) => c.comment)
        .map((c) => `COMMENT ON COLUMN ${qualified}.${quotePgIdentifier(c.name)} IS '${c.comment!.replace(/'/g, "''")}';`);
      return [
        `CREATE TABLE ${qualified} (\n${lines.join(',\n')}\n);`,
        ...commentLines,
      ].join('\n');
    } catch (err) {
      throw toDriverError(err);
    }
  }

  // ── 表结构编辑（M8-B2，概要 §5.9）：语句生成（执行走 query()，Host 同源调用）──

  buildCreateTable(db: string, spec: TableSpec): Promise<DdlStatement[]> {
    return Promise.resolve(buildCreateTableStatements(db, spec));
  }

  buildAlterTable(db: string, obj: string, spec: TableSpec, current: TableSpec): Promise<DdlStatement[]> {
    return Promise.resolve(buildAlterTableStatements(db, obj, spec, current));
  }

  dispose(): void | Promise<void> {
    if (this.disposed) {
      return Promise.resolve();
    }
    this.disposed = true;
    // 活动交互式事务会话随连接 dispose 一起回滚释放（防连接泄漏/悬挂事务）
    return Promise.resolve(this.disposeSession())
      .catch(() => undefined)
      .then(() => this.pool.end().catch(() => undefined));
  }

  // ── 交互式事务会话（M7，概要 §4.6 / D-09）：单连接最多 1 个；空闲超时由 Host 侧 SessionManager 管理 ──

  private sessionClient: PoolClient | null = null;

  /** 回滚并释放活动会话连接（幂等）；RESET search_path 防池污染（P-36 同族） */
  private async disposeSession(): Promise<void> {
    const client = this.sessionClient;
    if (!client) {
      return;
    }
    this.sessionClient = null;
    await client.query('ROLLBACK').catch(() => undefined);
    await client.query('RESET search_path').catch(() => undefined);
    client.release();
  }

  openSession(): Promise<ISession> {
    this.assertLive();
    if (this.sessionClient) {
      return Promise.reject(new DriverError('E_VALIDATION', '已有进行中的事务会话（单连接最多 1 个）'));
    }
    return (async () => {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
      } catch (err) {
        client.release();
        throw toDriverError(err);
      }
      this.sessionClient = client;
      let appliedDb: string | undefined;
      let ended = false;
      const assertLive = (): void => {
        if (ended || this.sessionClient !== client) {
          throw new DriverError('E_CONN', '事务会话已结束');
        }
      };
      const end = async (stmt: 'COMMIT' | 'ROLLBACK'): Promise<void> => {
        assertLive();
        ended = true;
        this.sessionClient = null;
        try {
          await client.query(stmt);
          if (appliedDb !== undefined) {
            await client.query('RESET search_path').catch(() => undefined);
          }
        } finally {
          client.release();
        }
      };
      const session: ISession = {
        execute: async (req) => {
          assertLive();
          if (req.db && req.db !== appliedDb) {
            await client.query(`SET search_path TO ${quotePgIdentifier(req.db)}`);
            appliedDb = req.db;
          }
          const started = Date.now();
          const results = await runCancelableOn(client, req.sql, req.params, {
            timeoutMs: req.timeoutMs,
            signal: req.signal,
            cancelBackend: this.cancelBackend,
          });
          return mapQueryResults(results, req.maxRows, Date.now() - started);
        },
        commit: () => end('COMMIT'),
        rollback: () => end('ROLLBACK'),
        dispose: () => {
          if (!ended) {
            return this.disposeSession(); // 未提交即放弃 → 回滚
          }
          return Promise.resolve();
        },
      };
      return session;
    })();
  }

  private async withClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      return await fn(client);
    } finally {
      // 取消路径的结算等待（2s 有界）：57014 被驱动 settle 链消费、连接回到 ready 态后再归还，
      // 消除 busy 复用与销毁两条泄漏路径（P-46 终态，CI run#11/13 实测口径）
      const settle = (client as { cancelSettle?: Promise<unknown> }).cancelSettle;
      if (settle) {
        (client as { cancelSettle?: Promise<unknown> }).cancelSettle = undefined;
        await Promise.race([settle, new Promise((r) => setTimeout(r, 2_000))]);
      }
      client.release();
    }
  }
}

// ── 语句执行与结果映射（池连接/会话连接共用）────────────────────────────────

/** §5 编辑回传 → 原生参数：binary 列的 base64 字符串转 Buffer（pg 绑定 bytea 必须 Buffer）；其余透传 */
function toNativeParam(column: string, value: unknown, typeByName: Map<string, NormalizedType>): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  if (typeByName.get(column) === 'binary' && typeof value === 'string') {
    return Buffer.from(value, 'base64');
  }
  return value;
}

/** @types/pg 未声明运行时存在的 Client.cancel（pg ≥ 8.5 经独立连接下发取消请求） */
/**
 * 取消/超时语义（驱动规范 §7）：
 * - signal 已中止 → SQL 下发前立即 E_CANCELED（预中止检查点）
 * - 在途：abort → pg_cancel_backend(pid) 尽力取消服务端执行，同时 E_CANCELED 拒绝
 * - deadline（timeoutMs）→ 同上 + E_TIMEOUT
 * settle 后底层查询的后续回包/错误被吞（避免未处理 rejection 毒化进程，P-30 同族）
 */
async function runCancelableOn(
  client: PoolClient,
  sql: string,
  params: unknown[] | undefined,
  opts: { timeoutMs?: number; signal?: AbortSignal; cancelBackend?: (pid: number) => void },
): Promise<QueryResult | QueryResult[]> {
  const pending =
    params && params.length > 0
      ? client.query({ text: sql, values: params })
      : // 无参数走简单协议：多语句返回结果数组（supportsMultiStatement=false 下 core 不下发，防御性兼容）
        client.query(sql);
  const cancelServerSide = (): void => {
    // pg 的 Client.cancel 会重置在途连接本身（池化/会话下毒化该连接，后续查询挂死——契约
    // cancellation 组 CI 超时暴露）→ 改走 SQL 级取消：pg_cancel_backend(pid) 经专用连接；
    // 57014 → E_CANCELED 由错误映射表承载。
    // 取消的竞态面（CI run#11/13 两轮实测）：服务端 57014 回包晚于客户端结算 → 立即归还的
    // 连接被 busy 复用（撞 pg 弃用路径、泄漏 57014 rejection）；直接销毁连接则 pg 内部
    // promise 以 "Connection terminated" 拒绝（同样泄漏）。→ 记录在途查询的结算 promise，
    // withClient 归还前**有界等待**（2s，57014 实际毫秒级到达）——结算后连接回到 ready 态，
    // 57014 已被本函数的 settle 链消费，正常复用无泄漏
    (client as { cancelSettle?: Promise<unknown> }).cancelSettle = pending.catch(() => undefined);
    const pid = (client as { processID?: number }).processID;
    if (pid) {
      opts.cancelBackend?.(pid);
    }
  };

  if (opts.signal?.aborted) {
    throw new DriverError('E_CANCELED', '查询已取消');
  }

  return new Promise<QueryResult | QueryResult[]>((resolve, reject) => {
    let settled = false;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const onAbort = (): void => {
      cancelServerSide();
      settleReject(new DriverError('E_CANCELED', '查询已取消'));
    };
    const settleReject = (err: unknown): void => {
      if (settled) return;
      settled = true;
      if (deadline) clearTimeout(deadline);
      opts.signal?.removeEventListener('abort', onAbort);
      reject(err);
    };
    const settleResolve = (value: QueryResult | QueryResult[]): void => {
      if (settled) return;
      settled = true;
      if (deadline) clearTimeout(deadline);
      opts.signal?.removeEventListener('abort', onAbort);
      resolve(value);
    };

    if (opts.signal) {
      opts.signal.addEventListener('abort', onAbort, { once: true });
    }
    const timeoutMs = opts.timeoutMs ?? 0;
    if (timeoutMs > 0) {
      deadline = setTimeout(() => {
        cancelServerSide();
        settleReject(new DriverError('E_TIMEOUT', '语句执行超时，已请求服务端取消'));
      }, timeoutMs);
    }
    pending.then(
      (rows) => settleResolve(rows),
      (err) => settleReject(err),
    );
  });
}

function mapQueryResults(
  results: QueryResult | QueryResult[],
  maxRows: number,
  executionMs: number,
): ResultSet[] {
  const all = Array.isArray(results) ? results : [results];
  return all.map((res) => mapOneResult(res, maxRows, executionMs));
}

function mapOneResult(res: QueryResult, maxRows: number, executionMs: number): ResultSet {
  const fields = res.fields ?? [];
  const rowsRaw = res.rows ?? [];
  const sample = rowsRaw[0] as Record<string, unknown> | undefined;
  const cols = fields.map((f) => ({
    name: f.name ?? '',
    type: oidToNormalizedType(f.dataTypeID, sample?.[f.name ?? '']),
  }));
  const sliced = rowsRaw.slice(0, maxRows);
  return {
    columns: cols,
    rows: sliced.map((r) => cols.map((c) => encodeCell((r as Record<string, unknown>)[c.name], c.type))),
    rowCount: sliced.length,
    affectedRows: fields.length === 0 ? res.rowCount ?? 0 : undefined,
    executionMs,
    truncated: rowsRaw.length > maxRows,
  };
}

export function createPostgresDriver(): IDatabaseDriver {
  return {
    id: POSTGRES_DRIVER_ID,
    displayName: 'PostgreSQL',
    apiVersion: 1,
    capabilities,
    getConnectionFormSchema: () => formSchema,
    // ── 库级 DDL（M8-DBDDL / D-19）：树上「库」= schema（D-15）——CREATE / DROP SCHEMA（CASCADE 标 destructive）──
    getDatabaseFormSchema: () => ({
      fields: [
        {
          key: 'name',
          label: 'Schema 名',
          type: 'string',
          required: true,
          placeholder: 'appdata',
          hint: '树上的「库」为 PostgreSQL schema（D-15，连接协议绑定单库）；删除 schema 将连带删其下全部表（CASCADE）',
        },
      ],
    }),
    buildCreateDatabase: async (spec) => buildCreateSchemaStatements(spec),
    buildDropDatabase: async (db) => buildDropSchemaStatements(db),
    testConnection: async (cfg: ConnectionConfig, secret: string): Promise<TestResult> => {
      const started = Date.now();
      let client: pg.Client | undefined;
      try {
        client = new pg.Client(buildClientConfig(cfg, secret));
        await client.connect();
        const res = await client.query('SELECT version() AS v');
        const raw = res.rows[0]?.v !== undefined ? String(res.rows[0].v) : '';
        // 'PostgreSQL 16.4 (Debian ...)' → 'PostgreSQL 16.4'
        const version = raw.split(/\s+/).slice(0, 2).join(' ') || undefined;
        return { ok: true, latencyMs: Date.now() - started, serverVersion: version };
      } catch (err) {
        return { ok: false, error: toDriverError(err) };
      } finally {
        await client?.end().catch(() => undefined);
      }
    },
    // 连接表单「默认库」建议（驱动规范 §3 @since v0.1.4）：引导库链逐个尝试，失败 resolve []（无感降级）
    listDatabaseOptions: async (cfg: ConnectionConfig, secret: string): Promise<string[]> => {
      const base = buildClientConfig(cfg, secret);
      // 表单期自动建议：单次建连死线压到 ≤5s，避免不可达主机 × 3 候选的静默长等
      const bootstrapTimeout = Math.min(Number(cfg.options.connectTimeout ?? 10_000), 5_000);
      for (const database of bootstrapDatabaseCandidates(cfg.options)) {
        const client = new pg.Client({ ...base, database, connectionTimeoutMillis: bootstrapTimeout });
        try {
          await client.connect();
          try {
            const res = await client.query(
              'SELECT datname FROM pg_catalog.pg_database WHERE datallowconn AND NOT datistemplate ORDER BY datname',
            );
            return res.rows.map((r) => String(r.datname));
          } finally {
            await client.end().catch(() => undefined);
          }
        } catch {
          // 该引导库不可用（不可达/改名/无权限）：尝试下一个候选；全部失败返回 []（契约：禁止 reject）
        }
      }
      return [];
    },
    connect: (cfg: ConnectionConfig, secret: string) => Promise.resolve(new PostgresConnection(cfg, secret)),
  };
}
