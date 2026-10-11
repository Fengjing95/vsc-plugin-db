import * as mssql from 'mssql';
import type { Request } from 'mssql';

// @types/mssql（社区类型，v9 口径）缺 Request.timeout 运行时属性（mssql 文档 API：逐请求超时
// 下发依赖它）。模块内 augmentation——随本文件进入所有引用方的编译程序。
declare module 'mssql' {
  interface Request {
    timeout: number;
  }
}

// 方言词表（C-14/驱动规范 §3.2：关键字/函数/补全片段，覆盖 T-SQL 2016~2022 常用面）
import { COMPLETION_SNIPPETS, FUNCTIONS, KEYWORDS } from './completion';
import {
  DriverError,
  type ApplyResult,
  type ChangeSet,
  type ColumnMeta,
  type CompletionSource,
  type ConnectionConfig,
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
  buildAlterTableStatements,
  buildCreateSchemaStatements,
  buildCreateTableStatements,
  buildDropSchemaStatements,
  type AlterConstraintNames,
} from './ddl';
import { toDriverError } from './errors';
import {
  buildSelect,
  encodeCell,
  filterMssqlSchemas,
  formatMssqlDataType,
  fragmentHasColumn,
  normalizeMssqlType,
  quoteMssqlIdentifier,
  toNativeParam,
  TypedDateParam,
  TypedNullParam,
} from './sql';

/**
 * Microsoft SQL Server 驱动（mssql / tedious 内核，纯 JS 无 native 硬依赖，D-05 口径）。
 * M8-MSSQL 交付：连接/测试、元数据自省（D-15 同构：树上「库」= schema，ADR D-21）、分页取数
 * （OFFSET-FETCH）、参数化筛选下推、变更集（短事务 + 字段级乐观锁 + OUTPUT 回填）、取消
 * （request.cancel → ATTENTION）、DDL 生成器、库级 DDL（建/删 schema）、交互式事务会话。
 * db 参数语义（ADR D-21）：db = schema 名；连接绑定单一真库（表单 database 字段，缺省 master）。
 */
export const MSSQL_DRIVER_ID = 'mssql';

const capabilities: DriverCapabilities = {
  supportsSQL: true,
  supportsTransaction: true,
  supportsInteractiveTransaction: true, // openSession（SessionManager 空闲超时回收，§4.6/D-09）
  supportsMultipleDatabases: false, // 连接绑定单库（Initial Catalog）；跨库经三段名手写
  supportsMultiStatement: false, // 收紧注入面；Console 按单语句执行（对齐 mysql/pg 口径）
  supportsCancel: true, // signal → request.cancel()（TDS ATTENTION），CI service 实跑取消组验证
  supportsDdl: true,
  supportsDdlEditor: true, // buildCreateTable/buildAlterTable（DDL 走 query() 执行）
  supportsDatabaseDdl: true, // M8-DBDDL / D-19：「库」= schema（D-21）——buildCreateDatabase/buildDropDatabase
  hierarchy: ['connection', 'database', 'folder', 'table', 'view', 'column', 'key', 'index'],
  editable: true,
  pagination: 'offset',
};

const formSchema: FormSchema = {
  fields: [
    { key: 'host', label: '主机', type: 'string', required: true, placeholder: '127.0.0.1' },
    { key: 'port', label: '端口', type: 'number', required: true, default: 1433, validator: 'port' },
    {
      key: 'instanceName',
      label: '实例名',
      type: 'string',
      placeholder: 'SQLEXPRESS',
      hint: '命名实例（SQLEXPRESS 等）经 SQL Browser 解析；填写后端口字段被忽略',
    },
    { key: 'username', label: '用户名', type: 'string', required: true, placeholder: 'sa' },
    { key: 'password', label: '密码', type: 'password' },
    {
      key: 'database',
      label: '默认库',
      type: 'string',
      default: 'master',
      placeholder: 'master',
      hint: '连接绑定的 SQL Server 数据库；树上展开的「库」为该数据库内的 schema',
      dynamicOptions: 'databases',
    },
    {
      key: 'connectTimeout',
      label: '连接超时（ms）',
      type: 'number',
      default: 15000,
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
    { key: 'ssl', label: '启用加密（Encrypt）', type: 'boolean', default: false, group: '高级', section: 'SSL/TLS' },
    {
      key: 'sslInsecure',
      label: '跳过证书校验',
      type: 'boolean',
      default: false,
      group: '高级',
      section: 'SSL/TLS',
      toggle: 'ssl',
      hint: '不校验服务器证书（trustServerCertificate）——存在中间人风险，仅用于开发/自签环境',
    },
  ],
};

/** 建连/取数配置（连接与 testConnection 同源，防参数漂移）；C-10：密码仅经闭包，永不入日志 */
function buildPoolConfig(cfg: ConnectionConfig, secret: string): mssql.config {
  const o = cfg.options;
  return {
    server: String(o.host ?? '127.0.0.1'),
    port: o.instanceName ? undefined : Number(o.port ?? 1433),
    user: String(o.username ?? ''),
    password: secret,
    database: o.database ? String(o.database) : 'master',
    connectionTimeout: Number(o.connectTimeout ?? 15_000),
    // requestTimeout 按请求经 request.timeout 下发（core 恒传 timeoutMs）；0=无限不走默认
    requestTimeout: 0,
    options: {
      encrypt: Boolean(o.ssl),
      trustServerCertificate: Boolean(o.sslInsecure),
      instanceName: o.instanceName ? String(o.instanceName) : undefined,
      // tedious 默认 useUTC=true：TDS 时间值按 UTC 组件解析，读侧 getUTC* 还原墙上时间（§5 口径）
      useUTC: true,
      // uniqueidentifier 读侧返回小写（tedious 默认大写）——与 §5 书写惯例一致，往返保真
      lowerCaseGuids: true,
      enableArithAbort: true,
    },
    pool: {
      min: 0,
      max: Number(o.maxConnections ?? 4),
      idleTimeoutMillis: 30_000,
    },
  };
}

export class MssqlConnection implements IConnection {
  readonly connectionId: string;
  private readonly pool: mssql.ConnectionPool;
  private connected = false;
  private disposed = false;

  /** 方言信息（驱动规范 §3 DialectInfo）：Console SQL 格式化按 formatter 路由 */
  get dialect(): DialectInfo {
    return { id: 'mssql', quote: ['[', ']'], formatter: 'transactsql', keywords: KEYWORDS };
  }

  constructor(private readonly cfg: ConnectionConfig, private readonly secret: string) {
    this.connectionId = cfg.id;
    this.pool = new mssql.ConnectionPool(buildPoolConfig(cfg, secret));
    // 空闲池连接的异步错误（服务端重启等）：吞掉防止未捕获异常毒化宿主进程（P-30 同族教训）
    this.pool.on('error', () => undefined);
  }

  private assertLive(): void {
    if (this.disposed) {
      throw new DriverError('E_CONN', '连接已关闭');
    }
  }

  /** 惰性建连（D-10 懒连接）：pool.connect() 幂等（连接中重复调用复用 pending promise） */
  private async ensurePool(): Promise<mssql.ConnectionPool> {
    if (!this.connected) {
      await this.pool.connect();
      this.connected = true;
    }
    return this.pool;
  }

  async ping(): Promise<void> {
    this.assertLive();
    try {
      const pool = await this.ensurePool();
      await pool.request().query('SELECT 1 AS ok');
    } catch (err) {
      throw toDriverError(err);
    }
  }

  /** D-15/D-21：返回当前库内非系统 schema（排除 sys、information_schema、db_* 角色架构与 guest），树 database 层即 schema */
  async listDatabases(): Promise<DatabaseMeta[]> {
    this.assertLive();
    try {
      const pool = await this.ensurePool();
      const res = await pool
        .request()
        .query("SELECT name FROM sys.schemas ORDER BY name");
      const names = res.recordset.map((r) => String(r.name));
      return filterMssqlSchemas(names).map((name) => ({ name }));
    } catch (err) {
      throw toDriverError(err);
    }
  }

  async listObjects(db: string): Promise<ObjectMeta[]> {
    this.assertLive();
    try {
      const pool = await this.ensurePool();
      // rowEstimate 经 sys.partitions 元数据统计（非全表 COUNT，C-9）
      const res = await pool
        .request()
        .input('p1', db)
        .query(
          'SELECT o.name AS name, o.type_desc AS kind, (SELECT SUM(p.rows) FROM sys.partitions p WHERE p.object_id = o.object_id AND p.index_id IN (0, 1)) AS est FROM sys.objects o JOIN sys.schemas s ON s.schema_id = o.schema_id WHERE s.name = @p1 AND o.type IN (\'U\', \'V\') ORDER BY o.name',
        );
      return res.recordset.map((r) => {
        const est = Number(r.est);
        return {
          name: String(r.name),
          kind: r.kind === 'V' ? ('view' as const) : ('table' as const),
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
      const pool = await this.ensurePool();
      const res = await pool
        .request()
        .input('p1', db)
        .input('p2', obj)
        .query(
          "SELECT c.name AS name, t.name AS typename, c.max_length AS maxlen, c.precision AS prec, c.scale AS scale, c.is_nullable AS nullable, c.is_identity AS isident, dc.definition AS dflt, ep.value AS comment, c.column_id AS ord, CAST(CASE WHEN ic.object_id IS NOT NULL THEN 1 ELSE 0 END AS bit) AS ispk FROM sys.columns c JOIN sys.types t ON t.user_type_id = c.user_type_id JOIN sys.objects o ON o.object_id = c.object_id JOIN sys.schemas s ON s.schema_id = o.schema_id LEFT JOIN sys.default_constraints dc ON dc.parent_object_id = c.object_id AND dc.parent_column_id = c.column_id LEFT JOIN sys.extended_properties ep ON ep.major_id = c.object_id AND ep.minor_id = c.column_id AND ep.name = 'MS_Description' LEFT JOIN sys.indexes i ON i.object_id = c.object_id AND i.is_primary_key = 1 LEFT JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id AND ic.column_id = c.column_id WHERE s.name = @p1 AND o.name = @p2 ORDER BY c.column_id",
        );
      return res.recordset.map((r) => {
        const dataType = formatMssqlDataType({
          typeName: String(r.typename),
          maxLength: Number(r.maxlen),
          precision: Number(r.prec),
          scale: Number(r.scale),
        });
        const dflt = r.dflt !== undefined && r.dflt !== null ? String(r.dflt) : undefined;
        return {
          name: String(r.name),
          dataType,
          normalizedType: normalizeMssqlType(dataType),
          nullable: r.nullable === true,
          isPrimaryKey: r.ispk === true,
          autoIncrement: r.isident === true,
          defaultValue: stripDefaultOf(dflt),
          comment: r.comment !== undefined && r.comment !== null ? String(r.comment) : undefined,
          ordinal: Number(r.ord),
        };
      });
    } catch (err) {
      throw toDriverError(err);
    }
  }

  async listIndexes(db: string, obj: string): Promise<IndexMeta[]> {
    this.assertLive();
    try {
      const pool = await this.ensurePool();
      const res = await pool
        .request()
        .input('p1', db)
        .input('p2', obj)
        .query(
          "SELECT i.name AS name, i.is_unique AS uniq, i.type_desc AS itype, c.name AS col, ic.key_ordinal AS ord FROM sys.indexes i JOIN sys.objects o ON o.object_id = i.object_id JOIN sys.schemas s ON s.schema_id = o.schema_id JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id AND ic.key_ordinal > 0 JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id WHERE s.name = @p1 AND o.name = @p2 ORDER BY i.name, ic.key_ordinal",
        );
      const byName = new Map<string, IndexMeta>();
      for (const r of res.recordset) {
        const name = String(r.name);
        let idx = byName.get(name);
        if (!idx) {
          idx = {
            name,
            columns: [],
            unique: r.uniq === true,
            type: String(r.itype ?? '').toUpperCase() || undefined,
          };
          byName.set(name, idx);
        }
        idx.columns.push(String(r.col));
      }
      return [...byName.values()];
    } catch (err) {
      throw toDriverError(err);
    }
  }

  async listKeys(db: string, obj: string): Promise<KeyMeta[]> {
    this.assertLive();
    try {
      const pool = await this.ensurePool();
      const keys: KeyMeta[] = [];
      const cols = await this.listColumns(db, obj);
      const pkCols = cols.filter((c) => c.isPrimaryKey).map((c) => c.name);
      if (pkCols.length > 0) {
        const pkName = await pool
          .request()
          .input('p1', db)
          .input('p2', obj)
          .query("SELECT kc.name AS name FROM sys.key_constraints kc JOIN sys.objects o ON o.object_id = kc.parent_object_id JOIN sys.schemas s ON s.schema_id = o.schema_id WHERE s.name = @p1 AND o.name = @p2 AND kc.type = 'PK'");
        keys.push({ name: String(pkName.recordset[0]?.name ?? `${obj}_pkey`), kind: 'PK', columns: pkCols });
      }

      const fks = await pool
        .request()
        .input('p1', db)
        .input('p2', obj)
        .query(
          "SELECT fk.name AS name, c.name AS col, fkc.constraint_column_id AS ord, ro.name AS reftable, rc.name AS refcol FROM sys.foreign_keys fk JOIN sys.objects o ON o.object_id = fk.parent_object_id JOIN sys.schemas s ON s.schema_id = o.schema_id JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id JOIN sys.columns c ON c.object_id = fkc.parent_object_id AND c.column_id = fkc.parent_column_id JOIN sys.objects ro ON ro.object_id = fk.referenced_object_id JOIN sys.columns rc ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id WHERE s.name = @p1 AND o.name = @p2 ORDER BY fk.name, fkc.constraint_column_id",
        );
      const fkByName = new Map<string, KeyMeta>();
      for (const r of fks.recordset) {
        const name = String(r.name);
        let fk = fkByName.get(name);
        if (!fk) {
          fk = { name, kind: 'FK', columns: [], refTable: String(r.reftable), refColumns: [] };
          fkByName.set(name, fk);
        }
        fk.columns.push(String(r.col));
        fk.refColumns!.push(String(r.refcol));
      }
      keys.push(...fkByName.values());

      // UNIQUE：独立唯一索引（PK 已排除）
      const uniques = (await this.listIndexes(db, obj)).filter(
        (i) => i.unique && i.name !== keys.find((k) => k.kind === 'PK')?.name,
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
        // search 走 LIKE：限定 string/uuid 列
        searchColumns: cols
          .filter((c) => c.normalizedType === 'string' || c.normalizedType === 'uuid')
          .map((c) => c.name),
        limit: req.limit,
        offset: req.offset,
        encodeParam: (col, v) => toNativeParam(col, v, typeByName),
      });

      const started = Date.now();
      const pool = await this.ensurePool();
      const result = await runCancelableOn(pool, built.sql, built.params, {
        timeoutMs: req.timeoutMs,
        signal: req.signal,
      });
      const outCols =
        req.columns && req.columns.length > 0
          ? cols.filter((c) => req.columns?.includes(c.name))
          : cols;
      const rowsRaw = result.recordset ?? [];
      const data = rowsRaw.map((r: Record<string, unknown>) =>
        outCols.map((c) => encodeCell(r[c.name], c.normalizedType)),
      );

      return {
        columns: outCols.map((c) => ({ name: c.name, type: c.normalizedType })),
        rows: data,
        rowCount: data.length,
        totalCount: undefined, // 默认不做全表 COUNT（概要设计 5.4.4 / C-9）
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
      const pool = await this.ensurePool();
      // req.db（schema，D-21）仅作元数据绑定语境；语句执行原样下发——未限定名按用户默认
      // schema 解析（SSMS 同款行为，ADR D-21 声明）；表格取数/编辑语句恒两段名全限定
      const result = await runCancelableOn(pool, req.sql, req.params, {
        timeoutMs: req.timeoutMs,
        signal: req.signal,
      });
      return mapQueryResults(result as unknown as QueryOutcome, req.maxRows, Date.now() - started);
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

  /** 短事务提交（驱动规范 §8）：mssql.Transaction 单连接 BEGIN…COMMIT/ROLLBACK，任一 rowsAffected ≠ 1 → E_CONFLICT 回滚 */
  async applyChanges(db: string, obj: string, cs: ChangeSet): Promise<ApplyResult> {
    this.assertLive();
    const started = Date.now();
    try {
      const pool = await this.ensurePool();
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
      const transaction = new mssql.Transaction(pool);
      await transaction.begin();
      try {
        const items: ApplyResult['items'] = [];
        for (const stmt of statements) {
          const request = new mssql.Request(transaction);
          request.timeout = REQUEST_TIMEOUT_FLOOR_MS;
          bindParams(request, stmt.params);
          const result: QueryOutcome = (await request.query(stmt.sql)) as unknown as QueryOutcome;
          const affectedRows = result.rowsAffected?.[0] ?? 0;
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
                ? backfillInsertKey(pkCols, result.recordset, typeByName, cs, stmt.tempId)
                : stmt.rowKey,
            sql: stmt.sql,
            affectedRows,
          });
        }
        await transaction.commit();
        return { items, executionMs: Date.now() - started };
      } catch (err) {
        // 失败必须回滚（事务连接带 abort 态回池会毒化后续查询）
        await transaction.rollback().catch(() => undefined);
        throw err;
      }
    } catch (err) {
      throw DriverError.is(err) ? err : toDriverError(err);
    }
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
    return quoteMssqlIdentifier(name);
  }

  /** DDL 查看：视图走 OBJECT_DEFINITION；表按列/键拼装（M2 元数据组要求非空） */
  async getDdl(db: string, obj: string): Promise<string> {
    this.assertLive();
    try {
      const qualified = `${quoteMssqlIdentifier(db)}.${quoteMssqlIdentifier(obj)}`;
      const kind = await this.ensurePool().then((pool) =>
        pool
          .request()
          .input('p1', db)
          .input('p2', obj)
          .query("SELECT o.type AS kind FROM sys.objects o JOIN sys.schemas s ON s.schema_id = o.schema_id WHERE s.name = @p1 AND o.name = @p2")
          .then((r) => (r.recordset[0] ? String(r.recordset[0].kind) : undefined)),
      );
      if (kind === 'V') {
        const def = await this.ensurePool().then((pool) =>
          pool
            .request()
            .input('p1', qualified)
            .query('SELECT OBJECT_DEFINITION(OBJECT_ID(@p1)) AS def'),
        );
        const body = def.recordset[0]?.def ? String(def.recordset[0].def).trim() : '';
        return body || `-- 视图 ${qualified} 定义为空`;
      }
      const cols = await this.listColumns(db, obj);
      const keys = await this.listKeys(db, obj);
      const lines = cols.map((c) =>
        [
          `  ${quoteMssqlIdentifier(c.name)}`,
          c.dataType,
          c.autoIncrement ? 'IDENTITY(1,1)' : undefined,
          c.nullable ? 'NULL' : 'NOT NULL',
          c.defaultValue !== undefined && c.defaultValue !== ''
            ? `DEFAULT ${escapeDdlValue(c.defaultValue)}`
            : undefined,
        ]
          .filter(Boolean)
          .join(' '),
      );
      for (const k of keys) {
        if (k.kind === 'PK') {
          lines.push(`  PRIMARY KEY CLUSTERED (${k.columns.map(quoteMssqlIdentifier).join(', ')})`);
        } else if (k.kind === 'FK') {
          lines.push(
            `  FOREIGN KEY (${k.columns.map(quoteMssqlIdentifier).join(', ')}) REFERENCES ${quoteMssqlIdentifier(k.refTable ?? '')} (${(k.refColumns ?? []).map(quoteMssqlIdentifier).join(', ')})`,
          );
        }
      }
      return `CREATE TABLE ${qualified} (\n${lines.join(',\n')}\n);`;
    } catch (err) {
      throw toDriverError(err);
    }
  }

  // ── 表结构编辑（M8-B2，概要 §5.9）：先查约束名（PK__…/DF__… 随机名）再生成（执行走 query()）──

  async buildCreateTable(db: string, spec: TableSpec): Promise<DdlStatement[]> {
    return Promise.resolve(buildCreateTableStatements(db, spec));
  }

  async buildAlterTable(db: string, obj: string, spec: TableSpec, current: TableSpec): Promise<DdlStatement[]> {
    const names: AlterConstraintNames = {
      defaultConstraints: new Map<string, string>(),
    };
    // 约束名来自实时自省（DDL 语句生成的输入，非用户值；标识符 fail-closed 在生成层兜底）
    try {
      const pool = await this.ensurePool();
      const pk = await pool
        .request()
        .input('p1', db)
        .input('p2', obj)
        .query("SELECT kc.name AS name FROM sys.key_constraints kc JOIN sys.objects o ON o.object_id = kc.parent_object_id JOIN sys.schemas s ON s.schema_id = o.schema_id WHERE s.name = @p1 AND o.name = @p2 AND kc.type = 'PK'");
      if (pk.recordset[0]?.name) {
        names.pkConstraintName = String(pk.recordset[0].name);
      }
      const dfs = await pool
        .request()
        .input('p1', db)
        .input('p2', obj)
        .query("SELECT c.name AS col, dc.name AS name FROM sys.default_constraints dc JOIN sys.columns c ON c.object_id = dc.parent_object_id AND c.column_id = dc.parent_column_id JOIN sys.objects o ON o.object_id = dc.parent_object_id JOIN sys.schemas s ON s.schema_id = o.schema_id WHERE s.name = @p1 AND o.name = @p2");
      for (const r of dfs.recordset) {
        names.defaultConstraints!.set(String(r.col), String(r.name));
      }
    } catch (err) {
      throw toDriverError(err);
    }
    return buildAlterTableStatements(db, obj, spec, current, names);
  }

  dispose(): void | Promise<void> {
    if (this.disposed) {
      return Promise.resolve();
    }
    this.disposed = true;
    // 活动交互式事务会话随连接 dispose 一起回滚释放（防连接泄漏/悬挂事务）
    return Promise.resolve(this.disposeSession())
      .catch(() => undefined)
      .then(() => (this.connected ? this.pool.close().catch(() => undefined) : undefined));
  }

  // ── 交互式事务会话（M7，概要 §4.6 / D-09）：单连接最多 1 个；空闲超时由 Host 侧 SessionManager 管理 ──

  private sessionTx: mssql.Transaction | null = null;

  /** 回滚并释放活动会话事务（幂等） */
  private async disposeSession(): Promise<void> {
    const tx = this.sessionTx;
    if (!tx) {
      return;
    }
    this.sessionTx = null;
    await tx.rollback().catch(() => undefined);
  }

  openSession(): Promise<ISession> {
    this.assertLive();
    if (this.sessionTx) {
      return Promise.reject(new DriverError('E_VALIDATION', '已有进行中的事务会话（单连接最多 1 个）'));
    }
    return (async () => {
      const pool = await this.ensurePool();
      const tx = new mssql.Transaction(pool);
      try {
        await tx.begin();
      } catch (err) {
        throw toDriverError(err);
      }
      this.sessionTx = tx;
      let ended = false;
      const assertLive = (): void => {
        if (ended || this.sessionTx !== tx) {
          throw new DriverError('E_CONN', '事务会话已结束');
        }
      };
      const end = async (stmt: 'commit' | 'rollback'): Promise<void> => {
        assertLive();
        ended = true;
        this.sessionTx = null;
        await tx[stmt]();
      };
      const session: ISession = {
        execute: async (req) => {
          assertLive();
          const started = Date.now();
          const request = new mssql.Request(tx);
          request.timeout = req.timeoutMs > 0 ? req.timeoutMs : REQUEST_TIMEOUT_FLOOR_MS;
          bindParams(request, req.params);
          const result = await request.query(req.sql).catch((err: unknown) => {
            throw toDriverError(err);
          });
          return mapQueryResults(result as unknown as QueryOutcome, req.maxRows, Date.now() - started);
        },
        commit: () => end('commit'),
        rollback: () => end('rollback'),
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

/** request.timeout=0 表示无限——契约组取消死线依赖有限默认；无超时语义时给 60s 兜底 */
const REQUEST_TIMEOUT_FLOOR_MS = 60_000;

/** recordset 列元数据的局部结构面（类型名由 tedious 类型对象携带，形如 { name: 'NVarChar' }；
 *  @types 的 IColumnMetadata.type 是 ISqlType|工厂联合，这里按运行时真实形态（{name}）窄化取用） */
interface RecordsetColumnMeta {
  name: string;
  index?: number;
  type?: { name?: string };
}

/** mssql recordset 运行时形态：行数组 + 挂载的 columns 元数据（列名为键，重名列折叠） */
type Recordset = Array<Record<string, unknown>> & {
  columns?: Record<string, RecordsetColumnMeta>;
};

/**
 * query() 结果的局部结构类型（@types/mssql 的 IResult<T> 条件泛型对本驱动过窄；
 * 仅消费 recordset/recordsets/rowsAffected 三面）
 */
interface QueryOutcome {
  recordset?: Recordset;
  recordsets?: Array<Recordset | undefined>;
  rowsAffected?: number[];
}

/** DEFAULT 约束定义 → 表 DDL 默认值原文（getdate() 等，去 N'' 引号交 escapeDdlValue 还原） */
function stripDefaultOf(definition: string | undefined): string | undefined {
  if (definition === undefined) {
    return undefined;
  }
  let s = definition.trim();
  while (s.length >= 2 && s.startsWith('(') && s.endsWith(')')) {
    s = s.slice(1, -1).trim();
  }
  return s;
}

/** getDdl 拼装用：默认值原文（getdate() 原样、字符串补 N''） */
function escapeDdlValue(raw: string): string {
  if (/^-?\d+(\.\d+)?$/.test(raw) || /^[a-z_][a-z0-9_]*\s*\(/i.test(raw)) {
    return raw;
  }
  return `N'${raw.replace(/'/g, "''")}'`;
}

/** §8-3 insert 主键回填：OUTPUT INSERTED 结果集原值优先，缺省回落用户携带值 */
function backfillInsertKey(
  pkCols: string[],
  recordset: Array<Record<string, unknown>> | undefined,
  typeByName: Map<string, NormalizedType>,
  cs: ChangeSet,
  tempId: string | undefined,
): RowKey | undefined {
  if (pkCols.length === 0) {
    return undefined;
  }
  const row = recordset?.[0];
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

/** 连接层参数绑定：TypedDateParam → 显式 mssql 类型（DateTime2/Date/Time，字符串直传会受
 *  会话 DATEFORMAT 影响的非确定性隐式转换）；TypedNullParam（binary 列 NULL）→ 显式
 *  VarBinary——mssql 对 null 自动推断 NVarChar，nvarchar→varbinary 无隐式转换；Buffer →
 *  VarBinary；其余 mssql 自动推断 */
function bindParams(request: Request, params: unknown[] | undefined): void {
  for (let i = 0; i < (params?.length ?? 0); i++) {
    const value = params![i];
    const name = `p${i + 1}`;
    if (value instanceof TypedNullParam) {
      request.input(name, mssql.VarBinary(mssql.MAX), null);
    } else if (value === null || value === undefined) {
      request.input(name, null);
    } else if (value instanceof TypedDateParam) {
      const type =
        value.kind === 'date' ? mssql.Date : value.kind === 'time' ? mssql.Time : mssql.DateTime2;
      request.input(name, type, value.value);
    } else if (Buffer.isBuffer(value)) {
      request.input(name, mssql.VarBinary(mssql.MAX), value);
    } else {
      request.input(name, value);
    }
  }
}

/**
 * 取消/超时语义（驱动规范 §7）：
 * - signal 已中止 → SQL 下发前立即 E_CANCELED（预中止检查点）
 * - 在途：abort → request.cancel()（TDS ATTENTION，服务端取消当前 batch，连接可复用）
 * - deadline（timeoutMs）→ request.timeout + E_TIMEOUT（tedious 超时自动 cancel）
 * 结算后底层查询的后续回包/错误被吞（避免未处理 rejection 毒化进程，P-30 同族）
 */
async function runCancelableOn(
  pool: mssql.ConnectionPool,
  sql: string,
  params: unknown[] | undefined,
  opts: { timeoutMs?: number; signal?: AbortSignal },
): Promise<QueryOutcome> {
  if (opts.signal?.aborted) {
    throw new DriverError('E_CANCELED', '查询已取消');
  }
  const request = pool.request();
  request.timeout = opts.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : REQUEST_TIMEOUT_FLOOR_MS;
  bindParams(request, params);
  const pending: Promise<QueryOutcome> = request.query(sql) as unknown as Promise<QueryOutcome>;
  const onAbort = (): void => {
    // request.cancel() 发送 TDS ATTENTION；结算竞态错误经 pending 的 catch 吞掉
    try {
      request.cancel();
    } catch {
      // 已结算/已取消时 cancel 抛错属预期，吞掉
    }
  };
  opts.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    return await pending;
  } finally {
    opts.signal?.removeEventListener('abort', onAbort);
  }
}

/** query() 结果映射：recordsets → ResultSet[]；无 recordset（非 SELECT）→ affectedRows */
function mapQueryResults(result: QueryOutcome, maxRows: number, executionMs: number): ResultSet[] {
  const recordsets = (result.recordsets ?? []).filter(
    (rs): rs is Recordset => rs !== undefined && rs !== null,
  );
  if (recordsets.length === 0) {
    const affected = (result.rowsAffected ?? []).reduce((a, b) => a + Number(b ?? 0), 0);
    return [
      {
        columns: [],
        rows: [],
        rowCount: 0,
        affectedRows: affected,
        executionMs,
      },
    ];
  }
  return recordsets.map((rs) => mapOneRecordset(rs, maxRows, executionMs));
}

/** recordset 列元数据的局部结构面（类型名由 tedious 类型对象携带，形如 { name: 'NVarChar' }） */
// （RecordsetColumnMeta / Recordset 声明见文件头 QueryOutcome 一节）

function mapOneRecordset(
  rs: Recordset,
  maxRows: number,
  executionMs: number,
): ResultSet {
  // recordset.columns 以列名为键（重名列折叠——Console 结果展示可接受）；按 index 恢复列序。
  // TDS 的无别名表达式列（SELECT COUNT(*) / GETDATE()）列名为空串——占位兜底，
  // 否则过滤后结果行变空（Console 跑无别名查询得到空结果，契约 interactive 组踩）
  const rawCols = Object.values(rs.columns ?? {});
  const cols = rawCols
    .filter((c) => c !== undefined && c !== null)
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    .map((c) => ({ name: c.name ? String(c.name) : '（无列名）', type: tediousTypeToNormalized(c.type?.name) }));
  const sliced = rs.slice(0, maxRows);
  return {
    columns: cols,
    rows: sliced.map((r) => cols.map((c) => encodeCell(r[c.name], c.type))),
    rowCount: sliced.length,
    affectedRows: undefined,
    executionMs,
    truncated: rs.length > maxRows,
  };
}

/** tedious 类型名（recordset.columns[].type.name）→ NormalizedType（query 路径无元数据自省） */
function tediousTypeToNormalized(typeName: string | undefined): NormalizedType {
  switch ((typeName ?? '').toLowerCase()) {
    case 'int':
    case 'smallint':
    case 'tinyint':
    case 'bigint':
      return 'integer';
    case 'decimal':
    case 'numeric':
    case 'money':
    case 'smallmoney':
      return 'decimal';
    case 'float':
    case 'real':
      return 'float';
    case 'bit':
      return 'boolean';
    case 'date':
      return 'date';
    case 'time':
      return 'time';
    case 'datetime':
    case 'datetime2':
    case 'smalldatetime':
    case 'datetimeoffset':
      return 'datetime';
    case 'uniqueidentifier':
      return 'uuid';
    case 'varbinary':
    case 'binary':
    case 'image':
    case 'udt':
      return 'binary';
    case 'xml':
      return 'string';
    default:
      return typeof typeName === 'string' && /char|text/i.test(typeName) ? 'string' : 'unknown';
  }
}

export function createMssqlDriver(): IDatabaseDriver {
  return {
    id: MSSQL_DRIVER_ID,
    displayName: 'SQL Server',
    apiVersion: 1,
    capabilities,
    getConnectionFormSchema: () => formSchema,
    // ── 库级 DDL（M8-DBDDL / D-19）：树上「库」= schema（D-21）——CREATE / DROP SCHEMA──
    getDatabaseFormSchema: () => ({
      fields: [
        {
          key: 'name',
          label: 'Schema 名',
          type: 'string',
          required: true,
          placeholder: 'appdata',
          hint: '树上的「库」为 SQL Server schema（ADR D-21，连接绑定单库）；删除 schema 仅对空 schema 成功（T-SQL 无 CASCADE）',
        },
      ],
    }),
    buildCreateDatabase: async (spec) => buildCreateSchemaStatements(spec),
    buildDropDatabase: async (db) => buildDropSchemaStatements(db),
    testConnection: async (cfg: ConnectionConfig, secret: string): Promise<TestResult> => {
      const started = Date.now();
      let pool: mssql.ConnectionPool | undefined;
      try {
        pool = new mssql.ConnectionPool(buildPoolConfig(cfg, secret));
        pool.on('error', () => undefined);
        await pool.connect();
        const res = await pool.request().query('SELECT @@VERSION AS v');
        const raw = res.recordset[0]?.v !== undefined ? String(res.recordset[0].v) : '';
        // 'Microsoft SQL Server 2022 (RTM-CU13) ... - 16.0.xxxx' → 'SQL Server 2022'
        const version = /SQL Server\s+([^\s(-]+)/.exec(raw);
        return { ok: true, latencyMs: Date.now() - started, serverVersion: version ? `SQL Server ${version[1]}` : undefined };
      } catch (err) {
        return { ok: false, error: toDriverError(err) };
      } finally {
        await pool?.close().catch(() => undefined);
      }
    },
    // 连接表单「默认库」建议（驱动规范 §3 @since v0.1.4）：经 master 列用户库，失败 resolve []（无感降级）
    listDatabaseOptions: async (cfg: ConnectionConfig, secret: string): Promise<string[]> => {
      let pool: mssql.ConnectionPool | undefined;
      try {
        pool = new mssql.ConnectionPool({
          ...buildPoolConfig(cfg, secret),
          database: 'master',
          connectionTimeout: Math.min(Number(cfg.options.connectTimeout ?? 15_000), 5_000),
          requestTimeout: 5_000,
        });
        pool.on('error', () => undefined);
        await pool.connect();
        const res = await pool
          .request()
          .query("SELECT name FROM sys.databases WHERE name NOT IN ('master', 'tempdb', 'model', 'msdb') AND state = 0 ORDER BY name");
        return res.recordset.map((r) => String(r.name));
      } catch {
        // 表单期自动建议：失败无感降级（契约：禁止 reject）
        return [];
      } finally {
        await pool?.close().catch(() => undefined);
      }
    },
    connect: (cfg: ConnectionConfig, secret: string) => Promise.resolve(new MssqlConnection(cfg, secret)),
  };
}
