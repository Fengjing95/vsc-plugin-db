import { createConnection, createPool, type Pool, type PoolConnection } from 'mysql2/promise';
// 方言词表（M8 优化全量化：关键字/函数/补全片段，含窗口函数/CTE/UPSERT/JSON 面）
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
import { appendWhereParts, buildChangeStatements } from './changes';
import {
  buildAlterDatabaseStatements,
  buildAlterTableStatements,
  buildCreateDatabaseStatements,
  buildCreateTableStatements,
  buildDropDatabaseStatements,
} from './ddl';
import { buildSelect, encodeValue, filterMysqlDatabases, fragmentHasColumn, normalizeMysqlType, quoteMysqlIdentifier, stripMysqlColumnDefault, toDriverError } from './sql';

/**
 * MySQL 驱动（mysql2/promise）。
 * M1 交付范围：连接/测试、元数据自省、分页取数、只读查询。
 * M4 交付范围：previewChanges/applyChanges（短事务 + 字段级乐观锁，驱动规范 §8）。
 */
export const MYSQL_DRIVER_ID = 'mysql';

const capabilities: DriverCapabilities = {
  supportsSQL: true,
  supportsTransaction: true,
  supportsInteractiveTransaction: true, // M7：openSession（SessionManager 空闲超时回收，§4.6/D-09）
  supportsMultipleDatabases: true,
  supportsMultiStatement: false, // 收紧注入面；Console 按单语句执行
  supportsCancel: true, // abort/超时 → 专用临时连接 KILL QUERY <threadId>，ER_QUERY_INTERRUPTED(1317) → E_CANCELED（CI mysql service 实跑取消组）
  supportsDdl: true,
  supportsDdlEditor: true, // M8-B2：buildCreateTable/buildAlterTable（DDL 走 query() 执行）
  supportsDatabaseDdl: true, // M8-DBDDL / D-19：buildCreateDatabase/buildAlterDatabase/buildDropDatabase
  supportsErDiagram: true, // M8-ER（概要 §5.11 / D-22）：listKeys FK 元数据完整——ER 关系收集消费者
  lazyCell: true, // ADR D-30：fetchCell 大字段按需拉取（契约组 lazy-cell 实跑）
  // 表设计器批次 B（交互稿 §12.2）：键/外键/索引全能力（InnoDB 外键；索引类型两族）
  tableDesign: {
    uniqueKeys: true,
    foreignKeys: true,
    foreignKeyAlter: true,
    indexes: true,
    indexTypes: ['BTREE', 'HASH'],
    // InnoDB 拒绝 SET DEFAULT（解析器接受、引擎报错）——不进下拉
    refActions: ['RESTRICT', 'CASCADE', 'SET NULL', 'NO ACTION'],
  },
  hierarchy: ['connection', 'database', 'folder', 'table', 'view', 'column', 'key', 'index'],
  editable: true,
  pagination: 'offset',
};

/** FormSchema 文案 = 域键（C-17/D-25 B3）：webview 渲染时经 formText 解析，未登记文本原样展示 */
const formSchema: FormSchema = {
  fields: [
    { key: 'host', label: 'form.host', type: 'string', required: true, placeholder: '127.0.0.1' },
    { key: 'port', label: 'form.port', type: 'number', required: true, default: 3306, validator: 'port' },
    { key: 'username', label: 'form.username', type: 'string', required: true },
    { key: 'password', label: 'form.password', type: 'password' },
    { key: 'database', label: 'form.database', type: 'string', dynamicOptions: 'databases' },
    {
      key: 'connectTimeout',
      label: 'form.connectTimeout',
      type: 'number',
      default: 10000,
      group: 'form.group.advanced',
      section: 'form.section.timeoutPool',
    },
    {
      key: 'connectionLimit',
      label: 'form.poolMax',
      type: 'number',
      default: 4,
      group: 'form.group.advanced',
      section: 'form.section.timeoutPool',
    },
    { key: 'ssl', label: 'form.ssl.enable', type: 'boolean', group: 'form.group.advanced', section: 'form.section.ssl' },
  ],
};

interface RawColumnRow {
  name: string;
  ctype: string;
  dtype: string;
  nullable: string;
  ckey: string;
  extra: string;
  comment: string;
  dflt: string | null;
  ord: number;
}

export class MysqlConnection implements IConnection {
  readonly connectionId: string;
  private readonly pool: Pool;

  /** 方言信息（驱动规范 §3 DialectInfo）：Console SQL 格式化按 formatter 路由（M7） */
  get dialect(): DialectInfo {
    return { id: 'mysql', quote: ['`', '`'], formatter: 'mysql', keywords: KEYWORDS };
  }

  /** 连接默认库（池建立时的 database）：Console 绑定库 ≠ 默认库时按 req.db 切库执行 */
  private readonly defaultDb: string | undefined;

  constructor(private readonly cfg: ConnectionConfig, private readonly secret: string) {
    const o = cfg.options;
    this.connectionId = cfg.id;
    this.defaultDb = o.database ? String(o.database) : undefined;
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
        'SELECT SCHEMA_NAME AS name, DEFAULT_CHARACTER_SET_NAME AS charset, DEFAULT_COLLATION_NAME AS collation FROM information_schema.SCHEMATA ORDER BY SCHEMA_NAME',
      );
      const metas = rows.map((r) => ({
        name: String(r.name),
        charset: r.charset ? String(r.charset) : undefined,
        collation: r.collation ? String(r.collation) : undefined,
      }));
      // 系统库硬过滤（D-15 在 PG 上立的同口径）：information_schema/mysql/performance_schema/sys
      // 不上树、不入契约样例发现（firstTable 按库序取样，不过滤会落在 information_schema 上）
      const allowed = new Set(filterMysqlDatabases(metas.map((m) => m.name)));
      return metas.filter((m) => allowed.has(m.name));
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
        'SELECT COLUMN_NAME AS name, COLUMN_TYPE AS ctype, DATA_TYPE AS dtype, IS_NULLABLE AS nullable, COLUMN_KEY AS ckey, EXTRA AS extra, COLUMN_COMMENT AS comment, COLUMN_DEFAULT AS dflt, ORDINAL_POSITION AS ord FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION',
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
        defaultValue: stripMysqlColumnDefault(r.dflt),
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

      // 动作列（@since v0.9.0 / D-28）：REFERENTIAL_CONSTRAINTS 按（schema, 约束名）关联取
      // DELETE_RULE / UPDATE_RULE——引擎原文直显（'NO ACTION' 默认形态如实返回，不归一化）
      const fks = await this.queryRows(
        'SELECT kcu.CONSTRAINT_NAME AS name, kcu.COLUMN_NAME AS col, kcu.REFERENCED_TABLE_NAME AS refTable, kcu.REFERENCED_COLUMN_NAME AS refCol, rc.DELETE_RULE AS deleteRule, rc.UPDATE_RULE AS updateRule FROM information_schema.KEY_COLUMN_USAGE kcu LEFT JOIN information_schema.REFERENTIAL_CONSTRAINTS rc ON rc.CONSTRAINT_SCHEMA = kcu.CONSTRAINT_SCHEMA AND rc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME WHERE kcu.TABLE_SCHEMA = ? AND kcu.TABLE_NAME = ? AND kcu.REFERENCED_TABLE_NAME IS NOT NULL ORDER BY kcu.CONSTRAINT_NAME, kcu.ORDINAL_POSITION',
        [db, obj],
      );
      for (const r of fks) {
        keys.push({
          name: String(r.name),
          kind: 'FK',
          columns: [String(r.col)],
          refTable: String(r.refTable),
          refColumns: [String(r.refCol)],
          onDelete: r.deleteRule === null || r.deleteRule === undefined ? undefined : String(r.deleteRule),
          onUpdate: r.updateRule === null || r.updateRule === undefined ? undefined : String(r.updateRule),
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

  /** ADR D-30：大字段按需拉取（capabilities.lazyCell）。单列 SELECT 参数化下推，
   *  WHERE 与变更语句同源（appendWhereParts：RowKey 键值 + IS NULL 语义）；
   *  返回 C-7 整值；未知列 → E_VALIDATION，RowKey 无命中 → E_NOT_FOUND */
  async fetchCell(db: string, obj: string, rowKey: RowKey, column: string): Promise<unknown> {
    try {
      const cols = await this.listColumns(db, obj);
      if (!cols.some((c) => c.name === column)) {
        throw new DriverError('E_VALIDATION', `列不存在: ${column}`);
      }
      const known = new Set(cols.map((c) => c.name));
      for (const key of Object.keys(rowKey)) {
        if (!known.has(key)) {
          throw new DriverError('E_VALIDATION', `列不存在: ${key}`);
        }
      }
      const where: string[] = [];
      const params: unknown[] = [];
      appendWhereParts(where, params, rowKey);
      if (where.length === 0) {
        throw new DriverError('E_VALIDATION', '缺少行定位条件（RowKey 为空）');
      }
      const table = `${quoteMysqlIdentifier(db)}.${quoteMysqlIdentifier(obj)}`;
      const rows = await this.queryRows(
        `SELECT ${quoteMysqlIdentifier(column)} FROM ${table} WHERE ${where.join(' AND ')}`,
        params,
      );
      if (rows.length === 0) {
        // 不带 meta（rowKey 承载行数据值，C-10 不入日志/错误）
        throw new DriverError('E_NOT_FOUND', '行不存在或已被删除');
      }
      return encodeValue(rows[0][column]);
    } catch (err) {
      throw DriverError.is(err) ? err : toDriverError(err);
    }
  }

  async query(req: QueryRequest): Promise<ResultSet[]> {
    // 预中止检查点（驱动规范 §7）：signal 已中止 → 不碰池直接拒绝
    if (req.signal?.aborted) {
      throw new DriverError('E_CANCELED', '查询已取消');
    }
    // Console 绑定库（QueryRequest.db，规范 §4）≠ 连接默认库 → 池内专用连接 USE 后执行；
    // 相同（或未绑定）走池直查。取消/超时需要连接级 threadId（KILL QUERY 定位在途语句），
    // 统一走 getConnection 持有专用连接执行——原快路径 pool.query 语义等价，仅多一次显式租借
    const conn = await this.pool.getConnection();
    try {
      if (req.db && req.db !== this.defaultDb) {
        await conn.query(`USE ${quoteMysqlIdentifier(req.db)}`);
      }
      return await runQueryOn(conn, req, {
        threadId: poolConnectionThreadId(conn),
        cancelServer: this.killQuery,
      });
    } finally {
      await releaseAfterSettle(conn);
    }
  }

  /** SQL 级服务端取消（pg cancelBackend 同构）：专用临时连接下发 `KILL QUERY <threadId>`——只杀
   *  语句不断连接（KILL CONNECTION 会断开在途连接本身，违反「取消后连接可复用」契约前提）。取消为
   *  低频路径，连接随用随建随关；查询可能已自然结束（ER_NO_SUCH_THREAD）或缺 KILL 权限 → 尽力吞错。
   *  C-10：连接参数含密钥，仅闭包内使用、永不入日志 */
  private readonly killQuery = (threadId: number): void => {
    const o = this.cfg.options;
    createConnection({
      host: String(o.host ?? '127.0.0.1'),
      port: Number(o.port ?? 3306),
      user: String(o.username ?? ''),
      password: this.secret,
      connectTimeout: Number(o.connectTimeout ?? 10_000),
      ssl: o.ssl ? { rejectUnauthorized: true } : undefined,
    })
      .then(async (c) => {
        try {
          await c.query(`KILL QUERY ${Number(threadId)}`);
        } catch {
          // 尽力取消：threadId 可能已退出（ER_NO_SUCH_THREAD）
        }
        await c.end().catch(() => undefined);
      })
      .catch(() => undefined);
  };

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

  // ── 表结构编辑（M8-B2，概要 §5.9）：语句生成（执行走 query()，Host 同源调用）──

  buildCreateTable(db: string, spec: TableSpec): Promise<DdlStatement[]> {
    return Promise.resolve(buildCreateTableStatements(db, spec));
  }

  buildAlterTable(db: string, obj: string, spec: TableSpec, current: TableSpec): Promise<DdlStatement[]> {
    return Promise.resolve(buildAlterTableStatements(db, obj, spec, current));
  }

  dispose(): void | Promise<void> {
    // 活动交互式事务会话随连接 dispose 一起回滚释放（防连接泄漏/悬挂事务）
    return Promise.resolve(this.disposeSession())
      .catch(() => undefined)
      .then(() => this.pool.end().catch(() => undefined));
  }

  // ── 交互式事务会话（M7，概要 §4.6 / D-09）：单连接最多 1 个；空闲超时由 Host 侧 SessionManager 管理 ──

  private sessionConn: PoolConnection | null = null;

  /** 回滚并释放活动会话连接（幂等） */
  private async disposeSession(): Promise<void> {
    const conn = this.sessionConn;
    if (!conn) {
      return;
    }
    this.sessionConn = null;
    await conn.query('ROLLBACK').catch(() => undefined);
    conn.release();
  }

  openSession(): Promise<ISession> {
    if (this.sessionConn) {
      return Promise.reject(new DriverError('E_VALIDATION', '已有进行中的事务会话（单连接最多 1 个）'));
    }
    return (async () => {
      const conn = await this.pool.getConnection();
      try {
        await conn.query('BEGIN');
      } catch (err) {
        conn.release();
        throw toDriverError(err);
      }
      this.sessionConn = conn;
      // 会话连接当前选中的库 = 池默认库；req.db 不同则切库（USE 不影响已开启的事务）
      let appliedDb = this.defaultDb;
      let ended = false;
      const assertLive = (): void => {
        if (ended || this.sessionConn !== conn) {
          throw new DriverError('E_CONN', '事务会话已结束');
        }
      };
      const end = async (stmt: 'COMMIT' | 'ROLLBACK'): Promise<void> => {
        assertLive();
        ended = true;
        this.sessionConn = null;
        try {
          await conn.query(stmt);
        } finally {
          conn.release();
        }
      };
      const session: ISession = {
        execute: async (req) => {
          assertLive();
          if (req.db && req.db !== appliedDb) {
            await conn.query(`USE ${quoteMysqlIdentifier(req.db)}`);
            appliedDb = req.db;
          }
          return runQueryOn(conn, req);
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
}

/** 单连接上的查询执行（池连接与会话连接共用同一 ResultSet 构建路径）；
 *  cancel 提供连接级取消信息（query 主链路专用，会话路径不传——事务内语句无取消语义） */
async function runQueryOn(
  executor: { query(opts: { sql: string; values?: unknown[] }): Promise<[unknown, unknown]> },
  req: QueryRequest,
  cancel?: { threadId?: number; cancelServer?: (threadId: number) => void },
): Promise<ResultSet[]> {
  try {
    const started = Date.now();
    const [rows, fields] = await executeCancelable(executor, req, cancel);
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

/**
 * 语句级取消/超时执行（驱动规范 §7，pg runCancelableOn 同构）：
 * - signal 已中止 → SQL 下发前立即 E_CANCELED（预中止检查点）
 * - 在途：abort → 专用临时连接 `KILL QUERY <threadId>`（只杀语句不杀连接）；在途语句随后回包
 *   ER_QUERY_INTERRUPTED(1317) → E_CANCELED（sql.ts 错误映射表）；客户端先以 E_CANCELED 拒绝，
 *   服务端迟到回包被 settle 链吞掉（P-30/P-46 同族，防未处理 rejection 毒化进程）
 * - deadline（timeoutMs，Console 默认 15s）→ 同上 + E_TIMEOUT
 * 取消竞态（P-46/P-54 同族）：1317 回包可能晚于客户端结算 → executor 上的 cancelSettle 交给
 * releaseAfterSettle 在归还前有界等待，避免被杀语句的回包/事件落在已复用连接上
 */
export async function executeCancelable(
  executor: { query(opts: { sql: string; values?: unknown[] }): Promise<[unknown, unknown]> },
  req: QueryRequest,
  cancel?: { threadId?: number; cancelServer?: (threadId: number) => void },
): Promise<[unknown, unknown]> {
  if (req.signal?.aborted) {
    throw new DriverError('E_CANCELED', '查询已取消');
  }
  const pending = executor.query({ sql: req.sql, values: req.params ?? [] });
  if (!req.signal && !(req.timeoutMs > 0)) {
    return pending; // 快路径：无 signal 且无 deadline，不包 settle 链
  }
  const requestCancel = (): void => {
    // 记录在途结算 promise：releaseAfterSettle 归还前有界等待（1317 实际毫秒级到达）
    (executor as { cancelSettle?: Promise<unknown> }).cancelSettle = pending.catch(() => undefined);
    if (cancel?.threadId !== undefined && cancel.cancelServer) {
      cancel.cancelServer(cancel.threadId);
    }
  };
  return new Promise<[unknown, unknown]>((resolve, reject) => {
    let settled = false;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const onAbort = (): void => {
      requestCancel();
      settleReject(new DriverError('E_CANCELED', '查询已取消'));
    };
    const settleReject = (err: unknown): void => {
      if (settled) return;
      settled = true;
      if (deadline) clearTimeout(deadline);
      req.signal?.removeEventListener('abort', onAbort);
      reject(err);
    };
    const settleResolve = (value: [unknown, unknown]): void => {
      if (settled) return;
      settled = true;
      if (deadline) clearTimeout(deadline);
      req.signal?.removeEventListener('abort', onAbort);
      resolve(value);
    };
    if (req.signal) {
      req.signal.addEventListener('abort', onAbort, { once: true });
    }
    const timeoutMs = req.timeoutMs ?? 0;
    if (timeoutMs > 0) {
      deadline = setTimeout(() => {
        requestCancel();
        settleReject(new DriverError('E_TIMEOUT', '语句执行超时，已请求服务端取消'));
      }, timeoutMs);
    }
    pending.then(settleResolve, settleReject);
  });
}

/** 归还前的取消结算等待（2s 有界，pg withClient 同构）：1317 被本驱动 settle 链消费、连接回 ready
 *  态后再还池，消除「被杀语句回包落在已复用连接」的竞态（P-46/P-54 同族） */
async function releaseAfterSettle(conn: PoolConnection): Promise<void> {
  const settle = (conn as { cancelSettle?: Promise<unknown> }).cancelSettle;
  if (settle) {
    (conn as { cancelSettle?: Promise<unknown> }).cancelSettle = undefined;
    await Promise.race([settle, new Promise((r) => setTimeout(r, 2_000))]);
  }
  conn.release();
}

/** mysql2 内部属性：在途语句所在线程 id（KILL QUERY 的目标）。promise 包装的 typings 未声明
 *  threadId，兼容 PoolConnection 自身与底层 connection 两种挂载点（Loose cast） */
function poolConnectionThreadId(conn: PoolConnection): number | undefined {
  const c = conn as unknown as { threadId?: unknown; connection?: { threadId?: unknown } };
  const id = Number(c.threadId ?? c.connection?.threadId);
  return Number.isFinite(id) && id > 0 ? id : undefined;
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
    // ── 库级 DDL（M8-DBDDL / D-19）：语句生成同源（ddl.ts 纯函数），执行走 host.query ──
    getDatabaseFormSchema: () => ({
      fields: [
        { key: 'name', label: 'dbddl.name', type: 'string', required: true, placeholder: 'mydb' },
        {
          key: 'charset',
          label: 'dbddl.charset',
          type: 'select',
          default: 'utf8mb4',
          options: [
            { label: 'dbddl.opt.charset.utf8mb4', value: 'utf8mb4' },
            { label: 'dbddl.opt.charset.utf8', value: 'utf8' },
            { label: 'latin1', value: 'latin1' },
            { label: 'ascii', value: 'ascii' },
            { label: 'binary', value: 'binary' },
          ],
        },
        {
          key: 'collation',
          label: 'dbddl.collation',
          type: 'select',
          default: 'utf8mb4_general_ci',
          options: [
            { label: 'utf8mb4_general_ci', value: 'utf8mb4_general_ci' },
            { label: 'dbddl.opt.collation.utf8mb4_0900_ai_ci', value: 'utf8mb4_0900_ai_ci' },
            { label: 'utf8mb4_bin', value: 'utf8mb4_bin' },
            { label: 'utf8_general_ci', value: 'utf8_general_ci' },
            { label: 'latin1_swedish_ci', value: 'latin1_swedish_ci' },
          ],
        },
      ],
    }),
    buildCreateDatabase: async (spec) => buildCreateDatabaseStatements(spec),
    buildAlterDatabase: async (db, spec, current) => buildAlterDatabaseStatements(db, spec, current),
    buildDropDatabase: async (db) => buildDropDatabaseStatements(db),
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
    // 连接表单「默认库」建议（驱动规范 §3 @since v0.1.4）：不带库连接即可 SHOW DATABASES，失败 resolve []（无感降级）
    listDatabaseOptions: async (cfg: ConnectionConfig, secret: string): Promise<string[]> => {
      const o = cfg.options;
      let conn;
      try {
        const { createConnection } = await import('mysql2/promise');
        conn = await createConnection({
          host: String(o.host ?? '127.0.0.1'),
          port: Number(o.port ?? 3306),
          user: String(o.username ?? ''),
          password: secret,
          // 表单期自动建议：建连死线压到 ≤5s（不可达主机不静默长等）
          connectTimeout: Math.min(Number(o.connectTimeout ?? 10_000), 5_000),
          ssl: o.ssl ? { rejectUnauthorized: true } : undefined,
        });
        const [rows] = await conn.query('SHOW DATABASES');
        const names = (Array.isArray(rows) ? rows : []).map((r) =>
          String(Object.values(r as Record<string, unknown>)[0] ?? ''),
        );
        return filterMysqlDatabases(names.filter((n) => n.length > 0));
      } catch {
        // 失败契约（驱动规范 §3 @since v0.1.4）：resolve 空数组、禁止 reject——UI 无感降级为手输
        return [];
      } finally {
        await conn?.end().catch(() => undefined);
      }
    },
    connect: (cfg: ConnectionConfig, secret: string) =>
      Promise.resolve(new MysqlConnection(cfg, secret)),
  };
}
