import { createClient, RESP_TYPES, type RedisClientOptions } from 'redis';
import {
  DriverError,
  REDIS_COMMAND_KEYWORDS,
  REDIS_SUBCOMMAND_KEYWORDS,
  splitCommandLines,
  tokenizeRedisCommand,
  type ApplyResult,
  type ChangeSet,
  type ColumnMeta,
  type CompletionSource,
  type ConnectionConfig,
  type DatabaseMeta,
  type DriverCapabilities,
  type FetchRowsRequest,
  type FilterCondition,
  type FormSchema,
  type IConnection,
  type IDatabaseDriver,
  type ObjectMeta,
  type PreviewItem,
  type QueryRequest,
  type ResultSet,
  type TestResult,
} from '@db-explorer/core';
import { toRedisError } from './errors';
import {
  contentPrimaryKey,
  cursorOf,
  decodeCursorOrThrow,
  encodeRedisValue,
  groupKeysByType,
  isGlobPattern,
  keyContentColumns,
  patternColumns,
  redisTypeOf,
  utf8,
  type ScanState,
} from './keys';

/**
 * Redis 驱动（node-redis v5）。
 * M6 交付范围（概要设计 §10 / 驱动规范 §5.3）：
 * - Key 树：db0..N → Keys 目录（SCAN 采样 + 前缀分组）→ Key（collection）
 * - fetchRows：模式浏览（SCAN，禁止 KEYS）+ 单键类型化内容（HSCAN/LRANGE/SSCAN/ZRANGE）
 * - cursor 分页：nextCursor 闭环；offset 翻译为「SCAN 起始跳过」（webview 分页栏 offset 语义兼容）
 * - 命令控制台：query() 只收单条命令文本（core 白名单负责危险/只读判定，本驱动不重复实现）
 * - 二进制保真：sendCommand 统一以 Buffer 接收 bulk string，无效 UTF-8 → base64（§5.3）
 */

export const REDIS_DRIVER_ID = 'redis';

const capabilities: DriverCapabilities = {
  supportsSQL: false, // 命令控制台走 core 命令白名单（§5.3），非 SQL
  supportsTransaction: false, // Redis 无可回滚事务（MULTI/EXEC 不回滚），无编辑场景
  supportsInteractiveTransaction: false,
  supportsMultipleDatabases: true, // db0..N-1（默认 16）
  supportsMultiStatement: false, // 命令控制台逐条执行（core 按行切分）
  supportsCancel: false, // node-redis 无法可靠中止已下发命令，如实声明（契约测试按此跳过）
  supportsDdl: false,
  hierarchy: ['connection', 'database', 'folder', 'collection'],
  editable: false,
  pagination: 'cursor',
};

const formSchema: FormSchema = {
  fields: [
    { key: 'host', label: '主机', type: 'string', required: true, placeholder: '127.0.0.1' },
    { key: 'port', label: '端口', type: 'number', required: true, default: 6379, validator: 'port' },
    { key: 'username', label: '用户名（ACL，可选）', type: 'string' },
    { key: 'password', label: '密码', type: 'password' },
    { key: 'database', label: '默认库编号', type: 'number', default: 0 },
    {
      key: 'ssl',
      label: 'SSL/TLS 加密连接',
      type: 'boolean',
      default: false,
      control: 'switch',
      hint: '云托管 Redis（Upstash / Redis Cloud / Aiven 等）强制 TLS，须开启',
    },
    {
      key: 'sslInsecure',
      label: '跳过证书校验',
      type: 'boolean',
      default: false,
      group: '高级',
      section: 'SSL/TLS',
      toggle: 'ssl', // 依赖 base 组的 ssl 开关：关闭时本项隐藏
      hint: '⚠ 风险：不校验服务器证书，连接可被中间人窃听/篡改。仅限自签证书的受信内网环境使用',
    },
    {
      key: 'connectTimeout',
      label: '连接超时（ms）',
      type: 'number',
      default: 10000,
      group: '高级',
      section: '超时',
    },
  ],
};

/** bulk string → Buffer：二进制值保真（其余回复类型不受影响） */
const BLOB_AS_BUFFER = { typeMapping: { [RESP_TYPES.BLOB_STRING]: Buffer } };

/** Keys 目录采样：最多采样的键数（按类型分组列出；全量浏览走 '*' 模式节点） */
const SAMPLE_KEYS = 500;
/** SCAN/HSCAN/SSCAN 的 COUNT 提示 */
const SCAN_COUNT = 200;

/** 绑定的库名（dbN，listDatabases 命名）→ 库编号 */
function parseDbIndex(db: string | undefined, fallback: unknown): number {
  const m = /^db(\d+)$/.exec((db ?? '').trim());
  if (m) {
    return Number(m[1]);
  }
  const n = Number(db ?? fallback ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/** 连接失败/认证失败时有限重试后放弃（默认策略无限重试会挂起 connect()，超时只能靠外层） */
function reconnectStrategy(retries: number): number | Error {
  if (retries >= 3) {
    return new Error('重连次数已达上限');
  }
  return Math.min(250 * 2 ** retries, 2000);
}

/** createClient 默认实例化类型（避免手写泛型参数） */
export type RedisClient = ReturnType<typeof createClient>;

/**
 * socket 选项统一构建（连接 / testConnection 同源，规范 §8-6 同源精神）：
 * ssl 开启 → TLS（RedisTlsOptions）；sslInsecure → 跳过证书校验（FormSchema 已标注风险，§10）。
 */
function buildSocketOptions(o: Record<string, unknown>): RedisClientOptions['socket'] {
  const base = {
    host: String(o.host ?? '127.0.0.1'),
    port: Number(o.port ?? 6379),
    connectTimeout: Number(o.connectTimeout ?? 10_000),
  };
  if (!o.ssl) {
    return base;
  }
  return { ...base, tls: true, rejectUnauthorized: !o.sslInsecure };
}

function createRedisClient(options: RedisClientOptions): RedisClient {
  return createClient({
    ...options,
    socket: { ...options.socket, reconnectStrategy },
  });
}

/**
 * 建连死线：node-redis 在「明文连 TLS 端口」等场景 connect() 永不 resolve
 * （重连循环卡死，P-30），必须 race 超时后由调用方 destroy()，否则懒连接首条命令永久挂起。
 */
export async function connectWithTimeout(client: RedisClient, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new DriverError('E_CONN', `连接超时（${timeoutMs}ms）：请检查主机/端口与 SSL 配置`)),
      timeoutMs,
    );
  });
  try {
    await Promise.race([client.connect(), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

export class RedisConnection implements IConnection {
  readonly connectionId: string;
  /** 每个库独立客户端：SELECT 是连接级状态，独立客户端消除跨操作串库 */
  private readonly clients = new Map<number, RedisClient>();
  private readonly connecting = new Map<number, Promise<RedisClient>>();
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

  private async getDbClient(db?: string): Promise<RedisClient> {
    this.assertOpen();
    const index = parseDbIndex(db, this.cfg.options.database);
    const cached = this.clients.get(index);
    if (cached) {
      return cached;
    }
    const inFlight = this.connecting.get(index);
    if (inFlight) {
      return inFlight;
    }
    const task = (async () => {
      const o = this.cfg.options;
      const client = createRedisClient({
        socket: buildSocketOptions(o),
        username: o.username ? String(o.username) : undefined,
        password: this.secret || undefined,
        database: index,
      });
      try {
        await connectWithTimeout(client, Number(o.connectTimeout ?? 10_000));
      } catch (err) {
        client.destroy(); // 重连等待态下 quit() 会永久挂起（QUIT 排在重连之后）
        throw toRedisError(err);
      }
      this.clients.set(index, client);
      return client;
    })();
    this.connecting.set(index, task);
    try {
      return await task;
    } finally {
      this.connecting.delete(index);
    }
  }

  /** 原始命令（bulk string 保真为 Buffer） */
  private async raw(db: string | undefined, args: string[]): Promise<unknown> {
    const client = await this.getDbClient(db);
    try {
      return await client.sendCommand(args, BLOB_AS_BUFFER);
    } catch (err) {
      throw toRedisError(err);
    }
  }

  async ping(): Promise<void> {
    await this.raw(undefined, ['PING']);
  }

  async listDatabases(): Promise<DatabaseMeta[]> {
    this.assertOpen();
    try {
      const client = await this.getDbClient();
      let count = 16;
      try {
        const cfg = await client.configGet('databases');
        const n = Number(cfg?.['databases']);
        if (Number.isFinite(n) && n > 0) {
          count = n;
        }
      } catch {
        // CONFIG 被禁用（如托管服务）：退回默认 16 库
      }
      return Array.from({ length: count }, (_, i) => ({ name: `db${i}` }));
    } catch (err) {
      throw DriverError.is(err) ? err : toRedisError(err);
    }
  }

  async listObjects(db: string): Promise<ObjectMeta[]> {
    this.assertOpen();
    // SCAN 采样（禁止 KEYS，§5.3）→ 按数据类型分组为目录（schema=分组 id，树据此归组）；
    // 末尾 '*' 模式节点 = 全键空间 SCAN 分页浏览入口
    const keys = await this.scanSample(db);
    const types = await this.pipelineTypes(db, keys);
    return groupKeysByType(keys, types);
  }

  /** 最多 SAMPLE_KEYS 个键名的 SCAN 采样 */
  private async scanSample(db: string): Promise<string[]> {
    const keys: string[] = [];
    let cursor = '0';
    do {
      const reply = (await this.raw(db, ['SCAN', cursor, 'COUNT', String(SCAN_COUNT)])) as [
        Buffer | string,
        Buffer[],
      ];
      cursor = utf8(reply[0]);
      for (const k of reply[1]) {
        keys.push(utf8(k));
        if (keys.length >= SAMPLE_KEYS) {
          return keys;
        }
      }
    } while (cursor !== '0');
    return keys;
  }

  private async pipelineTypes(db: string, keys: string[]): Promise<Map<string, string>> {
    const types = new Map<string, string>();
    if (keys.length === 0) {
      return types;
    }
    const client = await this.getDbClient(db);
    try {
      await Promise.all(
        keys.map(async (key) => {
          const t = await client.type(key);
          types.set(key, t);
        }),
      );
    } catch (err) {
      throw toRedisError(err);
    }
    return types;
  }

  async listColumns(db: string, obj: string): Promise<ColumnMeta[]> {
    this.assertOpen();
    if (isGlobPattern(obj)) {
      return patternColumns();
    }
    const type = await this.keyType(db, obj);
    const cols = keyContentColumns(type);
    if (!cols) {
      throw new DriverError('E_UNSUPPORTED', `暂不支持 ${type} 类型的键展示`);
    }
    return cols;
  }

  private async keyType(db: string, key: string): Promise<string> {
    const type = await this.keyTypeOf(db, key);
    if (!type) {
      throw new DriverError('E_NOT_FOUND', `键 "${key}" 不存在`);
    }
    return type;
  }

  private async keyTypeOf(db: string, key: string): Promise<string | undefined> {
    const reply = (await this.raw(db, ['TYPE', key])) as string;
    return redisTypeOf(reply);
  }

  private async keyTtl(db: string, key: string): Promise<number> {
    return (await this.raw(db, ['TTL', key])) as number;
  }

  async fetchRows(req: FetchRowsRequest): Promise<ResultSet> {
    this.assertOpen();
    if (req.whereSql?.trim()) {
      throw new DriverError('E_VALIDATION', 'Redis 取数不支持 WHERE 片段（可用筛选条件与全局搜索）');
    }
    if (req.orderBySql?.trim()) {
      throw new DriverError('E_VALIDATION', 'Redis 取数不支持 ORDER BY 片段');
    }
    const started = Date.now();
    const result = isGlobPattern(req.obj)
      ? await this.fetchPattern(req, started)
      : await this.fetchKeyContent(req, started);
    return result;
  }

  /** 模式浏览（SCAN + MATCH；禁止 KEYS）。offset 语义 = SCAN 起始跳过（不取全表内存过滤）。
   *  游标状态机（feedScan）：服务端游标 + 批内未消费键共同构成 opaque cursor——
   *  SCAN 一批（COUNT 提示）可能覆盖整个 keyspace，页内位置必须随游标携带才能闭环。 */
  private async fetchPattern(req: FetchRowsRequest, started: number): Promise<ResultSet> {
    const allCols = patternColumns();
    const colNames = allCols.map((c) => c.name);
    const guard = this.guard(req);
    const skip = req.cursor ? 0 : (req.offset ?? 0); // cursor 路径位置语义由游标唯一承载
    const cap = skip + req.limit;
    const state: ScanState = req.cursor ? decodeCursorOrThrow(req.cursor) : { scan: '0', pending: [] };

    const matched: Array<[string, string, number]> = [];
    collecting: for await (const items of this.feedScan(req.db, { kind: 'SCAN', match: req.obj }, state)) {
      await guard();
      const key = utf8(items[0]);
      const type = await this.keyTypeOf(req.db, key);
      if (!type) {
        continue; // 取数间隙被删除的键不展示
      }
      const ttl = await this.keyTtl(req.db, key);
      if (!matchRow([key, type, ttl], colNames, req.filters)) {
        continue;
      }
      if (req.search && ![key, type].some((v) => v.includes(req.search!))) {
        continue;
      }
      matched.push([key, type, ttl]);
      if (matched.length >= cap) {
        break collecting;
      }
    }

    const exhausted = state.scan === '0' && state.pending.length === 0;
    const page = sortRows(matched, colNames, req.sorts).slice(skip, skip + req.limit);
    const outCols = this.project(allCols, req.columns);
    const idx = new Map(outCols.map((c) => [c.name, colNames.indexOf(c.name)]));
    return {
      columns: outCols.map((c) => ({ name: c.name, type: c.normalizedType })),
      rows: page.map((row) => outCols.map((c) => row[idx.get(c.name)!])),
      rowCount: page.length,
      primaryKey: ['key'],
      // 即使本页空（全被过滤），也要把游标交给客户端走完（闭环契约）
      nextCursor: !exhausted ? cursorOf(state.scan, state.pending) : undefined,
      executionMs: Date.now() - started,
    };
  }

  /**
   * SCAN/HSCAN/SSCAN 统一供给器：先消费游标携带的批内剩余（pending），再按服务端游标取批。
   * state 被原地更新为「下一个未消费位置」；消费方在任意条目后停住，state 即下一页游标。
   * pending 以 Buffer 承载（二进制值保真，游标序列化时转 base64）。
   * unit=2（HSCAN）：服务端按 [f1,v1,f2,v2] 扁平数组回复，以字段/值对为消费单元。
   */
  private async *feedScan(
    db: string,
    spec: { kind: 'SCAN'; match: string } | { kind: 'HSCAN' | 'SSCAN'; key: string },
    state: ScanState,
  ): AsyncGenerator<Buffer[]> {
    const unit = spec.kind === 'HSCAN' ? 2 : 1;
    const pending = [...state.pending];
    let scanCursor = state.scan;
    let started = pending.length > 0 || scanCursor !== '0';
    for (;;) {
      if (pending.length >= unit) {
        const items = pending.splice(0, unit);
        state.scan = scanCursor;
        state.pending = [...pending];
        yield items;
        continue;
      }
      pending.length = 0; // 批剩余不足一个单元（服务端保证整单元，防御性丢弃）
      if (started && scanCursor === '0') {
        state.scan = '0';
        state.pending = [];
        return;
      }
      started = true;
      const args =
        spec.kind === 'SCAN'
          ? ['SCAN', scanCursor, 'MATCH', spec.match, 'COUNT', String(SCAN_COUNT)]
          : [spec.kind, spec.key, scanCursor, 'COUNT', String(SCAN_COUNT)];
      const reply = (await this.raw(db, args)) as [Buffer | string, Buffer[]];
      scanCursor = utf8(reply[0]);
      pending.push(...reply[1]);
      state.scan = scanCursor;
      state.pending = [...pending];
    }
  }

  /** 单键类型化内容（HSCAN / LRANGE / SSCAN / ZRANGE / GET）。
   *  游标状态机与模式浏览一致（feedScan，pending 携带批内位置）；
   *  位置型（list/zset）游标复用 scan 字段承载偏移；
   *  位置型取数无法下推筛选，过滤后行数可能少于页大小（M6 已知限制，README 声明）。 */
  private async fetchKeyContent(req: FetchRowsRequest, started: number): Promise<ResultSet> {
    const type = await this.keyType(req.db, req.obj);
    const cols = keyContentColumns(type);
    if (!cols) {
      throw new DriverError('E_UNSUPPORTED', `暂不支持 ${type} 类型的键展示`);
    }
    const colNames = cols.map((c) => c.name);
    const guard = this.guard(req);
    const skip = req.cursor ? 0 : (req.offset ?? 0); // cursor 路径位置语义由游标唯一承载
    const limit = req.limit;
    const cap = skip + limit;
    const collected: unknown[][] = [];
    let next: { scan: string; pending?: Buffer[] } | undefined;

    if (type === 'string') {
      const reply = (await this.raw(req.db, ['GET', req.obj])) as Buffer | null;
      collected.push([encodeRedisValue(reply)]);
    } else if (type === 'hash' || type === 'set') {
      const state: ScanState = req.cursor ? decodeCursorOrThrow(req.cursor) : { scan: '0', pending: [] };
      const spec =
        type === 'hash'
          ? ({ kind: 'HSCAN', key: req.obj } as const)
          : ({ kind: 'SSCAN', key: req.obj } as const);
      collecting: for await (const items of this.feedScan(req.db, spec, state)) {
        await guard();
        const row =
          type === 'hash'
            ? [utf8(items[0]), encodeRedisValue(items[1])]
            : [encodeRedisValue(items[0])];
        if (!matchRow(row, colNames, req.filters)) {
          continue;
        }
        if (req.search && !row.some((v) => String(v).includes(req.search!))) {
          continue;
        }
        collected.push(row);
        if (collected.length >= cap) {
          break collecting;
        }
      }
      const exhausted = state.scan === '0' && state.pending.length === 0;
      if (!exhausted) {
        next = { scan: state.scan, pending: state.pending };
      }
    } else if (type === 'list') {
      const start = Number(req.cursor ? decodeCursorOrThrow(req.cursor).scan : skip);
      const reply = (await this.raw(req.db, ['LRANGE', req.obj, String(start), String(start + limit - 1)])) as Buffer[];
      const len = (await this.raw(req.db, ['LLEN', req.obj])) as number;
      for (let i = 0; i < reply.length; i++) {
        const row: unknown[] = [start + i, encodeRedisValue(reply[i])];
        if (!matchRow(row, colNames, req.filters)) {
          continue;
        }
        if (req.search && !row.some((v) => String(v).includes(req.search!))) {
          continue;
        }
        collected.push(row);
      }
      if (start + reply.length < len && reply.length > 0) {
        next = { scan: String(start + limit) };
      }
    } else if (type === 'zset') {
      const start = Number(req.cursor ? decodeCursorOrThrow(req.cursor).scan : skip);
      const reply = (await this.raw(req.db, [
        'ZRANGE', req.obj, String(start), String(start + limit - 1), 'WITHSCORES',
      ])) as Buffer[];
      const zcard = (await this.raw(req.db, ['ZCARD', req.obj])) as number;
      for (let i = 0; i + 1 < reply.length; i += 2) {
        const row: unknown[] = [encodeRedisValue(reply[i]), Number(utf8(reply[i + 1]))];
        if (!matchRow(row, colNames, req.filters)) {
          continue;
        }
        if (req.search && !row.some((v) => String(v).includes(req.search!))) {
          continue;
        }
        collected.push(row);
      }
      if (start + reply.length / 2 < zcard && reply.length > 0) {
        next = { scan: String(start + limit) };
      }
    } else if (type === 'stream') {
      // 流内容（M7 收尾）：XRANGE 位置分页——游标 = 最后消费条目 id（独占起始 `(id`）；
      // 无游标时 offset 翻译为「取回后跳过」（O(offset)，与 SCAN 跳过同口径的已知限制）。
      // 取 limit+1 探测尽头；行 = [entry, fields(json 对象)]
      const lastId = req.cursor ? decodeCursorOrThrow(req.cursor).scan : null;
      const fetchCount = (lastId ? limit : skip + limit) + 1;
      const start = lastId ? `(${lastId}` : '-';
      const reply = (await this.raw(req.db, [
        'XRANGE', req.obj, start, '+', 'COUNT', String(fetchCount),
      ])) as unknown[];
      const entries = (reply as Array<[Buffer, Buffer[]]>).map(([id, pairs]) => {
        const fields: Record<string, unknown> = {};
        for (let i = 0; i + 1 < pairs.length; i += 2) {
          fields[utf8(pairs[i])] = encodeRedisValue(pairs[i + 1]);
        }
        return [utf8(id), fields] as unknown[];
      });
      const window = lastId ? entries.slice(0, limit) : entries.slice(skip, skip + limit);
      const hasNext = lastId ? entries.length > limit : entries.length > skip + limit;
      for (const row of window) {
        await guard();
        if (!matchRow(row, colNames, req.filters)) {
          continue;
        }
        if (
          req.search &&
          !(String(row[0]).includes(req.search) || JSON.stringify(row[1]).includes(req.search))
        ) {
          continue;
        }
        collected.push(row);
      }
      if (hasNext && window.length > 0) {
        next = { scan: String(window[window.length - 1]![0]) };
      }
    }

    // stream 的窗口切分已在分支内完成（offset/cursor 双路径），不再走通用 slice
    const page = collected.slice(
      ...(type === 'string' || type === 'stream' ? [0, undefined] : [skip, skip + limit]),
    );
    const outCols = this.project(cols, req.columns);
    const idx = new Map(outCols.map((c) => [c.name, colNames.indexOf(c.name)]));
    return {
      columns: outCols.map((c) => ({ name: c.name, type: c.normalizedType })),
      rows: page.map((row) => outCols.map((c) => row[idx.get(c.name)!])),
      rowCount: page.length,
      primaryKey: contentPrimaryKey(type),
      nextCursor: next ? cursorOf(next.scan, next.pending) : undefined,
      executionMs: Date.now() - started,
    };
  }

  /** 超时/取消守卫：SCAN 循环逐批检查（驱动规范 §7） */
  private guard(req: FetchRowsRequest): () => Promise<boolean> {
    const deadline = Date.now() + req.timeoutMs;
    return async () => {
      if (req.signal?.aborted) {
        throw new DriverError('E_CANCELED', '已取消');
      }
      if (Date.now() > deadline) {
        throw new DriverError('E_TIMEOUT', `操作超时（${req.timeoutMs}ms），可在设置中调整`);
      }
      return true;
    };
  }

  /** 页内局部排序已内联到 fetchPattern（SCAN 无服务端排序；不取全表，全局序以 SCAN 稳定序为准） */

  private project(cols: ColumnMeta[], columns?: string[]): ColumnMeta[] {
    if (!columns || columns.length === 0) {
      return cols;
    }
    return cols.filter((c) => columns.includes(c.name));
  }

  private async pipelineTtls(db: string, keys: string[]): Promise<Map<string, number>> {
    const ttls = new Map<string, number>();
    if (keys.length === 0) {
      return ttls;
    }
    const client = await this.getDbClient(db);
    try {
      await Promise.all(
        keys.map(async (key) => {
          ttls.set(key, await client.ttl(key));
        }),
      );
    } catch (err) {
      throw toRedisError(err);
    }
    return ttls;
  }

  // ── 命令控制台（§5.3：query() 只收单条命令文本）──────────────────

  async query(req: QueryRequest): Promise<ResultSet[]> {
    this.assertOpen();
    const lines = splitCommandLines(req.sql);
    if (lines.length === 0) {
      throw new DriverError('E_SYNTAX', '空命令');
    }
    if (lines.length > 1) {
      throw new DriverError('E_VALIDATION', '一次只能执行一条命令（每行一条，由控制台逐条调用）');
    }
    const tokens = tokenizeRedisCommand(lines[0].text);
    if (tokens === undefined) {
      throw new DriverError('E_SYNTAX', '命令包含未闭合的引号');
    }
    if (tokens.length === 0) {
      throw new DriverError('E_SYNTAX', '空命令');
    }
    const started = Date.now();
    const reply = await this.raw(req.db, tokens);
    const executionMs = Math.max(Date.now() - started, 1);
    return [replyToResultSet(tokens, reply, executionMs, req.maxRows)];
  }

  // ── 不可编辑（editable=false）：P-19 契约以 E_UNSUPPORTED 跳过变更集组 ──

  previewChanges(_db: string, _obj: string, _cs: ChangeSet): Promise<PreviewItem[]> {
    return Promise.reject(new DriverError('E_UNSUPPORTED', 'Redis 不支持表格编辑'));
  }

  applyChanges(_db: string, _obj: string, _cs: ChangeSet): Promise<ApplyResult> {
    return Promise.reject(new DriverError('E_UNSUPPORTED', 'Redis 不支持表格编辑'));
  }

  async getCompletionSource(_db?: string): Promise<CompletionSource> {
    return {
      keywords: [...REDIS_COMMAND_KEYWORDS],
      functions: [...REDIS_SUBCOMMAND_KEYWORDS],
      databases: (await this.listDatabases()).map((d) => d.name),
      tables: [],
      columns: [],
    };
  }

  async dispose(): Promise<void> {
    if (this.disposed) {
      return; // 幂等（驱动规范 §7）
    }
    this.disposed = true;
    const clients = [...this.clients.values()];
    this.clients.clear();
    await Promise.allSettled(clients.map((c) => c.quit()));
  }
}

/** 结构化筛选的内存匹配（与 conformance sqlMatch 三值语义一致；Redis 值无 NULL） */
function matchRow(row: unknown[], colNames: string[], filters?: FilterCondition[]): boolean {
  for (const f of filters ?? []) {
    const idx = colNames.indexOf(f.column);
    if (idx < 0) {
      throw new DriverError('E_VALIDATION', `未知筛选列 "${f.column}"`);
    }
    const v = row[idx];
    switch (f.op) {
      case 'isNull':
        return false; // Redis 列不存在 NULL
      case 'isNotNull':
        continue;
      case 'eq':
        if (!valEq(v, f.value)) return false;
        continue;
      case 'ne':
        if (valEq(v, f.value)) return false;
        continue;
      case 'gt':
        if (!(valCmp(v, f.value) > 0)) return false;
        continue;
      case 'ge':
        if (!(valCmp(v, f.value) >= 0)) return false;
        continue;
      case 'lt':
        if (!(valCmp(v, f.value) < 0)) return false;
        continue;
      case 'le':
        if (!(valCmp(v, f.value) <= 0)) return false;
        continue;
      case 'like':
        if (!String(v).includes(String(f.value ?? ''))) return false;
        continue;
      case 'notLike':
        if (String(v).includes(String(f.value ?? ''))) return false;
        continue;
      case 'in':
        if (!(f.values ?? []).some((x) => valEq(v, x))) return false;
        continue;
      case 'notIn':
        if ((f.values ?? []).some((x) => valEq(v, x))) return false;
        continue;
      case 'between': {
        const [lo, hi] = f.values ?? [];
        if (!(valCmp(v, lo) >= 0 && valCmp(v, hi) <= 0)) return false;
        continue;
      }
      default:
        throw new DriverError('E_VALIDATION', '筛选操作符不受支持');
    }
  }
  return true;
}

function toNum(v: unknown): number | undefined {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) return Number(v);
  return undefined;
}

function valEq(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  const na = toNum(a);
  const nb = toNum(b);
  return na !== undefined && nb !== undefined && na === nb;
}

function valCmp(a: unknown, b: unknown): number {
  const na = toNum(a);
  const nb = toNum(b);
  if (na !== undefined && nb !== undefined) return na - nb;
  const sa = String(a);
  const sb = String(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

function sortRows<T>(rows: T[], colNames: string[], sorts?: Array<{ column: string; dir: 'asc' | 'desc' }>): T[] {
  if (!sorts || sorts.length === 0) {
    return rows;
  }
  const sorted = [...rows];
  sorted.sort((a, b) => {
    for (const s of sorts) {
      const idx = colNames.indexOf(s.column);
      if (idx < 0) {
        throw new DriverError('E_VALIDATION', `未知排序列 "${s.column}"`);
      }
      const cmp = valCmp((a as unknown[])[idx], (b as unknown[])[idx]);
      if (cmp !== 0) {
        return s.dir === 'desc' ? -cmp : cmp;
      }
    }
    return 0;
  });
  return sorted;
}

/** 原始回复 → ResultSet（命令控制台展示） */
function replyToResultSet(tokens: string[], reply: unknown, executionMs: number, maxRows: number): ResultSet {
  const cmd = tokens[0].toUpperCase();

  // HGETALL：扁平 [f1,v1,f2,v2] → field/value 两列（类型化展示）
  if (cmd === 'HGETALL' && Array.isArray(reply)) {
    const rows: unknown[][] = [];
    for (let i = 0; i + 1 < reply.length; i += 2) {
      rows.push([encodeRedisValue(reply[i] as Buffer), encodeRedisValue(reply[i + 1] as Buffer)]);
    }
    return {
      columns: [
        { name: 'field', type: 'string' },
        { name: 'value', type: 'json' },
      ],
      rows: rows.slice(0, maxRows),
      rowCount: Math.min(rows.length, maxRows),
      truncated: rows.length > maxRows,
      executionMs,
    };
  }

  if (reply === null) {
    return {
      columns: [{ name: cmd, type: 'string' }],
      rows: [[null]],
      rowCount: 1,
      executionMs,
    };
  }

  if (Array.isArray(reply)) {
    const sliced = reply.slice(0, maxRows);
    return {
      columns: [{ name: cmd, type: 'string' }],
      rows: sliced.map((v) => [encodeRedisValue(v as Buffer)]),
      rowCount: sliced.length,
      truncated: reply.length > maxRows,
      executionMs,
    };
  }

  if (typeof reply === 'number' || typeof reply === 'boolean') {
    return {
      columns: [{ name: cmd, type: 'integer' }],
      rows: [[reply]],
      rowCount: 1,
      executionMs,
    };
  }

  const text = encodeRedisValue(reply as Buffer | string);
  return {
    columns: [{ name: cmd, type: typeof text === 'string' ? 'string' : 'json' }],
    rows: [[text]],
    rowCount: 1,
    truncated: false,
    executionMs,
  };
}

export function createRedisDriver(): IDatabaseDriver {
  return {
    id: REDIS_DRIVER_ID,
    displayName: 'Redis',
    apiVersion: 1,
    capabilities,
    getConnectionFormSchema: () => formSchema,
    testConnection: async (cfg: ConnectionConfig, secret: string): Promise<TestResult> => {
      const started = Date.now();
      const client = createRedisClient({
        socket: buildSocketOptions(cfg.options),
        username: cfg.options.username ? String(cfg.options.username) : undefined,
        password: secret || undefined,
        database: Number(cfg.options.database ?? 0),
      });
      try {
        await connectWithTimeout(client, Number(cfg.options.connectTimeout ?? 10_000));
        const info = await client.info('server');
        const version = /redis_version:([^\r\n]+)/.exec(info)?.[1]?.trim();
        await client.quit().catch(() => client.destroy()); // 不复用连接（驱动规范 §7）
        return { ok: true, latencyMs: Date.now() - started, serverVersion: version };
      } catch (err) {
        client.destroy(); // 连接失败处于重连等待态，quit() 会挂起，必须 destroy
        return { ok: false, error: toRedisError(err) };
      }
    },
    connect: (cfg: ConnectionConfig, secret: string) =>
      Promise.resolve(new RedisConnection(cfg, secret)),
  };
}
