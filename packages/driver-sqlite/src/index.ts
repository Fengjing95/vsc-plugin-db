import { statSync, writeFileSync, renameSync, unlinkSync, openSync, readSync, closeSync } from 'node:fs';
import {
  DriverError,
  splitSqlStatements,
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
  type IndexMeta,
  type ISession,
  type KeyMeta,
  type ObjectMeta,
  type PreviewItem,
  type QueryRequest,
  type ResultSet,
  type RowKey,
  type TableSpec,
  type TestResult,
} from '@db-explorer/core';
// 方言词表（C-14/规范 §3.2：SQLite 全量 keywords/functions/snippets，勿散落 index.ts）
import { COMPLETION_SNIPPETS, DATA_TYPES, FUNCTIONS, KEYWORDS } from './completion';
import { buildChangeStatements } from './changes';
import { buildAlterTableStatements, buildCreateTableStatements } from './ddl';
import { toDriverError } from './errors';
import {
  buildSelect,
  encodeCell,
  fragmentHasColumn,
  isMutatingSql,
  normalizeSqliteType,
  quoteIdentifier,
  quoteStringLiteral,
  toNativeParam,
  unquoteDdlDefault,
  valueToNormalizedType,
} from './sql';
import { openEngine, resolveDbPath, validateSqliteFile, type EngineQueryResult, type SqliteEngine } from './engine';

/**
 * SQLite 驱动（sql.js WASM 单引擎，D-16）：整库载入内存、同步执行，限用中小库（建议 ≤ 100MB）。
 * M8-SQLite 交付：连接/测试（文件校验）、元数据自省（sqlite_master + PRAGMA）、分页取数、
 * 参数化筛选下推、变更集（短事务 + RETURNING 回填 + 字段级乐观锁）、写批次后原子落盘、
 * DDL 生成器（含 SQLite 表重建序列）、交互式事务会话。
 * db 语义（D-16）：单文件单库，db 参数恒 'main'；无认证字段，secret 恒空串。
 */
export const SQLITE_DRIVER_ID = 'sqlite';

/** SQLite 逻辑主库名（listDatabases 单节点） */
export const SQLITE_MAIN_DB = 'main';

const capabilities: DriverCapabilities = {
  supportsSQL: true,
  supportsTransaction: true,
  supportsInteractiveTransaction: true, // openSession（SessionManager 空闲超时回收，§4.6/D-09）
  supportsMultipleDatabases: false, // 单文件单库（D-16）
  supportsMultiStatement: false, // Console 按单语句执行（对齐 mysql/pg 口径，同步引擎收紧注入面）
  supportsCancel: false, // 同步引擎不可中断（D-16；契约组按此跳过取消组）
  supportsDdl: true,
  supportsDdlEditor: true, // buildCreateTable/buildAlterTable（DDL 走 query() 执行）
  supportsErDiagram: true, // M8-ER（概要 §5.11 / D-22）：listKeys FK 元数据完整——ER 关系收集消费者
  // 表设计器批次 B（交互稿 §12.2 能力矩阵）：唯一键 alter 走表重建序列；外键 alter 无原地语法
  // → foreignKeyAlter: false（UI alter 态外键 Tab 只读 + 提示，驱动 fail-closed E_UNSUPPORTED）
  tableDesign: {
    uniqueKeys: true,
    foreignKeys: true,
    foreignKeyAlter: false,
    indexes: true,
  },
  hierarchy: ['connection', 'database', 'folder', 'table', 'view', 'column', 'key', 'index'],
  editable: true,
  pagination: 'offset',
};

const formSchema: FormSchema = {
  fields: [
    {
      key: 'path',
      label: '数据库文件路径',
      type: 'file', // file 控件（首次落地）：输入框 + 「浏览…」原生选择，输入保持可手输（§5.4）
      required: true,
      placeholder: '~/data/app.db',
      hint: 'SQLite 单文件数据库；支持 ~（主目录）与相对工作区路径；文件必须已存在（不会自动创建）',
    },
    {
      key: 'readonly',
      label: '以只读打开',
      type: 'boolean',
      default: false,
      group: '高级',
      hint: '只读模式下拒绝写入语句，且永不写回文件',
    },
  ],
};

export interface SqliteDriverOptions {
  /** sql-wasm.wasm 路径（extension 从 media/ 传入；缺省经 require.resolve 兜底，仅测试/脚本场景可达） */
  wasmPath?: string;
  /** 路径展开（extension 注入：~/ 与相对工作区路径）；缺省 ~ 展开 + 相对路径按 cwd */
  resolvePath?: (raw: string) => string;
}

export function createSqliteDriver(options?: SqliteDriverOptions): IDatabaseDriver {
  return {
    id: SQLITE_DRIVER_ID,
    displayName: 'SQLite',
    apiVersion: 1,
    capabilities,
    getConnectionFormSchema: () => formSchema,
    testConnection: async (cfg: ConnectionConfig): Promise<TestResult> => {
      const started = Date.now();
      try {
        const path = resolveDbPath(String(cfg.options.path ?? ''), options?.resolvePath);
        validateSqliteFile(path);
        return { ok: true, latencyMs: Date.now() - started, serverVersion: readHeaderVersion(path) };
      } catch (err) {
        return { ok: false, error: toDriverError(err) };
      }
    },
    connect: (cfg: ConnectionConfig, _secret: string) => openConnection(cfg, options ?? {}),
  };
}

async function openConnection(cfg: ConnectionConfig, options: SqliteDriverOptions): Promise<IConnection> {
  const conn = new SqliteConnection(cfg, options);
  await conn.open();
  return conn;
}

/** 文件头偏移 96 的 4 字节 = 写入该库的 SQLite 版本号（如 3049001 → '3.49.1'）；空库无版本 */
function readHeaderVersion(path: string): string | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const buf = Buffer.alloc(100);
    const read = readSync(fd, buf, 0, 100, 0);
    if (read < 100) {
      return undefined;
    }
    const n = buf.readUInt32BE(96);
    if (n < 3_000_000 || n >= 4_000_000) {
      return undefined;
    }
    return `${Math.floor(n / 1_000_000)}.${Math.floor((n % 1_000_000) / 1_000)}.${n % 1_000}`;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      closeSync(fd);
    }
  }
}

/** PRAGMA 行（数组行 + 列名）→ 对象行（自省可读性） */
function rowsByName(res: EngineQueryResult): Array<Record<string, unknown>> {
  return res.rows.map((row) => Object.fromEntries(res.columns.map((c, i) => [c, row[i]])));
}

export class SqliteConnection implements IConnection {
  readonly connectionId: string;
  private engine: SqliteEngine | null = null;
  private dbPath = '';
  private readonly readOnly: boolean;
  private readonly wasmPath?: string;
  private readonly resolvePathFn?: (raw: string) => string;
  private dirty = false;
  private disposed = false;
  /** 活动交互式事务深度（0/1）：>0 时一切落盘动作推迟到 commit（未提交数据不得泄漏到文件） */
  private txDepth = 0;
  private session: SqliteSession | null = null;

  get dialect(): DialectInfo {
    return { id: 'sqlite', quote: ['"', '"'], formatter: 'sqlite', keywords: KEYWORDS, functions: FUNCTIONS };
  }

  constructor(private readonly cfg: ConnectionConfig, options: SqliteDriverOptions) {
    this.connectionId = cfg.id;
    this.readOnly = cfg.options.readonly === true;
    this.wasmPath = options.wasmPath;
    this.resolvePathFn = options.resolvePath;
  }

  /** 建连入口（createSqliteDriver.connect 调用）：文件校验 + 引擎初始化 */
  async open(): Promise<void> {
    await this.ensureOpen();
  }

  private assertLive(): void {
    if (this.disposed) {
      throw new DriverError('E_CONN', '连接已关闭');
    }
  }

  private async ensureOpen(): Promise<SqliteEngine> {
    this.assertLive();
    if (this.engine) {
      return this.engine;
    }
    const raw = String(this.cfg.options.path ?? '');
    if (!raw.trim()) {
      throw new DriverError('E_VALIDATION', '缺少数据库文件路径（path）');
    }
    this.dbPath = resolveDbPath(raw, this.resolvePathFn);
    try {
      this.engine = await openEngine(this.dbPath, { readOnly: this.readOnly, wasmPath: this.wasmPath });
    } catch (err) {
      throw DriverError.is(err) ? err : toDriverError(err);
    }
    return this.engine;
  }

  /** 语句执行统一入口：错误映射 + 脏标记 + 只读写入拒绝（isMutatingSql 口径见 sql.ts） */
  private async run(sql: string, params?: unknown[]): Promise<EngineQueryResult> {
    const engine = await this.ensureOpen();
    if (this.readOnly && isMutatingSql(sql)) {
      throw new DriverError('E_READONLY', '数据库以只读方式打开，拒绝写入');
    }
    let res: EngineQueryResult;
    try {
      res = engine.query(sql, params);
    } catch (err) {
      throw toDriverError(err);
    }
    if (res.changes > 0 || isMutatingSql(sql)) {
      this.dirty = true;
    }
    return res;
  }

  /** 写批次落盘（D-16）：整库序列化 → 临时文件 → rename 原子覆写；事务内/只读不落盘 */
  private flushToDisk(): void {
    if (!this.dirty || this.readOnly || this.txDepth > 0) {
      return;
    }
    const engine = this.engine;
    if (!engine) {
      return;
    }
    const tmp = `${this.dbPath}.dbx-${process.pid}.tmp`;
    try {
      writeFileSync(tmp, engine.exportBytes());
      renameSync(tmp, this.dbPath);
      this.dirty = false;
    } catch (err) {
      try {
        unlinkSync(tmp);
      } catch {
        // 清理尽力而为
      }
      throw toDriverError(err);
    }
  }

  async ping(): Promise<void> {
    this.assertLive();
    await this.run('SELECT 1');
  }

  /** D-16：单文件单库，恒 main（sizeBytes 取文件体积，不执行 COUNT） */
  async listDatabases(): Promise<DatabaseMeta[]> {
    this.assertLive();
    await this.ensureOpen();
    let sizeBytes: number | undefined;
    try {
      sizeBytes = statSync(this.dbPath).size;
    } catch {
      sizeBytes = undefined;
    }
    return [{ name: SQLITE_MAIN_DB, sizeBytes }];
  }

  async listObjects(db: string): Promise<ObjectMeta[]> {
    this.assertLive();
    void db;
    const res = await this.run(
      `SELECT name, type FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name`,
    );
    return res.rows.map((r) => ({
      name: String(r[0]),
      kind: r[1] === 'view' ? ('view' as const) : ('table' as const),
    }));
  }

  async listColumns(db: string, obj: string): Promise<ColumnMeta[]> {
    this.assertLive();
    void db;
    const res = await this.run(`PRAGMA table_info(${quoteIdentifier(obj)})`);
    const pkEntries = rowsByName(res)
      .filter((r) => Number(r.pk) > 0)
      .sort((a, b) => Number(a.pk) - Number(b.pk));
    const singleIntPk =
      pkEntries.length === 1 && String(pkEntries[0].type ?? '').trim().toUpperCase() === 'INTEGER';
    return rowsByName(res).map((r) => ({
      name: String(r.name),
      dataType: String(r.type ?? ''),
      normalizedType: normalizeSqliteType(String(r.type ?? '')),
      nullable: Number(r.notnull) === 0,
      isPrimaryKey: Number(r.pk) > 0,
      // INTEGER PRIMARY KEY（rowid 别名，单列主键）即自增（§5.4）
      autoIncrement: singleIntPk && Number(r.pk) > 0,
      defaultValue: unquoteDdlDefault(r.dflt_value),
      ordinal: Number(r.cid) + 1,
    }));
  }

  async listIndexes(db: string, obj: string): Promise<IndexMeta[]> {
    this.assertLive();
    void db;
    const res = await this.run(`PRAGMA index_list(${quoteIdentifier(obj)})`);
    const out: IndexMeta[] = [];
    for (const r of rowsByName(res)) {
      const name = String(r.name);
      // 跳过内部自动索引（主键/唯一约束的 sqlite_autoindex_*，键信息走 listKeys）
      if (name.startsWith('sqlite_') || r.origin === 'pk') {
        continue;
      }
      const cols = await this.run(`PRAGMA index_info(${quoteIdentifier(name)})`);
      out.push({
        name,
        columns: cols.rows.map((cr) => String(cr[2])).filter((c) => c !== 'null' && c.length > 0),
        unique: Number(r.unique) === 1,
      });
    }
    return out;
  }

  async listKeys(db: string, obj: string): Promise<KeyMeta[]> {
    this.assertLive();
    void db;
    const keys: KeyMeta[] = [];
    const cols = await this.listColumns(db, obj);
    const pkCols = cols.filter((c) => c.isPrimaryKey).map((c) => c.name);
    if (pkCols.length > 0) {
      keys.push({ name: `${obj}_pkey`, kind: 'PK', columns: pkCols });
    }

    // FK：PRAGMA foreign_key_list（id 分组、seq 定序；SQLite 外键匿名 → 合成名）
    const fks = rowsByName(await this.run(`PRAGMA foreign_key_list(${quoteIdentifier(obj)})`));
    const fkGroups = new Map<number, Array<Record<string, unknown>>>();
    for (const r of fks) {
      const id = Number(r.id);
      const group = fkGroups.get(id) ?? [];
      group.push(r);
      fkGroups.set(id, group);
    }
    for (const [id, group] of [...fkGroups.entries()].sort((a, b) => a[0] - b[0])) {
      const ordered = group.sort((a, b) => Number(a.seq) - Number(b.seq));
      keys.push({
        name: `${obj}_fk_${id}`,
        kind: 'FK',
        columns: ordered.map((r) => String(r.from)),
        refTable: String(ordered[0].table),
        refColumns: ordered.map((r) => String(r.to)),
      });
    }

    // UNIQUE：index_list origin='u'（主键自动索引已在上面以 PK 呈现）
    const idxRes = rowsByName(await this.run(`PRAGMA index_list(${quoteIdentifier(obj)})`));
    for (const r of idxRes.filter((x) => x.origin === 'u')) {
      const name = String(r.name);
      const colsRes = await this.run(`PRAGMA index_info(${quoteIdentifier(name)})`);
      keys.push({
        name,
        kind: 'UNIQUE',
        columns: colsRes.rows.map((cr) => String(cr[2])).filter((c) => c.length > 0),
      });
    }
    return keys;
  }

  async fetchRows(req: FetchRowsRequest): Promise<ResultSet> {
    this.assertLive();
    const started = Date.now();
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
        // search 走 instr 子串匹配：限定 string/uuid 列（§5.4：大小写敏感、无通配符语义）
        searchColumns: cols
          .filter((c) => c.normalizedType === 'string' || c.normalizedType === 'uuid')
          .map((c) => c.name),
        limit: req.limit,
        offset: req.offset,
        encodeParam: (col, v) => toNativeParam(col, v, typeByName),
      });
      const res = await this.run(built.sql, built.params);
      const outCols =
        req.columns && req.columns.length > 0
          ? cols.filter((c) => req.columns?.includes(c.name))
          : cols;
      const data = res.rows.map((r) => outCols.map((c, i) => encodeCell(r[i], c.normalizedType)));
      return {
        columns: outCols.map((c) => ({ name: c.name, type: c.normalizedType })),
        rows: data,
        rowCount: data.length,
        totalCount: undefined, // 默认不做全表 COUNT（概要设计 5.4.4 / C-9）
        primaryKey: pkCols,
        executionMs: Date.now() - started,
      };
    } catch (err) {
      throw DriverError.is(err) ? err : toDriverError(err);
    }
  }

  async query(req: QueryRequest): Promise<ResultSet[]> {
    this.assertLive();
    const started = Date.now();
    try {
      // supportsMultiStatement=false（D-16）：防御性拒绝多语句（Console 常规路径已由 Host 切分）
      if (splitSqlStatements(req.sql).length > 1) {
        throw new DriverError('E_SYNTAX', '一次只能执行一条语句（SQLite 驱动未开启多语句）');
      }
      const res = await this.run(req.sql, req.params ?? []);
      this.flushToDisk(); // 写批次后原子落盘（只读/事务内自动跳过）
      const types = res.columns.map((_, i) => valueToNormalizedType(res.rows[0]?.[i]));
      const sliced = res.rows.slice(0, req.maxRows);
      const resultSet: ResultSet = {
        columns: res.columns.map((name, i) => ({ name, type: types[i] ?? 'unknown' })),
        rows: sliced.map((r) => r.map((v, i) => encodeCell(v, types[i] ?? 'unknown'))),
        rowCount: sliced.length,
        affectedRows: res.rows.length === 0 ? res.changes : undefined,
        executionMs: Date.now() - started,
        truncated: res.rows.length > req.maxRows,
      };
      return [resultSet];
    } catch (err) {
      throw DriverError.is(err) ? err : toDriverError(err);
    }
  }

  previewChanges(db: string, obj: string, cs: ChangeSet): Promise<PreviewItem[]> {
    if (cs.inserts.length === 0 && cs.updates.length === 0 && cs.deletes.length === 0) {
      return Promise.resolve([]); // 空变更集短路：不触达表（P-19 探测路径友好）
    }
    return this.listColumns(db, obj).then((cols) =>
      buildChangeStatements(db, obj, cs, {
        pkColumns: cols.filter((c) => c.isPrimaryKey).map((c) => c.name),
      }),
    );
  }

  /** 短事务提交（驱动规范 §8）：BEGIN…COMMIT，任一 rowCount ≠ 1 → E_CONFLICT 回滚 + 整批不落盘 */
  async applyChanges(db: string, obj: string, cs: ChangeSet): Promise<ApplyResult> {
    this.assertLive();
    const started = Date.now();
    try {
      if (cs.inserts.length === 0 && cs.updates.length === 0 && cs.deletes.length === 0) {
        return { items: [], executionMs: 0 };
      }
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
      await this.run('BEGIN');
      const items: ApplyResult['items'] = [];
      try {
        for (const stmt of statements) {
          const res = await this.run(stmt.sql, stmt.params);
          // INSERT 经 RETURNING 行数（=影响行数）；UPDATE/DELETE 经 changes()
          const affectedRows = stmt.kind === 'insert' ? res.rows.length : res.changes;
          if (affectedRows !== 1) {
            throw new DriverError('E_CONFLICT', '数据已被他人修改，本次提交已回滚', {
              meta: { kind: stmt.kind, tempId: stmt.tempId, rowKey: stmt.rowKey },
            });
          }
          items.push({
            kind: stmt.kind,
            tempId: stmt.tempId,
            rowKey: stmt.kind === 'insert' ? this.backfillInsertKey(pkCols, res, cs, stmt.tempId) : stmt.rowKey,
            sql: stmt.sql,
            affectedRows,
          });
        }
        await this.run('COMMIT');
      } catch (err) {
        await this.run('ROLLBACK').catch(() => undefined);
        this.dirty = false; // 回滚后内存 == 磁盘
        throw err;
      }
      this.flushToDisk(); // 写批次原子落盘（D-16）
      return { items, executionMs: Date.now() - started };
    } catch (err) {
      throw DriverError.is(err) ? err : toDriverError(err);
    }
  }

  /** insert 主键回填（§8-3）：RETURNING 主键列原值，经值编码契约整形（BigInt 安全转数值/字符串） */
  private backfillInsertKey(
    pkCols: string[],
    res: EngineQueryResult,
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
      const idx = res.columns.indexOf(pk);
      const value = row && idx >= 0 && row[idx] !== undefined && row[idx] !== null ? row[idx] : provided?.[pk];
      if (value === undefined || value === null) {
        continue;
      }
      // 主键值走通用整形（BigInt→安全数值/字符串、Uint8Array→base64、其余透传）
      rowKey[pk] = encodeCell(value, 'unknown');
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
      databases: [SQLITE_MAIN_DB],
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
    return quoteIdentifier(name);
  }

  /** DDL 查看：sqlite_master 保存原始建表语句（含视图） */
  async getDdl(db: string, obj: string): Promise<string> {
    this.assertLive();
    void db;
    const res = await this.run(`SELECT sql FROM sqlite_master WHERE name = ${quoteStringLiteral(obj)}`);
    const sql = res.rows[0]?.[0];
    if (typeof sql !== 'string' || sql.trim().length === 0) {
      throw new DriverError('E_NOT_FOUND', `表 "${obj}" 不存在或无 DDL`);
    }
    return sql;
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
    // 活动交互式事务随连接 dispose 回滚释放（防悬挂事务；未提交数据不落盘）
    const rollback = this.session ? this.session.dispose() : Promise.resolve();
    this.session = null;
    this.txDepth = 0;
    return Promise.resolve(rollback)
      .catch(() => undefined)
      .then(() => {
        this.engine?.close();
        this.engine = null;
      });
  }

  // ── 交互式事务会话（M7，概要 §4.6 / D-09）：单连接最多 1 个；空闲超时由 Host 侧 SessionManager 管理 ──

  openSession(): Promise<ISession> {
    this.assertLive();
    if (this.session) {
      return Promise.reject(new DriverError('E_VALIDATION', '已有进行中的事务会话（单连接最多 1 个）'));
    }
    return (async () => {
      await this.ensureOpen();
      if (this.readOnly) {
        throw new DriverError('E_READONLY', '数据库以只读方式打开，拒绝写入');
      }
      await this.run('BEGIN');
      this.txDepth = 1;
      const session = new SqliteSession(this);
      this.session = session;
      return session;
    })();
  }

  /** 会话内语句执行（同 query 语义；落盘由 commit 统一收口） */
  async queryInSession(req: QueryRequest): Promise<ResultSet[]> {
    return this.query(req);
  }

  async commitSession(): Promise<void> {
    this.assertLive();
    try {
      await this.run('COMMIT');
    } finally {
      this.txDepth = 0;
      this.session = null;
    }
    this.flushToDisk(); // commit 落库即落盘（D-16；对其他连接可见）
  }

  async rollbackSession(): Promise<void> {
    this.assertLive();
    try {
      await this.run('ROLLBACK');
    } finally {
      this.txDepth = 0;
      this.session = null;
      this.dirty = false; // 回滚后内存 == 磁盘
    }
  }
}

/** 交互式事务会话（单连接 1 个）：BEGIN…COMMIT/ROLLBACK；dispose 未提交即回滚 */
class SqliteSession implements ISession {
  private ended = false;

  constructor(private readonly conn: SqliteConnection) {}

  private assertLive(): void {
    if (this.ended) {
      throw new DriverError('E_CONN', '事务会话已结束');
    }
  }

  execute(req: QueryRequest): Promise<ResultSet[]> {
    this.assertLive();
    return this.conn.queryInSession(req);
  }

  commit(): Promise<void> {
    this.assertLive();
    this.ended = true;
    return this.conn.commitSession();
  }

  rollback(): Promise<void> {
    this.assertLive();
    this.ended = true;
    return this.conn.rollbackSession();
  }

  dispose(): void | Promise<void> {
    if (this.ended) {
      return Promise.resolve();
    }
    this.ended = true;
    return this.conn.rollbackSession().catch(() => undefined);
  }
}
