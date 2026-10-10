import { MongoClient, type Db, type MongoClientOptions } from 'mongodb';
import {
  DriverError,
  isProvablyReadMongoCommand,
  parseMongoChain,
  parseMongoUse,
  splitMongoCommandLines,
  type ApplyResult,
  type ChangeSet,
  type DatabaseSpec,
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
  type ObjectMeta,
  type PreviewItem,
  type QueryRequest,
  type ResultSet,
  type TestResult,
} from '@db-explorer/core';
import { bsonDataTypeOf, columnsFromDocs, encodeValue, normalizedOf } from './document';
import { buildFilterDoc, buildSearchDoc, buildSortDoc, type ColumnTypes, type Filter } from './filter';
import { decodeCursorOrThrow, encodeCursor, resumeFilter } from './cursor';
import { parseMongoArgs } from './commands';
import { buildChangeOps } from './changes';
import { mongoCompletionSource } from './completion';
import { toMongoError } from './errors';

/**
 * MongoDB 驱动（官方 mongodb，M8-Mongo / D-17）。
 * 交付范围（概要设计 §10 / 驱动规范 §5.5）：
 * - 树：库（系统库过滤）→ Collections 目录 → collection → 字段（采样推断动态列）/ 索引目录
 * - fetchRows：文档浏览（cursor 游标，_id resume；offset 翻译 skip）；FilterOp/search 查询文档下推
 * - 命令控制台：mongosh 命令域（每行一条），首批只读——非读命令一律 E_UNSUPPORTED（白名单在 core）
 * - 动态列：_id 恒为首列；字段缺失 = NULL 语义；嵌套 → json（C-7）
 */

export const MONGO_DRIVER_ID = 'mongodb';

const capabilities: DriverCapabilities = {
  supportsSQL: false, // mongosh 命令控制台（core 命令白名单 §5.5）
  supportsTransaction: false, // 多文档事务需副本集（standalone 不支持）：逐条 + 失败即停（D-18，§8-5）
  supportsInteractiveTransaction: false,
  supportsMultipleDatabases: true,
  supportsMultiStatement: false, // 命令控制台逐条执行（core 按行切分）
  supportsCancel: true, // 官方驱动操作经 AbortSignal 可中止（契约组 $where 忙循环实跑为准）
  supportsDdl: false,
  // hierarchy 含 column → 树为 collection 节点展开「字段/索引」目录（treeDataProvider 数据驱动）
  hierarchy: ['connection', 'database', 'folder', 'collection', 'column'],
  editable: true, // D-18：字段级 $set 乐观锁（表格编辑；危险/只读护栏在 Host 侧）
  supportsDatabaseDdl: true, // M8-DBDDL / D-19 及修订：建库（首个 collection 隐式创建）+ dropDatabase；无编辑
  pagination: 'cursor',
};

const formSchema: FormSchema = {
  fields: [
    { key: 'host', label: '主机', type: 'string', required: true, placeholder: '127.0.0.1', validator: 'host' },
    { key: 'port', label: '端口', type: 'number', required: true, default: 27017, validator: 'port' },
    { key: 'username', label: '用户名（可选）', type: 'string' },
    { key: 'password', label: '密码', type: 'password', hint: '留空 = 免认证实例' },
    { key: 'authDatabase', label: '认证库（authSource）', type: 'string', default: 'admin' },
    {
      key: 'database',
      label: '默认库（可选）',
      type: 'string',
      dynamicOptions: 'databases',
      hint: '树上的「库」为 MongoDB database（非库内 schema）',
    },
    {
      key: 'directConnection',
      label: '单机直连',
      type: 'boolean',
      default: true,
      group: '高级',
      hint: 'IP 直连目标的最稳口径；副本集自动发现可关闭',
    },
    {
      key: 'connectTimeout',
      label: '连接超时（ms）',
      type: 'number',
      default: 10000,
      group: '高级',
    },
  ],
};

/** 动态列采样上限（D-17：顶层字段并集按前 N 篇推断） */
const SAMPLE_DOCS = 200;
/** 系统库（listDatabases 过滤） */
const SYSTEM_DBS = new Set(['admin', 'config', 'local']);

/** 命令控制台放行的文档写方法（D-18：经 Host 危险判定链后可执行；结构类恒不支持。
 *  D-19 修订：dropDatabase 放行——树删库与命令行同一护栏（危险横幅/prod Modal/只读拒）；
 *  D-19 修订 2：createCollection 放行——树建库（首个 collection 隐式建库）与命令行同一护栏 */
const DOC_WRITE_METHODS: ReadonlySet<string> = new Set([
  'insertOne', 'insertMany', 'updateOne', 'updateMany', 'replaceOne',
  'deleteOne', 'deleteMany', 'findOneAndUpdate', 'findOneAndReplace', 'findOneAndDelete',
  'dropDatabase', 'createCollection',
]);

/** Mongo 库名校验（D-19 删库/建库）：禁 / \ " $ 与空字符，≤63 字节（Mongo 命名约束） */
function assertMongoDbName(db: string): string {
  if (!db || /[/$"\\\0]/.test(db) || db.includes('/') || db.length > 63) {
    throw new DriverError('E_VALIDATION', `非法库名："${db.slice(0, 32)}"（禁 / \\ " $ 与空字符，≤63 字符）`);
  }
  return db;
}

/** Mongo collection 名校验（D-19 建库）：禁 $ 与空字符，≤120 字符 */
function assertMongoCollectionName(name: string): string {
  if (!name || /[$\0]/.test(name) || name.length > 120) {
    throw new DriverError('E_VALIDATION', `非法 collection 名："${name.slice(0, 32)}"（禁 $ 与空字符，≤120 字符）`);
  }
  return name;
}

type RawDoc = Record<string, unknown>;

function clientOptions(cfg: ConnectionConfig): MongoClientOptions {
  return { serverSelectionTimeoutMS: Number(cfg.options.connectTimeout ?? 10_000) };
}

/** 连接串构建：options.uri 直连串优先（契约/高级用法）；否则按分字段拼 mongodb://（C-10：密码只经 secret） */
function buildMongoUri(cfg: ConnectionConfig, secret: string): string {
  const o = cfg.options;
  if (typeof o.uri === 'string' && o.uri.trim() !== '') {
    return o.uri.trim();
  }
  const host = String(o.host ?? '127.0.0.1');
  const port = Number(o.port ?? 27017);
  const creds = o.username ? `${encodeURIComponent(String(o.username))}:${encodeURIComponent(secret)}@` : '';
  const authDb = o.authDatabase ? encodeURIComponent(String(o.authDatabase)) : 'admin';
  const dbName = o.database ? `/${encodeURIComponent(String(o.database))}` : '';
  const params = new URLSearchParams({ authSource: authDb });
  if (o.directConnection !== false) {
    params.set('directConnection', 'true');
  }
  return `mongodb://${creds}${host}:${port}${dbName}?${params.toString()}`;
}

/** mongosh find 第二参的 sort：对象 {f: ±1} 或 [key, dir] 数组 → FindOptions.sort 形状 */
function normalizeSortSpec(input: unknown): Record<string, 1 | -1> | undefined {
  if (Array.isArray(input)) {
    const out: Record<string, 1 | -1> = {};
    for (const pair of input as Array<[string, number]>) {
      out[String(pair[0])] = pair[1] < 0 ? -1 : 1;
    }
    return Object.keys(out).length > 0 ? out : undefined;
  }
  if (input && typeof input === 'object') {
    const out: Record<string, 1 | -1> = {};
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      out[k] = Number(v) < 0 ? -1 : 1;
    }
    return Object.keys(out).length > 0 ? out : undefined;
  }
  return undefined;
}

/** 写命令第三参 options：仅识别 upsert（其余忽略） */
function writeOptions(input: unknown): { upsert?: boolean } {
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    return (input as Record<string, unknown>).upsert === true ? { upsert: true } : {};
  }
  return {};
}

/** 文档数组 → 动态列表格（columns 取前 100 篇样本保证列集稳定，rows 全量编码） */
function tabularFromDocs(docs: RawDoc[], executionMs: number, opts?: { truncated?: boolean }): ResultSet {
  const cols = columnsFromDocs(docs.slice(0, 100));
  return {
    columns: cols.map((c) => ({ name: c.name, type: c.normalizedType })),
    rows: docs.map((doc) => cols.map((c) => encodeValue(doc[c.name]))),
    rowCount: docs.length,
    primaryKey: docs.some((d) => '_id' in d) ? ['_id'] : undefined,
    truncated: opts?.truncated,
    executionMs,
  };
}

function objectToRows(obj: unknown, executionMs: number): ResultSet {
  const entries = obj && typeof obj === 'object' && !Array.isArray(obj)
    ? Object.entries(obj as RawDoc)
    : [];
  return {
    columns: [
      { name: 'key', type: 'string' },
      { name: 'value', type: 'json' },
    ],
    rows: entries.map(([k, v]) => [k, encodeValue(v)]),
    rowCount: entries.length,
    executionMs,
  };
}

function scalarRs(name: string, type: 'integer' | 'string' | 'json', value: unknown, executionMs: number): ResultSet {
  return {
    columns: [{ name, type }],
    rows: [[value]],
    rowCount: 1,
    executionMs,
  };
}

export class MongoConnection implements IConnection {
  readonly connectionId: string;
  private client?: MongoClient;
  private connecting?: Promise<MongoClient>;
  private disposed = false;

  constructor(
    private readonly cfg: ConnectionConfig,
    private readonly secret: string,
  ) {
    this.connectionId = cfg.id;
  }

  private assertOpen(): void {
    if (this.disposed) {
      throw new DriverError('E_CONN', '连接已关闭', { detail: 'dispose 后不可再调用' });
    }
  }

  private db(name?: string): Db {
    const client = this.client;
    if (!client) {
      throw new DriverError('E_CONN', '连接未就绪');
    }
    return client.db(name && name.trim() !== '' ? name : String(this.cfg.options.database ?? 'test'));
  }

  private async getClient(): Promise<MongoClient> {
    this.assertOpen();
    if (!this.connecting) {
      this.connecting = this.newClientTask();
    }
    const client = await this.connecting;
    this.client = client;
    return client;
  }

  private async newClientTask(): Promise<MongoClient> {
    try {
      const client = new MongoClient(buildMongoUri(this.cfg, this.secret), clientOptions(this.cfg));
      await client.connect();
      return client;
    } catch (err) {
      this.connecting = undefined; // 失败清理：下次调用重试建连（P-30 同族：不留毒化 promise）
      throw toMongoError(err);
    }
  }

  /** 超时/取消守卫（驱动规范 §7）：race 死线 + AbortSignal → E_TIMEOUT/E_CANCELED；
   *  被 race 掉的底层 promise 必须吞掉后续 rejection（防毒化进程，P-30/P-46 同族） */
  private guard<T>(promise: Promise<T>, timeoutMs: number, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) {
      return Promise.reject(new DriverError('E_CANCELED', '已取消'));
    }
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const swallow = (): void => {
        promise.then(
          () => undefined,
          () => undefined,
        );
      };
      const timer = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        swallow();
        reject(new DriverError('E_TIMEOUT', `操作超时（${timeoutMs}ms），可在设置中调整`));
      }, Math.max(timeoutMs, 1));
      signal?.addEventListener(
        'abort',
        () => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timer);
          swallow();
          reject(new DriverError('E_CANCELED', '已取消'));
        },
        { once: true },
      );
      promise.then(
        (v) => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            resolve(v);
          }
        },
        (e) => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            reject(toMongoError(e));
          }
        },
      );
    });
  }

  async ping(): Promise<void> {
    this.assertOpen();
    const client = await this.getClient();
    await this.guard(client.db('admin').command({ ping: 1 }), 10_000);
  }

  async listDatabases(): Promise<DatabaseMeta[]> {
    this.assertOpen();
    const client = await this.getClient();
    const reply = await this.guard(
      client.db('admin').command({ listDatabases: 1, nameOnly: false, authorizedDatabases: true }),
      15_000,
    );
    const dbs = (reply as { databases?: Array<{ name: string; sizeOnDisk?: number }> }).databases ?? [];
    return dbs
      .filter((x) => !SYSTEM_DBS.has(x.name))
      .map((x) => ({ name: x.name, sizeBytes: x.sizeOnDisk }));
  }

  async listObjects(db: string): Promise<ObjectMeta[]> {
    this.assertOpen();
    await this.getClient(); // db() 依赖懒连接句柄（P-30 同族：入口统一 ensure）
    const infos = await this.guard(
      this.db(db)
        .listCollections({}, { nameOnly: false, authorizedCollections: true })
        .toArray(),
      15_000,
    );
    return infos
      .filter((i) => !i.name.startsWith('system.'))
      .map((i) => ({
        name: i.name,
        kind: i.type === 'view' ? ('view' as const) : ('collection' as const),
        schema: 'Collections', // 树目录分组 id（treeDataProvider 据 ObjectMeta.schema 归组）
      }));
  }

  async listColumns(db: string, obj: string): Promise<ColumnMeta[]> {
    this.assertOpen();
    await this.getClient();
    const database = this.db(db);
    const exists = await this.guard(
      database.listCollections({ name: obj }, { nameOnly: true, authorizedCollections: true }).hasNext(),
      15_000,
    );
    if (!exists) {
      throw new DriverError('E_NOT_FOUND', `collection "${obj}" 不存在`);
    }
    const docs = await this.guard(database.collection(obj).find({}).limit(SAMPLE_DOCS).toArray(), 15_000);
    return columnsFromDocs(docs as RawDoc[]);
  }

  async listIndexes(db: string, obj: string): Promise<IndexMeta[]> {
    this.assertOpen();
    const idx = await this.guard(this.db(db).collection(obj).listIndexes().toArray(), 15_000);
    return idx.map((i) => ({
      name: String(i.name),
      columns: Object.keys(i.key ?? {}),
      unique: Boolean(i.unique),
      type: i.textIndexVersion !== undefined ? 'text' : undefined,
    }));
  }

  async fetchRows(req: FetchRowsRequest): Promise<ResultSet> {
    this.assertOpen();
    await this.getClient(); // 懒连接（db() 句柄依赖）
    if (req.whereSql?.trim()) {
      throw new DriverError('E_VALIDATION', 'MongoDB 取数不支持 WHERE 片段（可用筛选条件与全局搜索）');
    }
    if (req.orderBySql?.trim()) {
      throw new DriverError('E_VALIDATION', 'MongoDB 取数不支持 ORDER BY 片段');
    }
    const started = Date.now();
    const coll = this.db(req.db).collection(req.obj);
    const state = req.cursor ? decodeCursorOrThrow(req.cursor) : undefined;

    // 筛选值转换需要采样列类型（objectId/date/decimal…回 BSON 原生值，§5.5）
    const needsTypes = (req.filters?.length ?? 0) > 0 || Boolean(req.search);
    let types: ColumnTypes | undefined;
    if (needsTypes) {
      const sample = await this.guard(coll.find({}).limit(SAMPLE_DOCS).toArray(), req.timeoutMs, req.signal);
      types = new Map();
      for (const c of columnsFromDocs(sample as RawDoc[])) {
        types.set(c.name, { normalizedType: c.normalizedType, dataType: c.dataType });
      }
    }

    const clauses: Filter[] = [];
    if (req.filters?.length) {
      clauses.push(buildFilterDoc(req.filters, types ?? new Map()));
    }
    if (req.search) {
      const stringCols = [...(types?.entries() ?? [])]
        .filter(([, t]) => t.normalizedType === 'string')
        .map(([name, t]) => ({ name, dataType: t.dataType }));
      const searchDoc = buildSearchDoc(req.search, stringCols);
      if (searchDoc) {
        clauses.push(searchDoc);
      }
    }
    if (state) {
      clauses.push(resumeFilter(state));
    }
    const filter: Filter =
      clauses.length === 0 ? {} : clauses.length === 1 ? clauses[0]! : { $and: clauses };
    const sortDoc = buildSortDoc(req.sorts);
    const skip = state ? 0 : (req.offset ?? 0); // cursor 路径位置语义由游标唯一承载

    // limit+1 探测尽头（契约：已取尽不返回 nextCursor）
    const docs = await this.guard(
      coll.find(filter, { sort: sortDoc, skip, limit: req.limit + 1 }).toArray(),
      req.timeoutMs,
      req.signal,
    );
    const hasNext = docs.length > req.limit;
    const page = docs.slice(0, req.limit) as RawDoc[];

    let cols = columnsFromDocs(page);
    if (page.length === 0) {
      // 空页（如筛选无命中 / 尽头页）：回退采样列集，保证列骨架（含 _id 首列）可用
      const sample = await this.guard(coll.find({}).limit(SAMPLE_DOCS).toArray(), req.timeoutMs, req.signal);
      cols = columnsFromDocs(sample as RawDoc[]);
    }
    if (req.columns?.length) {
      const set = new Set(req.columns);
      cols = cols.filter((c) => set.has(c.name));
    }
    const last = page[page.length - 1];
    const sorts = req.sorts ?? [];
    return {
      columns: cols.map((c) => ({ name: c.name, type: c.normalizedType })),
      rows: page.map((doc) => cols.map((c) => encodeValue(doc[c.name]))),
      rowCount: page.length,
      primaryKey: ['_id'],
      nextCursor:
        hasNext && last
          ? encodeCursor({
              id: last._id,
              ...(sorts.length > 0
                ? {
                    sk: sorts.map((s) => s.column),
                    sd: sorts.map((s) => (s.dir === 'desc' ? -1 : 1) as 1 | -1),
                    sv: sorts.map((s) => last[s.column]),
                  }
                : {}),
            })
          : undefined,
      executionMs: Date.now() - started,
    };
  }

  // ── mongosh 命令控制台（§5.5：query() 只收单条命令文本，首批只读）─────────────

  async query(req: QueryRequest): Promise<ResultSet[]> {
    this.assertOpen();
    if (req.signal?.aborted) {
      throw new DriverError('E_CANCELED', '已取消');
    }
    const lines = splitMongoCommandLines(req.sql);
    if (lines.length === 0) {
      throw new DriverError('E_SYNTAX', '空命令');
    }
    if (lines.length > 1) {
      throw new DriverError('E_VALIDATION', '一次只能执行一条命令（每行一条，由控制台逐条调用）');
    }
    const text = lines[0].text;
    const started = Date.now();
    // D-18 放行面：读命令（provablyRead）+ 文档写五类；其余（aggregate $out/$merge、runCommand
    // 写命令、drop/createIndex 等结构类）恒 E_UNSUPPORTED。危险判定/只读护栏在 Host（横幅/Modal）
    const show = /^show\s+(\S+)\s*$/i.exec(text);
    if (show) {
      return [await this.execShow(show[1]!.toLowerCase(), req, started)];
    }
    if (parseMongoUse(text) !== undefined) {
      // 防御路径：Host 已在命令模式拦截 use（P-36 同构），此处保证不下发
      throw new DriverError('E_VALIDATION', 'use 由 Console 绑定管理（状态栏/树节点切换），命令控制台不下发');
    }
    const chain = parseMongoChain(text);
    if (!chain) {
      throw new DriverError('E_SYNTAX', `无法解析 mongosh 命令："${text.slice(0, 80)}"`);
    }
    if (!isProvablyReadMongoCommand(text) && !DOC_WRITE_METHODS.has(chain.method)) {
      throw new DriverError(
        'E_UNSUPPORTED',
        `命令 "${chain.method}" 不在命令控制台放行范围（读命令 + 文档写，D-18）`,
      );
    }
    const args = parseMongoArgs(chain.argsSrc);
    return [await this.execChain(chain, args, req, started)];
  }

  private async execShow(target: string, req: QueryRequest, started: number): Promise<ResultSet> {
    const executionMs = Date.now() - started;
    if (target === 'dbs' || target === 'databases') {
      const dbs = await this.listDatabases();
      return {
        columns: [
          { name: 'database', type: 'string' },
          { name: 'sizeBytes', type: 'integer' },
        ],
        rows: dbs.map((x) => [x.name, x.sizeBytes ?? null]),
        rowCount: dbs.length,
        executionMs,
      };
    }
    if (target === 'collections' || target === 'tables') {
      const objs = await this.listObjects(req.db ?? String(this.cfg.options.database ?? 'test'));
      return {
        columns: [{ name: 'collection', type: 'string' }],
        rows: objs.map((x) => [x.name]),
        rowCount: objs.length,
        executionMs,
      };
    }
    throw new DriverError('E_SYNTAX', `未知 show 目标 "${target}"（支持 dbs / collections）`);
  }

  private async execChain(
    chain: NonNullable<ReturnType<typeof parseMongoChain>>,
    args: unknown[],
    req: QueryRequest,
    started: number,
  ): Promise<ResultSet> {
    await this.getClient();
    const database = this.db(chain.dbTarget ?? req.db);
    const coll = chain.coll ? database.collection(chain.coll) : undefined;
    const maxRows = req.maxRows;

    switch (chain.method) {
      case 'find': {
        if (!coll) {
          throw new DriverError('E_SYNTAX', 'find 需要 collection（db.<coll>.find(...)）');
        }
        const filter = (args[0] ?? {}) as Filter;
        const opts = (args[1] ?? {}) as { sort?: unknown; limit?: unknown; skip?: unknown; projection?: unknown };
        const limit = Math.min(Number(opts.limit ?? maxRows), maxRows);
        const docs = await this.guard(
          coll
            .find(filter, {
              sort: normalizeSortSpec(opts.sort),
              skip: opts.skip === undefined ? undefined : Number(opts.skip),
              limit: limit + 1,
              projection: (opts.projection ?? undefined) as never,
            })
            .toArray(),
          req.timeoutMs,
          req.signal,
        );
        const truncated = docs.length > limit;
        return tabularFromDocs(docs.slice(0, limit) as RawDoc[], Date.now() - started, { truncated });
      }
      case 'findOne': {
        if (!coll) {
          throw new DriverError('E_SYNTAX', 'findOne 需要 collection');
        }
        const doc = await this.guard(coll.findOne((args[0] ?? {}) as Filter), req.timeoutMs, req.signal);
        if (doc === null) {
          return scalarRs('document', 'json', null, Date.now() - started);
        }
        return tabularFromDocs([doc as RawDoc], Date.now() - started);
      }
      case 'count':
      case 'countDocuments': {
        if (!coll) {
          throw new DriverError('E_SYNTAX', 'count 需要 collection');
        }
        const n = await this.guard(coll.countDocuments((args[0] ?? {}) as Filter), req.timeoutMs, req.signal);
        return scalarRs('count', 'integer', n, Date.now() - started);
      }
      case 'estimatedDocumentCount': {
        if (!coll) {
          throw new DriverError('E_SYNTAX', 'estimatedDocumentCount 需要 collection');
        }
        const n = await this.guard(coll.estimatedDocumentCount(), req.timeoutMs, req.signal);
        return scalarRs('count', 'integer', n, Date.now() - started);
      }
      case 'distinct': {
        if (!coll) {
          throw new DriverError('E_SYNTAX', 'distinct 需要 collection');
        }
        const field = String(args[0] ?? '_id');
        const values = await this.guard(
          coll.distinct(field, (args[1] ?? {}) as Filter),
          req.timeoutMs,
          req.signal,
        );
        const first = (values as unknown[]).find((v) => v !== null && v !== undefined);
        return {
          columns: [{ name: field, type: first !== undefined ? normalizedOf(bsonDataTypeOf(first)) : 'unknown' }],
          rows: (values as unknown[]).map((v) => [encodeValue(v)]),
          rowCount: (values as unknown[]).length,
          executionMs: Date.now() - started,
        };
      }
      case 'aggregate': {
        if (!coll) {
          throw new DriverError('E_SYNTAX', 'aggregate 需要 collection');
        }
        const pipeline = args[0];
        if (!Array.isArray(pipeline)) {
          throw new DriverError('E_SYNTAX', 'aggregate 需要阶段数组参数');
        }
        const docs = await this.guard(
          coll.aggregate(pipeline as never, { allowDiskUse: true }).limit(maxRows + 1).toArray(),
          req.timeoutMs,
          req.signal,
        );
        const truncated = docs.length > maxRows;
        return tabularFromDocs(docs.slice(0, maxRows) as RawDoc[], Date.now() - started, { truncated });
      }
      case 'stats': {
        if (!coll) {
          throw new DriverError('E_SYNTAX', 'stats 需要 collection');
        }
        const reply = await this.guard(database.command({ collStats: chain.coll }), req.timeoutMs, req.signal);
        return objectToRows(reply, Date.now() - started);
      }
      case 'dbStats': {
        const reply = await this.guard(database.command({ dbStats: 1 }), req.timeoutMs, req.signal);
        return objectToRows(reply, Date.now() - started);
      }
      case 'getIndexes': {
        if (!coll) {
          throw new DriverError('E_SYNTAX', 'getIndexes 需要 collection');
        }
        const idx = await this.guard(coll.listIndexes().toArray(), req.timeoutMs, req.signal);
        return {
          columns: [
            { name: 'name', type: 'string' },
            { name: 'key', type: 'json' },
            { name: 'unique', type: 'boolean' },
          ],
          rows: idx.map((i) => [String(i.name), encodeValue(i.key), Boolean(i.unique)]),
          rowCount: idx.length,
          executionMs: Date.now() - started,
        };
      }
      case 'getCollectionNames': {
        const infos = await this.guard(
          database
            .listCollections({}, { nameOnly: true, authorizedCollections: true })
            .toArray(),
          req.timeoutMs,
          req.signal,
        );
        return {
          columns: [{ name: 'collection', type: 'string' }],
          rows: infos.filter((i) => !i.name.startsWith('system.')).map((i) => [i.name]),
          rowCount: infos.length,
          executionMs: Date.now() - started,
        };
      }
      case 'getDBNames': {
        const client = await this.getClient();
        const reply = await this.guard(
          client.db('admin').command({ listDatabases: 1, nameOnly: true, authorizedDatabases: true }),
          req.timeoutMs,
          req.signal,
        );
        const dbs = (reply as { databases?: Array<{ name: string }> }).databases ?? [];
        return {
          columns: [{ name: 'database', type: 'string' }],
          rows: dbs.map((x) => [x.name]),
          rowCount: dbs.length,
          executionMs: Date.now() - started,
        };
      }
      case 'getCollectionInfos': {
        const infos = await this.guard(
          database
            .listCollections({ name: chain.coll ?? '' }, { nameOnly: false, authorizedCollections: true })
            .toArray(),
          req.timeoutMs,
          req.signal,
        );
        return {
          columns: [{ name: 'info', type: 'json' }],
          rows: infos.map((i) => [encodeValue(i)]),
          rowCount: infos.length,
          executionMs: Date.now() - started,
        };
      }
      case 'runCommand': {
        const doc = args[0];
        if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
          throw new DriverError('E_SYNTAX', 'runCommand 需要对象参数（db.runCommand({ ping: 1 })）');
        }
        const reply = await this.guard(database.command(doc as never), req.timeoutMs, req.signal);
        return objectToRows(reply, Date.now() - started);
      }
      // ── 文档写命令（D-18 放开；危险判定/只读护栏在 Host，write 命令后由 consoleService 失效缓存）──
      case 'insertOne': {
        if (!coll) {
          throw new DriverError('E_SYNTAX', 'insertOne 需要 collection');
        }
        const doc = args[0];
        if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
          throw new DriverError('E_SYNTAX', 'insertOne 需要文档对象参数');
        }
        const r = await this.guard(coll.insertOne(doc as never), req.timeoutMs, req.signal);
        return objectToRows({ insertedId: encodeValue(r.insertedId), acknowledged: r.acknowledged }, Date.now() - started);
      }
      case 'insertMany': {
        if (!coll) {
          throw new DriverError('E_SYNTAX', 'insertMany 需要 collection');
        }
        const docs = args[0];
        if (!Array.isArray(docs)) {
          throw new DriverError('E_SYNTAX', 'insertMany 需要文档数组参数');
        }
        const r = await this.guard(coll.insertMany(docs as never), req.timeoutMs, req.signal);
        return objectToRows({ insertedCount: r.insertedCount, acknowledged: r.acknowledged }, Date.now() - started);
      }
      case 'updateOne':
      case 'updateMany': {
        if (!coll) {
          throw new DriverError('E_SYNTAX', `${chain.method} 需要 collection`);
        }
        const filter = args[0];
        const update = args[1];
        if (!filter || typeof filter !== 'object' || !update || typeof update !== 'object') {
          throw new DriverError('E_SYNTAX', `${chain.method} 需要 (filter, update) 两个对象参数`);
        }
        const r =
          chain.method === 'updateOne'
            ? await this.guard(coll.updateOne(filter as never, update as never, writeOptions(args[2])), req.timeoutMs, req.signal)
            : await this.guard(coll.updateMany(filter as never, update as never, writeOptions(args[2])), req.timeoutMs, req.signal);
        return objectToRows(
          { matchedCount: r.matchedCount, modifiedCount: r.modifiedCount, upsertedId: r.upsertedId ? encodeValue(r.upsertedId) : null },
          Date.now() - started,
        );
      }
      case 'replaceOne': {
        if (!coll) {
          throw new DriverError('E_SYNTAX', 'replaceOne 需要 collection');
        }
        const [filter, doc] = args;
        if (!filter || typeof filter !== 'object' || !doc || typeof doc !== 'object' || Array.isArray(doc)) {
          throw new DriverError('E_SYNTAX', 'replaceOne 需要 (filter, document) 参数');
        }
        const r = await this.guard(coll.replaceOne(filter as never, doc as never, writeOptions(args[2])), req.timeoutMs, req.signal);
        return objectToRows({ matchedCount: r.matchedCount, modifiedCount: r.modifiedCount }, Date.now() - started);
      }
      case 'deleteOne':
      case 'deleteMany': {
        if (!coll) {
          throw new DriverError('E_SYNTAX', `${chain.method} 需要 collection`);
        }
        const filter = args[0];
        if (!filter || typeof filter !== 'object') {
          throw new DriverError('E_SYNTAX', `${chain.method} 需要 filter 对象参数`);
        }
        const r =
          chain.method === 'deleteOne'
            ? await this.guard(coll.deleteOne(filter as never), req.timeoutMs, req.signal)
            : await this.guard(coll.deleteMany(filter as never), req.timeoutMs, req.signal);
        return objectToRows({ deletedCount: r.deletedCount }, Date.now() - started);
      }
      case 'findOneAndUpdate':
      case 'findOneAndReplace':
      case 'findOneAndDelete': {
        if (!coll) {
          throw new DriverError('E_SYNTAX', `${chain.method} 需要 collection`);
        }
        const filter = args[0];
        if (!filter || typeof filter !== 'object') {
          throw new DriverError('E_SYNTAX', `${chain.method} 需要 filter 对象参数`);
        }
        const opts = (args[2] ?? {}) as { sort?: unknown; projection?: unknown };
        const findOpts = {
          sort: normalizeSortSpec(opts.sort),
          projection: (opts.projection ?? undefined) as never,
        };
        const doc =
          chain.method === 'findOneAndUpdate'
            ? await this.guard(coll.findOneAndUpdate(filter as never, args[1] as never, findOpts), req.timeoutMs, req.signal)
            : chain.method === 'findOneAndReplace'
              ? await this.guard(coll.findOneAndReplace(filter as never, (args[1] ?? {}) as never, findOpts), req.timeoutMs, req.signal)
              : await this.guard(coll.findOneAndDelete(filter as never, findOpts), req.timeoutMs, req.signal);
        if (doc === null) {
          return scalarRs('document', 'json', null, Date.now() - started);
        }
        return tabularFromDocs([doc as RawDoc], Date.now() - started);
      }
      case 'dropDatabase': {
        // M8-DBDDL / D-19：树删库与命令行同一护栏（危险横幅/prod Modal/只读拒）
        const target = assertMongoDbName(chain.dbTarget ?? req.db ?? '');
        await this.getClient();
        await this.guard(this.client!.db(target).dropDatabase(), req.timeoutMs, req.signal);
        return objectToRows({ dropped: true, database: target }, Date.now() - started);
      }
      case 'createCollection': {
        // M8-DBDDL / D-19 修订：树建库（首个 collection 隐式创建）与命令行同一护栏
        const target = assertMongoDbName(chain.dbTarget ?? req.db ?? '');
        const coll = args[0];
        if (!coll || typeof coll !== 'string') {
          throw new DriverError('E_SYNTAX', 'createCollection 需要集合名参数（db.createCollection("name")）');
        }
        await this.getClient();
        await this.guard(this.client!.db(target).createCollection(coll), req.timeoutMs, req.signal);
        return objectToRows({ created: `${target}.${coll}` }, Date.now() - started);
      }
      default:
        throw new DriverError(
          'E_UNSUPPORTED',
          `命令 "${chain.method}" 未被命令控制台支持（放行面 = 读命令 + 文档写 + 建删库，D-18/D-19）`,
        );
    }
  }

  // ── 编辑（D-18）：字段级 $set 乐观锁，逐条 + 失败即停（supportsTransaction=false，§8-5）──

  /** 编辑值转换用的采样列类型（与 fetchRows 筛选转换同源） */
  private async sampleTypes(db: string, obj: string): Promise<ColumnTypes> {
    await this.getClient();
    const docs = await this.guard(this.db(db).collection(obj).find({}).limit(SAMPLE_DOCS).toArray(), 15_000);
    const types: ColumnTypes = new Map();
    for (const c of columnsFromDocs(docs as RawDoc[])) {
      types.set(c.name, { normalizedType: c.normalizedType, dataType: c.dataType });
    }
    return types;
  }

  async previewChanges(db: string, obj: string, cs: ChangeSet): Promise<PreviewItem[]> {
    this.assertOpen();
    const types = await this.sampleTypes(db, obj);
    return buildChangeOps(obj, cs, types).map((op) => ({
      kind: op.kind,
      tempId: op.tempId,
      rowKey: op.rowKey,
      sql: op.sql,
      params: op.params,
    }));
  }

  async applyChanges(db: string, obj: string, cs: ChangeSet): Promise<ApplyResult> {
    this.assertOpen();
    const types = await this.sampleTypes(db, obj);
    const ops = buildChangeOps(obj, cs, types);
    const coll = this.db(db).collection(obj);
    const items: ApplyResult['items'] = [];
    const started = Date.now();
    for (const op of ops) {
      let affected: number;
      let rowKey = op.rowKey;
      try {
        if (op.exec.type === 'insertOne') {
          const r = await this.guard(coll.insertOne(op.exec.doc as never), 15_000);
          affected = 1;
          rowKey = { _id: encodeValue(r.insertedId) }; // §8-3：回填生成主键（ObjectId hex / 字符串原文）
        } else if (op.exec.type === 'updateOne') {
          const r = await this.guard(
            coll.updateOne(op.exec.filter as never, op.exec.update as never),
            15_000,
          );
          affected = r.matchedCount; // 乐观锁口径：同值写回 modified=0 不是冲突
        } else {
          const r = await this.guard(coll.deleteOne(op.exec.filter as never), 15_000);
          affected = r.deletedCount;
        }
      } catch (err) {
        const e = DriverError.is(err) ? err : toMongoError(err);
        throw new DriverError(e.code, `已应用 ${items.length}/${ops.length} 项后失败（无事务，已应用项保留）：${e.message}`, {
          meta: { kind: op.kind, tempId: op.tempId, rowKey },
        });
      }
      if (affected !== 1) {
        throw new DriverError('E_CONFLICT', `乐观锁冲突：数据已被他人修改（matched ${affected}）`, {
          meta: { kind: op.kind, tempId: op.tempId, rowKey },
        });
      }
      items.push({ kind: op.kind, tempId: op.tempId, rowKey, sql: op.sql, affectedRows: affected });
    }
    return { items, executionMs: Date.now() - started };
  }

  async getCompletionSource(): Promise<CompletionSource> {
    let databases: string[] = [];
    try {
      databases = (await this.listDatabases()).map((x) => x.name);
    } catch {
      databases = []; // 词表始终可用，库列表尽力而为
    }
    return mongoCompletionSource(databases);
  }

  async dispose(): Promise<void> {
    if (this.disposed) {
      return; // 幂等（驱动规范 §7）
    }
    this.disposed = true;
    const client = this.client;
    this.client = undefined;
    this.connecting = undefined;
    if (client) {
      await client.close().catch(() => undefined);
    }
  }
}

export function createMongoDriver(): IDatabaseDriver {
  return {
    id: MONGO_DRIVER_ID,
    displayName: 'MongoDB',
    apiVersion: 1,
    capabilities,
    getConnectionFormSchema: () => formSchema,
    // ── 库级 DDL（M8-DBDDL / D-19 及修订）：建库 = 首个 collection 隐式创建（DatabaseSpec.collection，
    //    Compass 同款语义——空库不真正存在）；删库 = dropDatabase。语句为命令控制台命令文本
    //    （getSiblingDB 显式定位，JSON 引号化防注入）；树建/删库与命令行同一护栏 ──
    getDatabaseFormSchema: () => ({
      fields: [
        { key: 'name', label: '库名', type: 'string', required: true, placeholder: 'mydb' },
        {
          key: 'collection',
          label: '首个集合名',
          type: 'string',
          required: true,
          placeholder: 'init',
          hint: 'MongoDB 库在拥有首个集合后才会真正创建（空库不显示）',
        },
      ],
    }),
    buildCreateDatabase: async (spec: DatabaseSpec) => {
      assertMongoDbName(spec.name);
      const coll = assertMongoCollectionName(spec.collection ?? '');
      return [{ sql: `db.getSiblingDB(${JSON.stringify(spec.name)}).createCollection(${JSON.stringify(coll)})` }];
    },
    buildDropDatabase: async (db: string) => {
      assertMongoDbName(db);
      return [{ sql: `db.getSiblingDB(${JSON.stringify(db)}).dropDatabase()`, destructive: true }];
    },
    testConnection: async (cfg: ConnectionConfig, secret: string): Promise<TestResult> => {
      const started = Date.now();
      let client: MongoClient | undefined;
      try {
        client = new MongoClient(buildMongoUri(cfg, secret), clientOptions(cfg));
        await client.connect();
        const info = await client.db('admin').command({ buildInfo: 1 });
        await client.close();
        return {
          ok: true,
          latencyMs: Date.now() - started,
          serverVersion: String((info as { version?: string }).version ?? ''),
        };
      } catch (err) {
        await client?.close().catch(() => undefined);
        return { ok: false, error: toMongoError(err) };
      }
    },
    listDatabaseOptions: async (cfg: ConnectionConfig, secret: string): Promise<string[]> => {
      let client: MongoClient | undefined;
      try {
        client = new MongoClient(buildMongoUri(cfg, secret), clientOptions(cfg));
        await client.connect();
        const reply = await client
          .db('admin')
          .command({ listDatabases: 1, nameOnly: true, authorizedDatabases: true });
        const dbs = (reply as { databases?: Array<{ name: string }> }).databases ?? [];
        return dbs.filter((x) => !SYSTEM_DBS.has(x.name)).map((x) => x.name);
      } catch {
        return []; // 失败无感降级为纯手输（§3.1 dynamicOptions 契约）
      } finally {
        await client?.close().catch(() => undefined);
      }
    },
    connect: (cfg: ConnectionConfig, secret: string) => Promise.resolve(new MongoConnection(cfg, secret)),
  };
}
