import * as oracledb from 'oracledb';

// 方言词表（C-14/驱动规范 §3.2：关键字/函数/补全片段，覆盖 Oracle 12c~19c 常用面）
import { COMPLETION_SNIPPETS, DATA_TYPES, FUNCTIONS, KEYWORDS } from './completion';
import {
  DriverError,
  type ApplyResult,
  type ChangeSet,
  type ColumnMeta,
  type CompletionSource,
  type ConnectionConfig,
  type DatabaseMeta,
  type DataTypeOption,
  type DdlStatement,
  type DriverCapabilities,
  type DialectInfo,
  type FetchRowsRequest,
  type FormSchema,
  type IConnection,
  type IDatabaseDriver,
  type IndexMeta,
  type ISession,
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
  buildCreateTableStatements,
  buildCreateUserStatements,
  buildDropUserStatements,
} from './ddl';
import { toDriverError } from './errors';
import {
  buildConnectString,
  buildFetchInfo,
  buildSelect,
  encodeCell,
  fragmentHasColumn,
  formatOracleDataType,
  normalizeOracleType,
  oracleDbTypeToNormalized,
  quoteOracleIdentifier,
  stripOracleColumnDefault,
  toNativeParam,
} from './sql';

/**
 * Oracle Database 驱动（node-oracledb thin，纯 JS 无 native 硬依赖，D-05/D-23 口径）。
 * M8-Oracle 交付：连接/测试（service 寻址 + SYSDBA 角色可选）、元数据自省（D-15/D-21 同构：
 * 树上「库」= schema，db 参数 = schema 名、obj 恒为裸名）、分页取数（OFFSET/FETCH + fetchInfo
 * 按列保精度）、参数化筛选下推、变更集（短事务 + 字段级乐观锁 + RETURNING 回填）、取消
 * （connection.break() → ORA-01013，连接可复用）、DDL 生成器、库级 DDL（CREATE/DROP USER）、
 * 交互式事务会话。空串即 NULL（引擎语义，ADR D-23 岔口 4）；写路径禁 USE（方言无此语句）。
 */
export const ORACLE_DRIVER_ID = 'oracle';

const capabilities: DriverCapabilities = {
  supportsSQL: true,
  supportsTransaction: true,
  supportsInteractiveTransaction: true, // openSession（SessionManager 空闲超时回收，§4.6/D-09）
  supportsMultipleDatabases: false, // 连接绑定单个 PDB（service 寻址，ADR D-23 岔口 2）
  supportsMultiStatement: false, // 收紧注入面；Console 按单语句执行（对齐 mysql/pg/mssql 口径）
  supportsCancel: true, // signal → connection.break()（OOB 取消，实测连接可复用）
  supportsDdl: true, // DBMS_METADATA.GET_DDL
  supportsDdlEditor: true, // buildCreateTable/buildAlterTable（DDL 走 query() 执行）
  // 表设计器（交互稿 §12.2/§14.4）：约束式 UNIQUE/FK 全能力；ON DELETE 无 RESTRICT、无 ON UPDATE
  tableDesign: {
    uniqueKeys: true,
    foreignKeys: true,
    foreignKeyAlter: true,
    indexes: true,
    indexTypes: ['NORMAL', 'BITMAP'],
    refActions: ['CASCADE', 'SET NULL', 'NO ACTION'],
  },
  supportsDatabaseDdl: true, // M8-DBDDL / D-19：建/删 schema（= CREATE/DROP USER）；无 ALTER（用户不可重命名）
  supportsErDiagram: true, // M8-ER（D-22）：listKeys FK 元数据完整——ER 关系收集消费者
  hierarchy: ['connection', 'database', 'folder', 'table', 'view', 'column', 'key', 'index'],
  editable: true,
  pagination: 'offset',
};

const formSchema: FormSchema = {
  fields: [
    { key: 'host', label: '主机', type: 'string', required: true, placeholder: '127.0.0.1' },
    { key: 'port', label: '端口', type: 'number', required: true, default: 1521, validator: 'port' },
    {
      key: 'serviceName',
      label: '服务名',
      type: 'string',
      required: true,
      placeholder: 'orcl',
      hint: 'Oracle 服务名（service name）或 SID：PDB 应用连接填其注册服务名（如 orcl）；CDB 默认服务与 SID 同名可直填。树上展开的「库」为该容器内的 schema（ADR D-23）',
    },
    { key: 'username', label: '用户名', type: 'string', required: true, placeholder: 'system' },
    { key: 'password', label: '密码', type: 'password' },
    {
      key: 'connectString',
      label: '连接串（完整）',
      type: 'string',
      group: '高级',
      section: '连接描述符',
      placeholder: '(DESCRIPTION=…) 或 host:port/service',
      hint: '完整 EZConnect/TNS 描述符或 tnsnames 别名——填写后忽略主机/端口/服务名（RAC/SCAN/LDAP 等场景）',
    },
    {
      key: 'sysdba',
      label: '以 SYSDBA 连接',
      type: 'boolean',
      default: false,
      group: '高级',
      section: '身份',
      hint: '数据库管理员身份（privilege=SYSDBA），用于管理场景（如浏览全部 schema）；普通应用账号保持关闭',
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
      key: 'poolMax',
      label: '连接池上限',
      type: 'number',
      default: 4,
      group: '高级',
      section: '超时与连接池',
    },
  ],
};

/** 建连参数（连接与 testConnection 同源，防参数漂移）；C-10：密码仅经闭包，永不入日志 */
interface ConnectParams {
  user: string;
  password: string;
  connectString: string;
  privilege?: number;
}

function buildConnectParams(cfg: ConnectionConfig, secret: string): ConnectParams {
  const o = cfg.options;
  const params: ConnectParams = {
    user: String(o.username ?? ''),
    password: secret,
    connectString: buildConnectString({
      connectString: o.connectString ? String(o.connectString) : undefined,
      host: o.host ? String(o.host) : undefined,
      port: o.port !== undefined ? Number(o.port) : undefined,
      serviceName: o.serviceName ? String(o.serviceName) : undefined,
      connectTimeoutMs: o.connectTimeout !== undefined ? Number(o.connectTimeout) : undefined,
    }),
  };
  if (o.sysdba === true) {
    params.privilege = oracledb.SYSDBA;
  }
  return params;
}

/** 语句超时死线：thin 的 callTimeout 承载 timeoutMs（NJS-123 → E_TIMEOUT，ADR D-23）；0/缺省给 60s 兜底 */
const CALL_TIMEOUT_FLOOR_MS = 60_000;

export class OracleConnection implements IConnection {
  readonly connectionId: string;
  private readonly connectParams: ConnectParams;
  private readonly poolMax: number;
  private pool: oracledb.Pool | undefined;
  private poolCreating: Promise<oracledb.Pool> | undefined;
  private disposed = false;

  /** 方言信息（驱动规范 §3 DialectInfo）：Console SQL 格式化按 formatter 路由（sql-formatter 的 plsql） */
  get dialect(): DialectInfo {
    return { id: 'oracle', quote: ['"', '"'], formatter: 'plsql', keywords: KEYWORDS };
  }

  constructor(cfg: ConnectionConfig, secret: string) {
    this.connectionId = cfg.id;
    this.connectParams = buildConnectParams(cfg, secret);
    this.poolMax = Math.max(1, Number(cfg.options.poolMax ?? 4));
  }

  private assertLive(): void {
    if (this.disposed) {
      throw new DriverError('E_CONN', '连接已关闭');
    }
  }

  /** 惰性建池（D-10 懒连接）；createPool 幂等（pending promise 复用） */
  private async ensurePool(): Promise<oracledb.Pool> {
    if (this.pool) {
      return this.pool;
    }
    if (!this.poolCreating) {
      this.poolCreating = oracledb
        .createPool({
          user: this.connectParams.user,
          password: this.connectParams.password,
          connectString: this.connectParams.connectString,
          privilege: this.connectParams.privilege,
          poolMin: 0,
          poolMax: this.poolMax,
          poolTimeout: 30,
        })
        .then((p) => {
          this.pool = p;
          return p;
        })
        .catch((err) => {
          this.poolCreating = undefined;
          throw toDriverError(err);
        });
    }
    return this.poolCreating;
  }

  /**
   * 取消/超时语义（驱动规范 §7；ADR D-23 岔口 7）：在途查询独占池连接——
   * - signal 已中止 → SQL 下发前立即 E_CANCELED
   * - 在途：abort → connection.break()（OOB 取消，服务端 ORA-01013，连接可复用后归还）
   * - deadline（timeoutMs）→ callTimeout（NJS-123 → E_TIMEOUT）
   */
  private async withConnection<T>(
    work: (conn: oracledb.Connection) => Promise<T>,
    opts: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<T> {
    this.assertLive();
    if (opts.signal?.aborted) {
      throw new DriverError('E_CANCELED', '查询已取消');
    }
    const pool = await this.ensurePool();
    const conn = await pool.getConnection();
    const onAbort = (): void => {
      // break() 触发在途执行以 ORA-01013 结束；结算竞态错误随 execute 的 rejection 抛出
      conn.break().catch(() => undefined);
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      conn.callTimeout = opts.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : CALL_TIMEOUT_FLOOR_MS;
      return await work(conn);
    } catch (err) {
      throw toDriverError(err);
    } finally {
      opts.signal?.removeEventListener('abort', onAbort);
      await conn.close().catch(() => undefined); // 池连接归还（含 break 后可复用连接）
    }
  }

  async ping(): Promise<void> {
    await this.withConnection((conn) => conn.execute('SELECT 1 FROM DUAL'));
  }

  /** D-23：返回容器内非系统 schema（ALL_USERS 排除 ORACLE_MAINTAINED），当前用户排首位——
   *  业务的「默认 schema」先见（契约组 dbs[0] 取样与树首屏同口径） */
  async listDatabases(): Promise<DatabaseMeta[]> {
    return this.withConnection(async (conn) => {
      const res = await conn.execute(
        "SELECT username FROM all_users WHERE oracle_maintained = 'N' ORDER BY CASE WHEN username = USER THEN 0 ELSE 1 END, username",
      );
      return ((res.rows ?? []) as unknown[][]).map((r) => ({ name: String(r[0]) }));
    });
  }

  async listObjects(db: string): Promise<ObjectMeta[]> {
    return this.withConnection(async (conn) => {
      // rowEstimate 经 all_tables.num_rows 元数据统计（非全表 COUNT，C-9；无优化器统计时为 NULL → 缺省）
      const res = await conn.execute(
        `SELECT t.table_name AS name, 'T' AS kind, t.num_rows AS est
           FROM all_tables t WHERE t.owner = :1
         UNION ALL
         SELECT v.view_name, 'V', NULL
           FROM all_views v WHERE v.owner = :2
         ORDER BY 1`,
        [db, db],
      );
      return ((res.rows ?? []) as unknown[][]).map((r) => {
        const est = r[2] === null || r[2] === undefined ? undefined : Number(r[2]);
        return {
          name: String(r[0]),
          kind: r[1] === 'V' ? ('view' as const) : ('table' as const),
          rowEstimate: est !== undefined && Number.isFinite(est) && est >= 0 ? est : undefined,
        };
      });
    });
  }

  async listColumns(db: string, obj: string): Promise<ColumnMeta[]> {
    return this.withConnection(async (conn) => {
      // PK 标记独立小查询（all_constraints+all_cons_columns 大视图与 tab_columns 合流查询
      // 在字典统计缺失的实例上极慢——按 owner+table 约束列一次取回，JS 侧合并）
      const [colsRes, pk] = await Promise.all([
        conn.execute(
          `SELECT c.column_name, c.data_type, c.data_precision, c.data_scale, c.char_length, c.char_used,
                  c.nullable, c.column_id, c.data_default, cc.comments,
                  CASE WHEN ic.column_name IS NULL THEN 0 ELSE 1 END AS isid
             FROM all_tab_columns c
             LEFT JOIN all_col_comments cc
               ON cc.owner = c.owner AND cc.table_name = c.table_name AND cc.column_name = c.column_name
             LEFT JOIN all_tab_identity_cols ic
               ON ic.owner = c.owner AND ic.table_name = c.table_name AND ic.column_name = c.column_name
            WHERE c.owner = :1 AND c.table_name = :2
            ORDER BY c.column_id`,
          [db, obj],
        ),
        conn.execute(
          `SELECT cc.column_name
             FROM all_constraints c
             JOIN all_cons_columns cc
               ON cc.owner = c.owner AND cc.table_name = c.table_name AND cc.constraint_name = c.constraint_name
            WHERE c.owner = :1 AND c.table_name = :2 AND c.constraint_type = 'P'
            ORDER BY cc.position`,
          [db, obj],
        ),
      ]);
      const pkCols = new Set(((pk.rows ?? []) as unknown[][]).map((r) => String(r[0])));
      return ((colsRes.rows ?? []) as unknown[][]).map((r, i) => {
        const dataType = formatOracleDataType({
          dataType: String(r[1]),
          precision: r[2] === null ? null : Number(r[2]),
          scale: r[3] === null ? null : Number(r[3]),
          charLength: r[4] === null ? null : Number(r[4]),
          charUsed: r[5] === null ? null : String(r[5]),
        });
        const name = String(r[0]);
        return {
          name,
          dataType,
          normalizedType: normalizeOracleType(dataType),
          nullable: String(r[6]) === 'Y',
          isPrimaryKey: pkCols.has(name),
          autoIncrement: Number(r[10]) === 1,
          defaultValue: stripOracleColumnDefault(r[8] === null ? null : String(r[8])),
          comment: r[9] === null || r[9] === undefined ? undefined : String(r[9]),
          // 视图列无 column_id（恒 null）→ 按返回序兜底 1-based
          ordinal: r[7] === null || r[7] === undefined ? i + 1 : Number(r[7]),
        };
      });
    });
  }

  async listIndexes(db: string, obj: string): Promise<IndexMeta[]> {
    return this.withConnection(async (conn) => {
      // 只列独立二级索引：排除约束-backed 索引（PK/UK 的隐式索引 index_name = 约束名）与
      // 函数基/LOB/DOMAIN 索引——索引 Tab 只管二级索引（交互稿 §12.6）
      const res = await conn.execute(
        `SELECT i.index_name, i.uniqueness, i.index_type, ic.column_name, ic.column_position
           FROM all_indexes i
           JOIN all_ind_columns ic
             ON ic.index_owner = i.owner AND ic.index_name = i.index_name
          WHERE i.owner = :1 AND i.table_name = :2
            AND i.index_type IN ('NORMAL', 'NORMAL/REV', 'BITMAP')
            AND NOT EXISTS (
              SELECT 1 FROM all_constraints c
               WHERE c.owner = i.owner AND c.constraint_name = i.index_name
                 AND c.constraint_type IN ('P', 'U')
            )
          ORDER BY i.index_name, ic.column_position`,
        [db, obj],
      );
      const byName = new Map<string, IndexMeta>();
      for (const r of (res.rows ?? []) as unknown[][]) {
        const name = String(r[0]);
        let idx = byName.get(name);
        if (!idx) {
          idx = {
            name,
            columns: [],
            unique: String(r[1]) === 'UNIQUE',
            type: String(r[2]) === 'BITMAP' ? 'BITMAP' : undefined,
          };
          byName.set(name, idx);
        }
        idx.columns.push(String(r[3]));
      }
      return [...byName.values()];
    });
  }

  async listKeys(db: string, obj: string): Promise<KeyMeta[]> {
    // listColumns 先行于本方法的连接租借（它独立借还连接）——禁止在 withConnection 回调内
    // 嵌套调用其他借连接的方法：ER 关系收集并发扫描下 hold-and-wait 会自锁连接池
    //（外层持连接等内层排队，queueTimeout 60s 满即 NJS-040，实跑踩）
    const cols = await this.listColumns(db, obj);
    return this.withConnection(async (conn) => {
      const keys: KeyMeta[] = [];
      const pkCols = cols.filter((c) => c.isPrimaryKey).map((c) => c.name);
      if (pkCols.length > 0) {
        const pkName = await conn.execute(
          `SELECT constraint_name FROM all_constraints
            WHERE owner = :1 AND table_name = :2 AND constraint_type = 'P'`,
          [db, obj],
        );
        const pkNameRaw = (pkName.rows as unknown[][] | undefined)?.[0]?.[0];
        keys.push({
          name: String(pkNameRaw ?? `${obj}_pkey`),
          kind: 'PK',
          columns: pkCols,
        });
      }

      // 两段查询（all_constraints×all_cons_columns×引用侧三表合流查询在字典统计缺失的实例上
      // 单表 2.7s+，实测拖垮 ER 关系收集——先取本表约束列，再逐约束取引用侧）：
      // ① 本表 UNIQUE（U）/外键（R）的约束列（position 序）
      const res = await conn.execute(
        `SELECT c.constraint_name, c.constraint_type, cc.column_name, cc.position
           FROM all_constraints c
           JOIN all_cons_columns cc
             ON cc.owner = c.owner AND cc.table_name = c.table_name AND cc.constraint_name = c.constraint_name
          WHERE c.owner = :1 AND c.table_name = :2 AND c.constraint_type IN ('U', 'R')
          ORDER BY c.constraint_name, cc.position`,
        [db, obj],
      );
      const byName = new Map<string, KeyMeta>();
      for (const r of (res.rows ?? []) as unknown[][]) {
        const name = String(r[0]);
        let key = byName.get(name);
        if (!key) {
          key =
            String(r[1]) === 'R'
              ? { name, kind: 'FK', columns: [], refTable: undefined, refColumns: [] }
              : { name, kind: 'UNIQUE', columns: [] };
          byName.set(name, key);
        }
        key.columns[Number(r[3]) - 1] = String(r[2]);
      }
      // ② 逐外键取引用侧（r_constraint_name 回链；小结果集独立查询，避免字典大视图合流）
      for (const key of byName.values()) {
        if (key.kind !== 'FK') continue;
        key.columns = key.columns.filter((c) => c !== undefined);
        const ref = await conn.execute(
          `SELECT r.table_name, rcc.column_name, rcc.position
             FROM all_constraints c
             JOIN all_constraints r
               ON r.owner = c.r_owner AND r.constraint_name = c.r_constraint_name
             JOIN all_cons_columns rcc
               ON rcc.owner = r.owner AND rcc.table_name = r.table_name AND rcc.constraint_name = r.constraint_name
            WHERE c.owner = :1 AND c.table_name = :2 AND c.constraint_name = :3
            ORDER BY rcc.position`,
          [db, obj, key.name],
        );
        const refRows = (ref.rows ?? []) as unknown[][];
        key.refTable = refRows[0]?.[0] === null || refRows[0]?.[0] === undefined ? undefined : String(refRows[0][0]);
        for (const rr of refRows) {
          key.refColumns![Number(rr[2]) - 1] = String(rr[1]);
        }
        key.refColumns = key.refColumns!.filter((c) => c !== undefined);
        keys.push(key);
      }
      for (const key of byName.values()) {
        if (key.kind === 'UNIQUE') {
          key.columns = key.columns.filter((c) => c !== undefined);
          keys.push(key);
        }
      }
      return keys;
    });
  }

  async fetchRows(req: FetchRowsRequest): Promise<ResultSet> {
    this.assertLive();
    const started = Date.now();
    const cols = await this.listColumns(req.db, req.obj);
    const typeByName = new Map(cols.map((c) => [c.name, c.normalizedType]));
    // 翻页稳定性契约（P-10）：主键升序兜底；用户 ORDER BY 片段优先（追加在其后）
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
      searchColumns: cols
        .filter((c) => c.normalizedType === 'string' || c.normalizedType === 'uuid')
        .map((c) => c.name),
      limit: req.limit,
      offset: req.offset,
      encodeParam: (col, v) => toNativeParam(col, v, typeByName),
    });

    // thin 按列取回整形（ADR D-23 岔口 6）：NUMBER → STRING（保精度，encodeCell 整形）、
    // CLOB → STRING、BLOB → BUFFER；键 = 存储列名（listColumns 已是存储形态）
    const fetchInfo = buildFetchInfo<oracledb.DbType>(cols, {
      STRING: oracledb.STRING,
      BUFFER: oracledb.BUFFER,
    });
    const outCols = req.columns && req.columns.length > 0 ? cols.filter((c) => req.columns?.includes(c.name)) : cols;
    const rs = await this.withConnection(
      (conn) => conn.execute(built.sql, built.params, { fetchInfo }),
      { timeoutMs: req.timeoutMs, signal: req.signal },
    );
    const rowsRaw = (rs.rows as unknown[][] | undefined) ?? [];
    const nameToIdx = new Map(cols.map((c, i) => [c.name, i]));
    const data = rowsRaw.map((row) =>
      outCols.map((c) => encodeCell(row[nameToIdx.get(c.name) ?? -1], c.normalizedType)),
    );
    return {
      columns: outCols.map((c) => ({ name: c.name, type: c.normalizedType })),
      rows: data,
      rowCount: data.length,
      totalCount: undefined, // 默认不做全表 COUNT（概要设计 5.4.4 / C-9）
      primaryKey: pkCols,
      executionMs: Date.now() - started,
    };
  }

  async query(req: QueryRequest): Promise<ResultSet[]> {
    const started = Date.now();
    // req.db（schema，D-23）仅作元数据绑定语境；语句原样下发——未限定名按连接用户默认 schema 解析
    const res = await this.withConnection(
      (conn) => conn.execute(req.sql, req.params ?? [], { outFormat: oracledb.OUT_FORMAT_ARRAY }),
      { timeoutMs: req.timeoutMs, signal: req.signal },
    );
    return [await mapExecuteResult(res as unknown as ExecResult, req.maxRows, Date.now() - started)];
  }

  previewChanges(db: string, obj: string, cs: ChangeSet): Promise<PreviewItem[]> {
    return this.listColumns(db, obj).then((cols) =>
      buildChangeStatements(db, obj, cs, {
        pkColumns: cols.filter((c) => c.isPrimaryKey).map((c) => c.name),
      }),
    );
  }

  /** 短事务提交（驱动规范 §8）：池 checkout 单连接承载整个批次（BEGIN 隐式于首条 DML），
   *  COMMIT/ROLLBACK 显式、归还前终结事务（ADR D-23：release 未提交即回滚，安全默认要显式化） */
  async applyChanges(db: string, obj: string, cs: ChangeSet): Promise<ApplyResult> {
    this.assertLive();
    const started = Date.now();
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
    const pool = await this.ensurePool();
    const conn = await pool.getConnection();
    try {
      conn.callTimeout = CALL_TIMEOUT_FLOOR_MS;
      const items: ApplyResult['items'] = [];
      for (const stmt of statements) {
        // RETURNING 的 out 绑定对象追加在输入 binds 尾部（占位符编号与生成层一致）
        const outCount = stmt.kind === 'insert' ? pkCols.length : 0;
        const binds: unknown[] = [...(stmt.params ?? [])];
        for (let i = 0; i < outCount; i++) {
          binds.push({ dir: oracledb.BIND_OUT, type: oracledb.STRING });
        }
        const result = await conn.execute(stmt.sql, binds, { outFormat: oracledb.OUT_FORMAT_ARRAY });
        const affected = result.rowsAffected ?? 0;
        if (stmt.kind !== 'insert' && affected !== 1) {
          throw new DriverError('E_CONFLICT', '数据已被他人修改，本次提交已回滚', {
            meta: { kind: stmt.kind, tempId: stmt.tempId, rowKey: stmt.rowKey },
          });
        }
        items.push({
          kind: stmt.kind,
          tempId: stmt.tempId,
          rowKey:
            stmt.kind === 'insert'
              ? backfillInsertKey(pkCols, result.outBinds, typeByName, cs, stmt.tempId)
              : stmt.rowKey,
          sql: stmt.sql,
          affectedRows: stmt.kind === 'insert' ? affected || 1 : affected,
        });
      }
      await conn.commit();
      return { items, executionMs: Date.now() - started };
    } catch (err) {
      // 失败必须回滚（归还带未终结事务的连接语义不明——显式回滚后归还）
      await conn.rollback().catch(() => undefined);
      throw DriverError.is(err) ? err : toDriverError(err);
    } finally {
      await conn.close().catch(() => undefined);
    }
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
    return quoteOracleIdentifier(name);
  }

  /** DDL 查看（ADR D-23 岔口 8）：DBMS_METADATA.GET_DDL + transform 减噪。transform 参数是
   *  会话级状态（P-36 同族）——在独占借出的连接上设置后同连接取 DDL、用毕归还，不污染池 */
  async getDdl(db: string, obj: string): Promise<string> {
    return this.withConnection(async (conn) => {
      const kindRes = await conn.execute(
        'SELECT object_type FROM all_objects WHERE owner = :1 AND object_name = :2',
        [db, obj],
      );
      const kindRow = (kindRes.rows as unknown[][] | undefined)?.[0];
      const objType = kindRow?.[0] === null || kindRow?.[0] === undefined ? 'TABLE' : String(kindRow[0]);
      const kind = objType === 'VIEW' ? 'VIEW' : 'TABLE';
      await conn.execute(`BEGIN
          DBMS_METADATA.SET_TRANSFORM_PARAM(DBMS_METADATA.SESSION_TRANSFORM, 'SEGMENT_ATTRIBUTES', FALSE);
          DBMS_METADATA.SET_TRANSFORM_PARAM(DBMS_METADATA.SESSION_TRANSFORM, 'STORAGE', FALSE);
          DBMS_METADATA.SET_TRANSFORM_PARAM(DBMS_METADATA.SESSION_TRANSFORM, 'TABLESPACE', FALSE);
        END;`);
      const res = await conn.execute(
        `SELECT DBMS_METADATA.GET_DDL('${kind}', :1, :2) AS ddl FROM dual`,
        [obj, db],
        { fetchInfo: { DDL: { type: oracledb.STRING } } },
      );
      const text = (res.rows as unknown[][] | undefined)?.[0]?.[0];
      return text === null || text === undefined ? `-- 对象 ${db}.${obj} 定义为空` : String(text).trim();
    });
  }

  // ── 表结构编辑（M8-B2 / ADR D-23）：生成器纯函数层（ddl.ts），执行走 query() ──

  buildCreateTable(db: string, spec: TableSpec): Promise<DdlStatement[]> {
    return Promise.resolve(buildCreateTableStatements(db, spec));
  }

  /** Oracle 约束名可从语法直达（DROP PRIMARY KEY / DROP CONSTRAINT 名）——无需 mssql 式的
   *  连接层名字预查；FK/UK 名来自 Host 基线回读（specFromTable）。
   *  连接层前置探测：Oracle 禁止同形外键重复（ORA-02275——同列引用同目标的约束全库唯一），
   *  新增外键与既有约束同形时抛 E_UNSUPPORTED（引擎边界如实声明，契约 fkAlter 探测同口径） */
  async buildAlterTable(db: string, obj: string, spec: TableSpec, current: TableSpec): Promise<DdlStatement[]> {
    const curFkNames = new Set((current.foreignKeys ?? []).map((k) => k.name));
    const addedFks = (spec.foreignKeys ?? []).filter((k) => !k.name || !curFkNames.has(k.name));
    if (addedFks.length > 0) {
      const existing = await this.withConnection(async (conn) => {
        const res = await conn.execute(
          `SELECT cc.column_name, cc.position, r.table_name AS rtable, rcc.column_name AS rcol, rcc.position AS rpos
             FROM all_constraints c
             JOIN all_cons_columns cc
               ON cc.owner = c.owner AND cc.table_name = c.table_name AND cc.constraint_name = c.constraint_name
             LEFT JOIN all_constraints r
               ON r.owner = c.r_owner AND r.constraint_name = c.r_constraint_name
             LEFT JOIN all_cons_columns rcc
               ON rcc.owner = r.owner AND rcc.table_name = r.table_name AND rcc.constraint_name = r.constraint_name
            WHERE c.owner = :1 AND c.table_name = :2 AND c.constraint_type = 'R'
            ORDER BY c.constraint_name, cc.position`,
          [db, obj],
        );
        const shapes = new Set<string>();
        const cols: string[] = [];
        const refs: string[] = [];
        let table = '';
        for (const r of (res.rows ?? []) as unknown[][]) {
          const rtable = r[2] === null || r[2] === undefined ? '' : String(r[2]);
          if (rtable !== table) {
            if (table !== '') shapes.add(fkShape(cols, table, refs));
            table = rtable;
            cols.length = 0;
            refs.length = 0;
          }
          cols[Number(r[1]) - 1] = String(r[0]);
          if (r[4] !== null && r[4] !== undefined) refs[Number(r[4]) - 1] = String(r[3]);
        }
        if (table !== '') shapes.add(fkShape(cols, table, refs));
        return shapes;
      });
      for (const fk of addedFks) {
        if (existing.has(fkShape(fk.columns, fk.refTable, fk.refColumns ?? []))) {
          throw new DriverError(
            'E_UNSUPPORTED',
            `外键 (${fk.columns.join(', ')}) → ${fk.refTable}(${(fk.refColumns ?? []).join(', ')}) 与既有约束同形——Oracle 不允许重复的引用约束（ORA-02275），请复用既有外键或改用不同列`,
          );
        }
      }
    }
    return buildAlterTableStatements(db, obj, spec, current);
  }

  dispose(): void | Promise<void> {
    if (this.disposed) {
      return Promise.resolve();
    }
    this.disposed = true;
    const pool = this.pool;
    this.pool = undefined;
    this.poolCreating = undefined;
    if (!pool) {
      return Promise.resolve();
    }
    // 会话里的活动事务由 SessionManager 先行回收；grace 0 = 立即断开剩余租借连接（幂等兜底）
    return pool.close(0).catch(() => undefined);
  }

  // ── 交互式事务会话（M7，概要 §4.6 / D-09）：单连接最多 1 个；空闲超时由 Host 侧 SessionManager 管理 ──

  private sessionConn: oracledb.Connection | null = null;

  /** 归还并终结会话连接（未提交事务随连接归还由服务端回滚——dispose 口径显式化：先 rollback） */
  private async disposeSession(): Promise<void> {
    const conn = this.sessionConn;
    if (!conn) {
      return;
    }
    this.sessionConn = null;
    await conn.rollback().catch(() => undefined);
    await conn.close().catch(() => undefined);
  }

  async openSession(): Promise<ISession> {
    this.assertLive();
    if (this.sessionConn) {
      throw new DriverError('E_VALIDATION', '已有进行中的事务会话（单连接最多 1 个）');
    }
    const pool = await this.ensurePool();
    const conn = await pool.getConnection();
    this.sessionConn = conn;
    conn.callTimeout = CALL_TIMEOUT_FLOOR_MS;
    let ended = false;
    const assertLive = (): void => {
      if (ended || this.sessionConn !== conn) {
        throw new DriverError('E_CONN', '事务会话已结束');
      }
    };
    const end = async (stmt: 'commit' | 'rollback'): Promise<void> => {
      assertLive();
      ended = true;
      this.sessionConn = null;
      try {
        await conn[stmt]();
      } finally {
        await conn.close().catch(() => undefined);
      }
    };
    const session: ISession = {
      execute: async (req) => {
        assertLive();
        const started = Date.now();
        const res = await conn
          .execute(req.sql, req.params ?? [], { outFormat: oracledb.OUT_FORMAT_ARRAY })
          .catch((err: unknown) => {
            throw toDriverError(err);
          });
        return [await mapExecuteResult(res as unknown as ExecResult, req.maxRows, Date.now() - started)];
      },
      commit: () => end('commit'),
      rollback: () => end('rollback'),
      dispose: () => {
        if (!ended) {
          return this.disposeSession(); // 未提交即放弃 → 回滚并归还
        }
        return Promise.resolve();
      },
    };
    return session;
  }
}

// ── 执行结果映射 ──────────────────────────────────────────────────────────────────────────

interface ExecMeta {
  name?: string;
  dbTypeName?: string;
}

interface ExecResult {
  rows?: unknown[][];
  metaData?: ExecMeta[];
  rowsAffected?: number;
  outBinds?: unknown;
}

/** query/会话路径结果映射：无行（非 SELECT）→ affectedRows；Lob（thin 默认取回形态）→ getData 消化 */
async function mapExecuteResult(res: ExecResult, maxRows: number, executionMs: number): Promise<ResultSet> {
  const rows = res.rows;
  if (!rows) {
    return {
      columns: [],
      rows: [],
      rowCount: 0,
      affectedRows: res.rowsAffected ?? 0,
      executionMs,
    };
  }
  const cols = (res.metaData ?? []).map((m, i) => ({
    name: m.name && m.name !== '' ? String(m.name) : `（无列名${i + 1}）`,
    type: oracleDbTypeToNormalized(m.dbTypeName),
  }));
  const sliced = rows.slice(0, maxRows);
  const data: unknown[][] = [];
  for (const row of sliced) {
    const cells: unknown[] = [];
    for (let i = 0; i < cols.length; i++) {
      cells.push(encodeCell(await materializeCell(row[i]), cols[i].type));
    }
    data.push(cells);
  }
  return {
    columns: cols,
    rows: data,
    rowCount: data.length,
    affectedRows: undefined,
    executionMs,
    truncated: rows.length > maxRows,
  };
}

/** thin 默认取回：CLOB/BLOB 为 Lob 流对象——Console 路径（列集执行前未知，无 fetchInfo）getData 消化 */
async function materializeCell(v: unknown): Promise<unknown> {
  if (v !== null && v !== undefined && typeof v === 'object' && typeof (v as { getData?: unknown }).getData === 'function') {
    const data = await (v as { getData(): Promise<string | Buffer> }).getData();
    return data ?? null;
  }
  return v;
}

/** 外键形状指纹（同形探测用）：列集 → 引用表(引用列集)，与约束名无关 */
function fkShape(columns: string[], refTable: string, refColumns: string[]): string {
  return `${columns.filter(Boolean).join(',')}->${refTable}(${refColumns.filter(Boolean).join(',')})`;
}

/** §8-3 insert 主键回填：RETURNING out 绑定原值优先，缺省回落用户携带值 */
function backfillInsertKey(
  pkCols: string[],
  outBinds: unknown,
  typeByName: Map<string, NormalizedType>,
  cs: ChangeSet,
  tempId: string | undefined,
): RowKey | undefined {
  if (pkCols.length === 0) {
    return undefined;
  }
  const binds = Array.isArray(outBinds) ? (outBinds as unknown[][]) : undefined;
  const provided = cs.inserts.find((i) => i.tempId === tempId)?.values;
  const rowKey: RowKey = {};
  for (let i = 0; i < pkCols.length; i++) {
    const pk = pkCols[i];
    const raw = binds?.[i]?.[0];
    const value = raw !== undefined && raw !== null ? raw : provided?.[pk];
    if (value === undefined || value === null) {
      continue;
    }
    rowKey[pk] = encodeCell(value, typeByName.get(pk) ?? 'unknown');
  }
  return Object.keys(rowKey).length > 0 ? rowKey : undefined;
}

export function createOracleDriver(): IDatabaseDriver {
  return {
    id: ORACLE_DRIVER_ID,
    displayName: 'Oracle',
    apiVersion: 1,
    capabilities,
    getConnectionFormSchema: () => formSchema,
    // ── 库级 DDL（M8-DBDDL / D-19 / ADR D-23）：树上「库」= schema = 用户——CREATE/DROP USER；
    //    无 buildAlterDatabase（用户不可重命名，「编辑库」菜单按方法存在性裁剪）──
    getDatabaseFormSchema: () => ({
      fields: [
        {
          key: 'name',
          label: 'Schema 名',
          type: 'string',
          required: true,
          placeholder: 'appdata',
          hint: 'Oracle「库」= schema = 用户（ADR D-23）；创建后授予最小权限（会话/建对象/视图）并配 USERS 表空间无限配额',
        },
        {
          key: 'password',
          label: '密码',
          type: 'password',
          required: true,
          hint: 'CREATE USER 必需；预览 SQL 中掩码显示，仅随执行即时使用（C-10）',
        },
      ],
    }),
    buildCreateDatabase: async (spec) => buildCreateUserStatements(spec),
    buildDropDatabase: async (db) => buildDropUserStatements(db),
    testConnection: async (cfg: ConnectionConfig, secret: string): Promise<TestResult> => {
      const started = Date.now();
      let conn: oracledb.Connection | undefined;
      try {
        conn = await oracledb.getConnection(buildConnectParams(cfg, secret));
        const res = await conn.execute('SELECT banner FROM v$version WHERE ROWNUM = 1');
        const banner = (res.rows as unknown[][] | undefined)?.[0]?.[0];
        const raw = banner !== undefined && banner !== null ? String(banner) : '';
        // 'Oracle Database 19c Enterprise Edition Release 19.0.0.0.0 - Production' → 'Oracle Database 19c'
        const version = /Oracle Database \S+/.exec(raw);
        return { ok: true, latencyMs: Date.now() - started, serverVersion: version ? version[0] : undefined };
      } catch (err) {
        return { ok: false, error: toDriverError(err) };
      } finally {
        await conn?.close().catch(() => undefined);
      }
    },
    connect: (cfg: ConnectionConfig, secret: string) => Promise.resolve(new OracleConnection(cfg, secret)),
  };
}
