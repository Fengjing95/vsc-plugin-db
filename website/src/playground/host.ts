import {
  ChangeSetService,
  DriverError,
  MetadataCache,
  ER_LAYOUT_CONSTS,
  assessStatementDanger,
  collectRelationGraph,
  isDdlStatement,
  layoutErGraph,
  specFromColumns,
  specFromTable,
  splitSqlStatements,
  type ColumnMeta,
  type ConnectionConfig,
  type EditOp,
  type FetchRowsRequest,
  type IConnection,
  type ResultSet,
  type TableSpec,
} from '@db-explorer/core';
import { createMockDriver, resetMockStore } from '@db-explorer/driver-mock';
import {
  ApplyChangesParamsSchema,
  ConsoleCancelParamsSchema,
  ConsoleCloseParamsSchema,
  ConsoleExecuteParamsSchema,
  ConsoleExportParamsSchema,
  ConsoleResolveBannerParamsSchema,
  ConsoleStateParamsSchema,
  CopyTextParamsSchema,
  DdlExecuteParamsSchema,
  DdlLoadParamsSchema,
  DdlPreviewParamsSchema,
  DdlRefColumnsParamsSchema,
  DdlRefTablesParamsSchema,
  EditChangesParamsSchema,
  ErGraphParamsSchema,
  ErOpenTableParamsSchema,
  FetchRowsParamsSchema,
  GetDdlParamsSchema,
  HandshakeParamsSchema,
  PreviewChangesParamsSchema,
  RevertChangesParamsSchema,
  RPC_PROTOCOL_VERSION,
  RpcEvents,
  RpcMethods,
  type ConsoleBanner,
  type ConsoleRun,
  type RpcError,
  type ViewUiState,
} from '@db-explorer/protocol';

/**
 * Playground 浏览器侧 Host：在页面里跑真驱动（driver-mock）+ 真权威副本（core ChangeSetService），
 * 经 protocol zod schema 校验后分发——与 extension rpcHost（rpc/rpcHost.ts）同一契约、同一语义。
 *
 * 与 VSCode 宿主的差异（演示口径）：
 * - 单一预置 mock 连接（connId 恒 'mock'），无 ConnectionManager / SecretStorage；
 * - EditGuard 恒可编辑（mock 数据无 prod 护栏意义），DangerGuard 表格提交不拦截；
 *   Console 危险语句走真实判定 + 横幅（evt:console.banner → resolveBanner）；
 * - export（表格）/ sys.pickFile 等依赖 VSCode 能力的方法报 E_UNKNOWN_METHOD；
 * - er.openTable / console.close 经钩子回调外壳（开 Tab / 关 Tab），DDL 执行后回调刷新树。
 */

export interface PlaygroundCtx {
  viewId: string;
  params: Record<string, string>;
  /** Host → Webview 单向事件（evt 帧），由 iframe glue 提供 */
  emit: (event: string, payload: unknown) => void;
}

/** dbExplorer.query.maxRows / timeoutMs 默认值（rpcHost / consoleService 同口径） */
const MAX_ROWS = 1000;
const QUERY_TIMEOUT_MS = 15_000;
/** 单例 Console 的 id（外壳只开一个 Console Tab） */
const CONSOLE_ID = 'main';
/** 预置 mock 连接 id */
const CONN_ID = 'mock';

/** extension consoleService 的 USE 拦截同款正则（consoleService.ts parseUseStatement） */
const USE_RE = /^\s*USE\s+`?([A-Za-z0-9_$]+)`?\s*;?\s*$/i;

/**
 * 浏览器 Buffer 垫片：driver-mock 的行生成器用 `Buffer.from(s).toString('base64')`
 * 生成二进制演示数据（demo.wide bin 列），浏览器无 Node Buffer。
 * 只垫演示数据实际用到的 API 面（from/alloc/isBuffer + toString base64/hex/utf8）。
 */
function installBrowserBufferShim(): void {
  const g = globalThis as { Buffer?: unknown };
  if (g.Buffer) return;
  const toBytes = (input: string, encoding?: string): Uint8Array => {
    if (encoding === 'base64') {
      const bin = atob(input);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return bytes;
    }
    return new TextEncoder().encode(input);
  };
  class ShimBuffer extends Uint8Array {
    toString(encoding?: string): string {
      if (encoding === 'base64') {
        let bin = '';
        for (const b of this) bin += String.fromCharCode(b);
        return btoa(bin);
      }
      if (encoding === 'hex') {
        return Array.from(this, (b) => b.toString(16).padStart(2, '0')).join('');
      }
      return new TextDecoder().decode(this);
    }
  }
  g.Buffer = {
    from: (input: string | Uint8Array, encoding?: string) =>
      new ShimBuffer(typeof input === 'string' ? toBytes(input, encoding) : input),
    alloc: (size: number) => new ShimBuffer(size),
    isBuffer: (v: unknown): v is Uint8Array => v instanceof Uint8Array,
  };
}
installBrowserBufferShim();

export class PlaygroundHost {
  private readonly driver = createMockDriver();
  private connPromise: Promise<IConnection> | null = null;
  private changesets = new ChangeSetService();
  private readonly cache = new MetadataCache();
  private readonly viewStates = new Map<string, ViewUiState>();
  /** 出现过的 viewId（reset 时逐个清空权威副本） */
  private readonly knownViews = new Set<string>();
  /** 当前请求的帧回调：ChangeSetService 订阅按它路由 evt:changeset.updated */
  private active: { viewId: string; emit: PlaygroundCtx['emit'] } | null = null;

  // ── 外壳回调（PlaygroundPage 挂载；Host 无法直接操作 React 状态）──
  /** er.openTable：ER 图节点双击 → 外壳开表格 Tab */
  onOpenTable?: (db: string, obj: string) => void;
  /** DDL 执行成功 → 外壳刷新该库对象清单（行数/新表） */
  onSchemaChanged?: (db: string) => void;
  /** console.close：Console 页 ✕ → 外壳关闭对应 Tab */
  onCloseConsole?: () => void;

  // ── 单例 Console 状态（consoleService 的 State 极简版）──
  private consoleDb: string | null = 'demo';
  private consoleRun: ConsoleRun | null = null;
  private consoleRunningTotal = 0;
  private consoleBanner: ConsoleBanner | null = null;
  private consolePending: { bannerId: string; resolve: (action: 'proceed' | 'cancel') => void } | null = null;
  private consoleAborted = false;
  private consoleSeq = 0;

  constructor() {
    this.changesets.subscribe((viewId, _cs, counts) => {
      if (this.active?.viewId === viewId) {
        this.active.emit(RpcEvents.changesetUpdated, { counts });
      }
    });
  }

  private conn(): Promise<IConnection> {
    this.connPromise ??= this.driver.connect(
      {
        id: 'mock',
        name: 'Playground Mock',
        driverId: 'mock',
        options: {},
        secretRef: '',
      } satisfies ConnectionConfig,
      '', // mock 驱动不消费 secret（接口签名要求占位）
    );
    return this.connPromise;
  }

  async handle(method: string, params: unknown, ctx: PlaygroundCtx): Promise<unknown> {
    this.active = { viewId: ctx.viewId, emit: ctx.emit };
    try {
      return await this.dispatch(method, params, ctx);
    } finally {
      this.active = null;
    }
  }

  private async dispatch(method: string, params: unknown, ctx: PlaygroundCtx): Promise<unknown> {
    switch (method) {
      case RpcMethods.handshake: {
        HandshakeParamsSchema.parse(params ?? {});
        return {
          protocolVersion: RPC_PROTOCOL_VERSION,
          viewId: ctx.viewId,
          params: ctx.params,
          changeSet: this.changesets.snapshot(ctx.viewId),
          uiState: this.viewStates.get(ctx.viewId),
          edit: { enabled: true },
          capabilities: { supportsSQL: true, supportsDdl: false, pagination: 'offset' },
        };
      }

      case RpcMethods.fetchRows: {
        const p = FetchRowsParamsSchema.parse(params);
        this.knownViews.add(ctx.viewId);
        const conn = await this.conn();
        const req = {
          db: p.db,
          obj: p.obj,
          limit: Math.min(p.limit, MAX_ROWS),
          offset: p.offset,
          columns: p.columns,
          filters: p.filters,
          sorts: p.sorts,
          search: p.search,
          whereSql: p.whereSql,
          orderBySql: p.orderBySql,
        } as FetchRowsRequest;
        const rs: ResultSet = await conn.fetchRows(req);
        return rs;
      }

      // ── 表格编辑（权威副本在 Host，预览/提交不传 ChangeSet——与 rpcHost 同构）──
      case RpcMethods.editChanges: {
        const p = EditChangesParamsSchema.parse(params);
        this.knownViews.add(ctx.viewId);
        for (const op of p.ops) {
          this.changesets.applyOp(ctx.viewId, op as EditOp);
        }
        if (p.uiState) {
          this.viewStates.set(ctx.viewId, p.uiState);
        }
        return { counts: this.changesets.counts(ctx.viewId) };
      }

      case RpcMethods.previewChanges: {
        const p = PreviewChangesParamsSchema.parse(params);
        const cs = this.changesets.snapshot(ctx.viewId);
        if (cs.inserts.length + cs.updates.length + cs.deletes.length === 0) {
          throw new DriverError('E_VALIDATION', '没有可提交的变更');
        }
        const conn = await this.conn();
        return { items: await conn.previewChanges(p.db, p.obj, cs) };
      }

      case RpcMethods.applyChanges: {
        const p = ApplyChangesParamsSchema.parse(params);
        const cs = this.changesets.snapshot(ctx.viewId);
        if (cs.inserts.length + cs.updates.length + cs.deletes.length === 0) {
          throw new DriverError('E_VALIDATION', '没有可提交的变更');
        }
        const conn = await this.conn();
        try {
          const result = await conn.applyChanges(p.db, p.obj, cs);
          this.changesets.clear(ctx.viewId); // 订阅推送 evt:changeset.updated 归零
          return result;
        } catch (err) {
          // 错误行定位（驱动规范 §8-1）→ evt:row.error 高亮（rpcHost 同构）
          if (DriverError.is(err) && err.meta) {
            ctx.emit(RpcEvents.rowError, {
              kind: err.meta.kind,
              tempId: err.meta.tempId,
              rowKey: err.meta.rowKey,
              code: err.code,
              message: err.message,
            });
          }
          throw err;
        }
      }

      case RpcMethods.revertChanges: {
        const p = RevertChangesParamsSchema.parse(params);
        if (p.target.scope === 'all') {
          this.changesets.clear(ctx.viewId);
        } else if (p.target.scope === 'row') {
          this.changesets.applyOp(ctx.viewId, { op: 'revertRow', rowKey: p.target.rowKey });
        } else {
          this.changesets.applyOp(ctx.viewId, { op: 'removeRow', tempId: p.target.tempId });
        }
        return { counts: this.changesets.counts(ctx.viewId) };
      }

      case RpcMethods.getDdl: {
        const p = GetDdlParamsSchema.parse(params);
        const conn = await this.conn();
        if (typeof conn.getDdl !== 'function') {
          throw new DriverError('E_UNSUPPORTED', '当前驱动未实现 DDL 查看');
        }
        return { ddl: await conn.getDdl(p.db, p.obj) };
      }

      case RpcMethods.copyText: {
        const p = CopyTextParamsSchema.parse(params);
        await navigator.clipboard.writeText(p.text);
        return { written: p.text.length };
      }

      // ── M5 SQL Console（执行结果经 evt 推送；execute 同步返回 void——与 consoleService 一致）──
      case RpcMethods.consoleState: {
        const p = ConsoleStateParamsSchema.parse(params ?? {});
        return this.consoleStateResult(p.consoleId || CONSOLE_ID);
      }

      case RpcMethods.consoleExecute: {
        const p = ConsoleExecuteParamsSchema.parse(params);
        const consoleId = p.consoleId || CONSOLE_ID;
        // 后台执行：结果经 evt:console.running/updated 推送（webview 侧超时 0，不依赖响应帧）
        void this.consoleRunStatements(consoleId, p.sql, ctx.emit);
        return undefined;
      }

      case RpcMethods.consoleCancel: {
        ConsoleCancelParamsSchema.parse(params);
        this.consoleAborted = true;
        return {};
      }

      case RpcMethods.consoleResolveBanner: {
        const p = ConsoleResolveBannerParamsSchema.parse(params);
        if (this.consolePending?.bannerId === p.bannerId) {
          this.consolePending.resolve(p.action);
        }
        return {};
      }

      case RpcMethods.consoleExport: {
        const p = ConsoleExportParamsSchema.parse(params);
        return this.consoleExportResult(p.consoleId || CONSOLE_ID, p.itemSeq, p.format);
      }

      case RpcMethods.consoleClose: {
        ConsoleCloseParamsSchema.parse(params ?? {});
        this.onCloseConsole?.();
        return {};
      }

      // ── M8-ER（关系收集/分层布局在 core，与 erService 同构；元数据经 MetadataCache 缓存）──
      case RpcMethods.erGraph: {
        const p = ErGraphParamsSchema.parse(params);
        if (p.refresh) {
          this.cache.invalidateDb(CONN_ID, p.db);
        }
        const conn = await this.conn();
        const listKeys = typeof conn.listKeys === 'function' ? (db: string, obj: string) => conn.listKeys!(db, obj) : undefined;
        const src = {
          listObjects: (db: string) => this.cache.getObjects(CONN_ID, db, () => conn.listObjects(db)),
          listColumns: (db: string, obj: string) =>
            this.cache.getColumns(CONN_ID, db, obj, () => conn.listColumns(db, obj)),
          ...(listKeys
            ? { listKeys: (db: string, obj: string) => this.cache.getKeys(CONN_ID, db, obj, () => listKeys(db, obj)) }
            : {}),
        };
        const graph = await collectRelationGraph(src, p.db, p.scope);
        const layout = layoutErGraph(
          graph.tables.map((t) => ({ name: t.name, rows: t.columns.length })),
          graph.edges.map((e) => ({ source: e.sourceTable, target: e.targetTable })),
        );
        return {
          tables: graph.tables,
          edges: graph.edges,
          layout: { nodes: layout.nodes, width: layout.width, height: layout.height, ...ER_LAYOUT_CONSTS },
          tableCount: graph.tables.length,
          hiddenEdges: graph.hiddenEdges,
        };
      }

      case RpcMethods.erOpenTable: {
        const p = ErOpenTableParamsSchema.parse(params);
        this.onOpenTable?.(p.db, p.table);
        return {};
      }

      // ── M8-B2 表设计器（与 ddlService 同构：预览/执行同源重建语句，不信任回传 SQL）──
      case RpcMethods.ddlLoad: {
        const p = DdlLoadParamsSchema.parse(params);
        const conn = await this.conn();
        const dataTypes = conn.listDataTypes?.() ?? [];
        const features = this.driver.capabilities.tableDesign;
        if (!p.obj) {
          return { kind: 'create', spec: null, dataTypes, features };
        }
        const spec = await this.ddlBaseline(conn, p.db, p.obj);
        return { kind: 'alter', spec, dataTypes, features };
      }

      case RpcMethods.ddlPreview: {
        const p = DdlPreviewParamsSchema.parse(params);
        const conn = await this.conn();
        const statements = await this.ddlBuildStatements(conn, p.db, p.obj, p.spec);
        return { kind: p.obj ? 'alter' : 'create', statements };
      }

      case RpcMethods.ddlExecute: {
        const p = DdlExecuteParamsSchema.parse(params);
        const conn = await this.conn();
        const statements = await this.ddlBuildStatements(conn, p.db, p.obj, p.spec);
        let executed = 0;
        for (let i = 0; i < statements.length; i++) {
          try {
            await conn.query({ sql: statements[i].sql, db: p.db, maxRows: 1, timeoutMs: QUERY_TIMEOUT_MS });
            executed++;
          } catch (err) {
            const e = this.toRpcError(err);
            return { executed, failed: { index: i + 1, code: e.code, message: e.message } };
          }
        }
        this.cache.invalidateDb(CONN_ID, p.db);
        this.onSchemaChanged?.(p.db);
        return { executed };
      }

      case RpcMethods.ddlRefTables: {
        const p = DdlRefTablesParamsSchema.parse(params);
        const conn = await this.conn();
        const objects = await conn.listObjects(p.db);
        return { tables: objects.filter((o) => o.kind === 'table').map((o) => o.name) };
      }

      case RpcMethods.ddlRefColumns: {
        const p = DdlRefColumnsParamsSchema.parse(params);
        const conn = await this.conn();
        const columns = await conn.listColumns(p.db, p.table);
        return { columns: columns.map((c) => c.name) };
      }

      case RpcMethods.ddlClose: {
        return {};
      }

      default:
        // E_UNKNOWN_METHOD 属 RPC 层错误码（非 DriverErrorCode），按形状抛给 toRpcError
        throw {
          code: 'E_UNKNOWN_METHOD',
          message: `Playground 暂不支持 "${method}"`,
        };
    }
  }

  // ── 侧栏树数据源（不经 RPC：外壳与 Host 同文档）──

  async listDatabases(): Promise<{ name: string; comment?: string }[]> {
    const conn = await this.conn();
    const rows = await conn.listDatabases();
    return rows.map((d) => ({ name: d.name, comment: d.comment }));
  }

  async listObjects(db: string): Promise<{ name: string; kind: string; comment?: string; rowEstimate?: number }[]> {
    const conn = await this.conn();
    return conn.listObjects(db);
  }

  /** 重置演示数据：清空 mock 物化存储、元数据缓存与全部视图权威副本（外壳负责刷新 iframe） */
  reset(): void {
    resetMockStore();
    this.cache.clear();
    this.viewStates.clear();
    for (const viewId of this.knownViews) {
      this.changesets.clear(viewId);
    }
    this.knownViews.clear();
    this.consoleDb = 'demo';
    this.consoleRun = null;
    this.consoleBanner = null;
    this.consolePending = null;
    this.consoleAborted = false;
  }

  // ── SQL Console（consoleService.runStatements 的浏览器极简同构：切分/危险横幅/USE 拦截/逐语句推送）──

  private consoleStateResult(consoleId: string) {
    const running =
      this.consoleRun && this.consoleRun.status === 'running'
        ? { runId: this.consoleRun.runId, total: this.consoleRunningTotal }
        : undefined;
    return {
      consoleId,
      bound: true,
      connLabel: 'Mock 数据源（演示）',
      db: this.consoleDb,
      running,
      banner: this.consoleBanner,
      run: this.consoleRun,
    };
  }

  private async consoleRunStatements(consoleId: string, sql: string, emit: PlaygroundCtx['emit']): Promise<void> {
    const texts = splitSqlStatements(sql)
      .map((s) => s.text)
      .filter((t) => t.trim().length > 0);
    if (texts.length === 0) return;
    if (this.consoleRun && this.consoleRun.status === 'running') return; // 已有执行在进行中

    // 危险判定（core sqlDanger；node-sql-parser 被 stub → 正则降级路径，判定口径 fail-closed 不变）
    const offending: string[] = [];
    const reasons = new Set<string>();
    for (const t of texts) {
      const a = assessStatementDanger(t);
      if (a.dangerous) {
        offending.push(t);
        for (const r of a.reasons) reasons.add(r);
      }
    }
    if (offending.length > 0) {
      const bannerId = `banner-${Date.now()}`;
      this.consoleBanner = { bannerId, reasons: [...reasons], sql: offending.join(';\n') };
      emit(RpcEvents.consoleBanner, { consoleId, banner: this.consoleBanner });
      const action = await new Promise<'proceed' | 'cancel'>((resolve) => {
        this.consolePending = { bannerId, resolve };
      });
      this.consoleBanner = null;
      this.consolePending = null;
      emit(RpcEvents.consoleBanner, { consoleId, banner: null });
      if (action === 'cancel') return;
    }

    const run: ConsoleRun = {
      consoleId,
      runId: `run-${Date.now()}-${++this.consoleSeq}`,
      startedAt: Date.now(),
      durationMs: 0,
      status: 'running',
      items: [],
    };
    this.consoleRun = run;
    this.consoleRunningTotal = texts.length;
    this.consoleAborted = false;
    emit(RpcEvents.consoleRunning, { consoleId, runId: run.runId, total: texts.length });
    const push = () => emit(RpcEvents.consoleUpdated, { consoleId, run: { ...run, items: [...run.items] } });

    const conn = await this.conn();
    try {
      let db: string = this.consoleDb ?? 'demo';
      for (const text of texts) {
        if (this.consoleAborted) {
          run.status = 'canceled';
          break;
        }
        const useTarget = USE_RE.exec(text)?.[1];
        if (useTarget) {
          // USE 不下发驱动（P-36：池化下 USE 只改写单连接），Host 改绑定并产出消息型 item
          this.consoleDb = useTarget;
          db = useTarget;
          run.items.push({
            seq: run.items.length + 1,
            sql: text,
            executionMs: 0,
            affectedRows: 0,
            messages: [`已切换到数据库 ${useTarget}（Console 绑定已更新）`],
          });
          push();
          continue;
        }
        try {
          const resultSets: ResultSet[] = await conn.query({ sql: text, db, maxRows: MAX_ROWS, timeoutMs: QUERY_TIMEOUT_MS });
          for (const rs of resultSets) {
            run.items.push(
              rs.affectedRows !== undefined
                ? {
                    seq: run.items.length + 1,
                    sql: text,
                    executionMs: rs.executionMs,
                    affectedRows: rs.affectedRows,
                    messages: rs.messages,
                  }
                : {
                    seq: run.items.length + 1,
                    sql: text,
                    executionMs: rs.executionMs,
                    resultSet: {
                      columns: rs.columns,
                      rows: rs.rows,
                      rowCount: rs.rowCount,
                      totalCount: rs.totalCount,
                      executionMs: rs.executionMs,
                      truncated: rs.truncated,
                    },
                  },
            );
          }
          // DDL 后失效元数据缓存 + 通知外壳刷新树（consoleService 同款联动）
          if (isDdlStatement(text) && db) {
            this.cache.invalidateDb(CONN_ID, db);
            this.onSchemaChanged?.(db);
          }
          push();
        } catch (err) {
          const e = this.toRpcError(err);
          run.items.push({ seq: run.items.length + 1, sql: text, executionMs: 0, error: { code: e.code, message: e.message } });
          run.status = this.consoleAborted ? 'canceled' : 'error';
          break; // 失败即停
        }
      }
    } finally {
      if (run.status === 'running') run.status = 'ok';
      run.durationMs = Date.now() - run.startedAt;
      push();
    }
  }

  /** Console 结果导出：浏览器侧 Blob 下载（xlsx 按 consolePanel 口径降级为 csv） */
  private consoleExportResult(consoleId: string, itemSeq: number, format: 'csv' | 'json' | 'xlsx') {
    const item = this.consoleRun?.items.find((i) => i.seq === itemSeq);
    const rs = item?.resultSet;
    if (!rs) {
      throw new DriverError('E_VALIDATION', '该结果不可导出');
    }
    const effective = format === 'json' ? 'json' : 'csv';
    let body: string;
    if (effective === 'json') {
      body = JSON.stringify(
        rs.rows.map((row) => Object.fromEntries(rs.columns.map((c, i) => [c.name, row[i] ?? null]))),
        null,
        2,
      );
    } else {
      const cell = (v: unknown): string => {
        const s = v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
        return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      };
      body = [
        rs.columns.map((c) => cell(c.name)).join(','),
        ...rs.rows.map((row) => row.map((v) => cell(v)).join(',')),
      ].join('\n');
    }
    const blob = new Blob([body], { type: effective === 'json' ? 'application/json' : 'text/csv' });
    const name = `结果-${itemSeq}.${effective}`;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
    void consoleId;
    return { filePath: name, rows: rs.rowCount, bytes: blob.size };
  }

  // ── 表设计器基线（ddlService.baselineOf 同构：列 + 键/索引 → core specFromTable）──

  private async ddlBaseline(conn: IConnection, db: string, obj: string, comment?: string): Promise<TableSpec> {
    const metas: ColumnMeta[] = await conn.listColumns(db, obj);
    if (typeof conn.listKeys !== 'function' || typeof conn.listIndexes !== 'function') {
      return specFromColumns(obj, metas, comment);
    }
    const [keys, indexes] = await Promise.all([conn.listKeys(db, obj), conn.listIndexes(db, obj)]);
    return specFromTable(obj, metas, comment, keys, indexes);
  }

  private async ddlBuildStatements(
    conn: IConnection,
    db: string,
    obj: string | undefined,
    spec: TableSpec,
  ): Promise<{ sql: string; destructive?: boolean }[]> {
    if (!obj) {
      if (typeof conn.buildCreateTable !== 'function') {
        throw new DriverError('E_UNSUPPORTED', '当前驱动未实现建表语句生成');
      }
      return conn.buildCreateTable(db, spec);
    }
    if (typeof conn.buildAlterTable !== 'function') {
      throw new DriverError('E_UNSUPPORTED', '当前驱动未实现改表语句生成');
    }
    let comment: string | undefined;
    try {
      comment = (await conn.listObjects(db)).find((o) => o.name === obj)?.comment;
    } catch {
      // 注释取不到不阻塞
    }
    const current = await this.ddlBaseline(conn, db, obj, comment);
    return conn.buildAlterTable(db, obj, spec, current);
  }

  toRpcError(err: unknown): RpcError {
    if (DriverError.is(err)) {
      return { code: err.code, message: err.message, detail: err.detail };
    }
    if (err && typeof err === 'object' && 'code' in err) {
      const e = err as { code: string; message?: string; detail?: string };
      return { code: e.code as RpcError['code'], message: e.message ?? '请求失败', detail: e.detail };
    }
    return { code: 'E_INTERNAL', message: 'Playground 内部错误', detail: String(err) };
  }
}

declare global {
  interface Window {
    /** iframe glue 经 window.parent 取用（同源静态托管） */
    __DBX_HOST__?: PlaygroundHost;
  }
}

/** 必须先于任何 webview iframe 挂载调用（glue postMessage 依赖 window.parent.__DBX_HOST__） */
export function installPlaygroundHost(): PlaygroundHost {
  window.__DBX_HOST__ ??= new PlaygroundHost();
  return window.__DBX_HOST__;
}
