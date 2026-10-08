import * as vscode from 'vscode';
import {
  DriverError,
  isDdlStatement,
  isProvablyReadRedisCommand,
  isSessionStateStatement,
  splitCommandLines,
  splitSqlStatements,
  statementAtOffset,
  type CompletionSource,
  type DriverHost,
  type MetadataCache,
  type SqlStatement,
} from '@db-explorer/core';
import {
  RpcEvents,
  type ConsoleBanner,
  type ConsoleRun,
  type ConsoleRunItem,
  type ConsoleStateResult,
} from '@db-explorer/protocol';
import { csvRow, toJsonObject } from './csvJson';
import type { ConnectionManager } from './connectionManager';
import { describeError, type Logger } from './logger';
import { revealConsoleResultView, pushToConsolePanel } from '../views/consolePanel';
import type { ConsoleHistory } from './consoleHistory';
import type { EditGuard } from './editGuard';
import type { SessionManager } from './sessionManager';
import type { ExecutionAnnotations } from './sqlExecutionDecorations';
import { writeXlsxFile } from './xlsxWriter';

/**
 * M5 SQL Console 服务（概要设计 §5.5 / 交互稿 §7）：
 * - 文档绑定：untitled 文档内存 Map，另存 .sql 后绑定持久化到 workspaceState（§7.1）
 * - 执行链：语句切分 → 只读 fail-closed → 危险横幅/Modal → 逐语句执行（进度可取消）
 *   → 结果增量推送结果面板 → 历史（拦截不落历史）→ DDL 失效联动（§7.5）
 * - ConsoleEditor 门面预案（D-02）：执行/补全/历史逻辑只依赖文档与绑定，不依赖编辑器形态
 */

const FILE_BINDINGS_KEY = 'dbExplorer.console.fileBindings';
/** C-9：单次传输行数上限 */
const MAX_RESULT_ROWS = 5000;

/** 执行来源文档快照：语句偏移随 texts 一一对应（行内执行结果注记用；文档编辑后版本不符即丢弃） */
interface ExecutionOrigin {
  uri: vscode.Uri;
  version: number;
  ranges: Array<{ start: number; end: number }>;
}

/** 注记渲染终点：越过语句尾分号——after 装饰渲染在 range 终点，而 sqlScript 的 end 恰停在
 *  分号处（不含分号），不越过分号则耗时/错误文本会插在语句与分号之间 */
function annotationEnd(text: string, end: number): number {
  return text.charCodeAt(end) === 59 /* ';' */ ? end + 1 : end;
}

/** 事务动词识别（§4.6）：BEGIN/START TRANSACTION、COMMIT、ROLLBACK（仅 SQL 模式且驱动具备能力时接管） */
function matchTxnVerb(sql: string): 'begin' | 'commit' | 'rollback' | undefined {
  if (/^\s*(BEGIN|START\s+TRANSACTION)\b/i.test(sql)) {
    return 'begin';
  }
  if (/^\s*COMMIT\b/i.test(sql)) {
    return 'commit';
  }
  if (/^\s*ROLLBACK\b/i.test(sql)) {
    return 'rollback';
  }
  return undefined;
}

/**
 * USE 语句目标库解析（P-36）：连接池上执行 USE 只改写单个物理连接，后续语句可能拿到
 * 别的连接——Console 里的 USE 必须改绑定而不是下发。undefined = 非 USE 语句；
 * null = 是 USE 但目标库名无法解析。
 */
function parseUseStatement(sql: string): string | null | undefined {
  const m = /^\s*USE\s+`?([A-Za-z0-9_$]+)`?\s*;?\s*$/i.exec(sql);
  if (!m) {
    return /^\s*USE\b/i.test(sql) ? null : undefined;
  }
  return m[1];
}

/** 事务动作的消息型结果（进「消息」Tab） */
function txnMessageRs(message: string): import('@db-explorer/core').ResultSet {
  return { columns: [], rows: [], rowCount: 0, affectedRows: 0, messages: [message], executionMs: 0 };
}

export interface FileBinding {
  consoleId: string;
  connId: string;
  db: string | null;
}

interface ConsoleState {
  consoleId: string;
  connId: string;
  db: string | null;
  run: ConsoleRun | null;
  banner: ConsoleBanner | null;
  /** 悬挂中的危险横幅（等待结果面板确认） */
  pendingBanner?: { bannerId: string; resolve: (action: 'proceed' | 'cancel') => void };
  controller?: AbortController;
  /** 本轮执行的语句总数（结果面板“执行中 N/M”展示） */
  runningTotal?: number;
  /** 刚关闭的 untitled 文档指纹（另存迁移匹配用，§7.1） */
}

export class ConsoleService implements vscode.Disposable {
  /** consoleId → 状态（consoleId 在首次绑定时生成，保存/另存不变） */
  private readonly consoles = new Map<string, ConsoleState>();
  /** untitled 文档绑定（uri string → consoleId），进程内存（§7.1） */
  private readonly untitledBindings = new Map<string, string>();
  /** 文件绑定（fsPath → binding），workspaceState 持久化 */
  private readonly fileBindings: Map<string, FileBinding>;
  private readonly bindingsChangedEmitter = new vscode.EventEmitter<void>();
  readonly onBindingsChanged = this.bindingsChangedEmitter.event;
  private seq = 0;

  private readonly statusItem: vscode.StatusBarItem;
  private readonly disposables: vscode.Disposable[] = [];
  /** untitled 关闭后的绑定回收定时器（另存迁移窗口，§7.1） */
  private readonly pendingTimers = new Set<ReturnType<typeof setTimeout>>();
  private lastClosedUntitled?: { key: string; textHash: string; at: number };
  /** 底部结果视图当前跟随的 Console（空串 = 无；执行/横幅时切换，evt:console.activated 同步） */
  private lastActiveConsoleId = '';

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly connections: ConnectionManager,
    private readonly cache: MetadataCache,
    private readonly editGuard: EditGuard,
    private readonly history: ConsoleHistory,
    /** M7 交互式事务（§4.6/D-09）：BEGIN/COMMIT/ROLLBACK 接管与会话内语句路由 */
    private readonly sessions: SessionManager,
    /** 查询统一入口（LoggingDriverHost 拦截日志，extension 组装注入，概要 §5.10） */
    private readonly host: DriverHost,
    private readonly logger: Logger,
    /** DDL 执行后联动树刷新（概要 §7.5） */
    private readonly refreshTree: () => void,
    /** 行内执行结果注记（sqlExecutionDecorations）：语句行尾耗时/错误 + gutter 图标，缺省不注记 */
    private readonly annotations?: ExecutionAnnotations,
  ) {
    this.fileBindings = new Map(
      Object.entries(context.workspaceState.get<Record<string, FileBinding>>(FILE_BINDINGS_KEY) ?? {}),
    );

    this.statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
    this.statusItem.name = 'SQL Console 连接';
    this.statusItem.command = 'dbExplorer.consoleSelectConnection';
    this.statusItem.tooltip = 'SQL Console：点击选择连接/数据库';
    this.statusItem.text = '$(database) 未绑定连接';
    this.statusItem.show();

    this.disposables.push(
      this.statusItem,
      this.bindingsChangedEmitter,
      vscode.window.onDidChangeActiveTextEditor(() => this.updateStatusBar()),
      vscode.workspace.onDidOpenTextDocument((doc) => this.onDocumentOpened(doc)),
      vscode.workspace.onDidCloseTextDocument((doc) => this.onDocumentClosed(doc)),
      vscode.workspace.onDidSaveTextDocument((doc) => this.onDocumentSaved(doc)),
    );
    // 已打开的文件恢复绑定（§7.1：重新打开文件自动恢复）
    for (const doc of vscode.workspace.textDocuments) {
      this.onDocumentOpened(doc);
    }
    this.updateStatusBar();
  }

  dispose(): void {
    for (const state of this.consoles.values()) {
      state.controller?.abort();
      state.pendingBanner?.resolve('cancel');
    }
    this.consoles.clear();
    for (const timer of this.pendingTimers) {
      clearTimeout(timer);
    }
    this.pendingTimers.clear();
    for (const d of this.disposables) {
      d.dispose();
    }
  }

  // ── 绑定（§7.1）──────────────────────────────────────────

  /** 文档 → 绑定状态（未绑定为 undefined） */
  bindingForDocument(doc: vscode.TextDocument): ConsoleState | undefined {
    const consoleId =
      doc.uri.scheme === 'untitled'
        ? this.untitledBindings.get(doc.uri.toString())
        : this.fileBindings.get(doc.uri.fsPath)?.consoleId;
    return consoleId ? this.consoles.get(consoleId) : undefined;
  }

  /** 已绑定文件路径（补全 provider 动态注册用，P1-1） */
  boundFilePaths(): string[] {
    return [...this.fileBindings.keys()];
  }

  /** 新建 Console：untitled sql 文档 + 绑定 + 补全预热 */
  async newConsole(
    prefill?: { connId?: string; db?: string },
    initialText?: string,
    opts?: { autoExecute?: boolean },
  ): Promise<void> {
    const doc = await vscode.workspace.openTextDocument({ language: 'sql', content: initialText ?? '' });
    const editor = await vscode.window.showTextDocument(doc, { preview: false });
    const state = await this.ensureBinding(editor.document, prefill);
    if (!state) {
      return; // 用户取消选择连接：文档保留，可稍后经状态栏绑定
    }
    if (opts?.autoExecute && initialText) {
      await this.executeDocument(editor, 'all');
    }
  }

  /** 确保文档已绑定；未绑定时交互选择（交互稿 §7.1：未绑定执行 → 提示选择连接） */
  async ensureBinding(
    doc: vscode.TextDocument,
    prefill?: { connId?: string; db?: string },
  ): Promise<ConsoleState | undefined> {
    const existing = this.bindingForDocument(doc);
    if (existing) {
      return existing;
    }
    const key = doc.uri.scheme === 'untitled' ? doc.uri.toString() : doc.uri.fsPath;
    const savedFile = doc.uri.scheme === 'file' ? this.fileBindings.get(key) : undefined;
    if (savedFile) {
      return this.createState(savedFile.consoleId, savedFile.connId, savedFile.db);
    }

    let connId = prefill?.connId;
    let db = prefill?.db ?? null;
    if (!connId) {
      const picked = await this.pickConnection();
      if (!picked) {
        return undefined;
      }
      connId = picked.connId;
      db = picked.db;
    } else if (db === undefined) {
      const cfg = this.connections.getConfig(connId);
      db = typeof cfg?.options.database === 'string' && cfg.options.database ? cfg.options.database : null;
    }

    const consoleId = `console-${++this.seq}`;
    if (doc.uri.scheme === 'untitled') {
      this.untitledBindings.set(key, consoleId);
    } else {
      await this.saveFileBinding(doc.uri.fsPath, { consoleId, connId, db });
    }
    const state = this.createState(consoleId, connId, db);
    this.updateStatusBar();
    return state;
  }

  /** 状态栏点击：切换连接/库（列出该连接的库，交互稿 §7.1） */
  async selectConnectionForActiveEditor(): Promise<void> {
    const doc = vscode.window.activeTextEditor?.document;
    if (!doc || doc.languageId !== 'sql') {
      void vscode.window.showInformationMessage('当前编辑器不是 SQL 文档。');
      return;
    }
    const picked = await this.pickConnection();
    if (!picked) {
      return;
    }
    // 刚选好的连接/库作为 prefill 建绑定——未绑定文档否则会在 ensureBinding 内部再次交互选择（选两遍）
    const state =
      this.bindingForDocument(doc) ??
      (await this.ensureBinding(doc, { connId: picked.connId, db: picked.db ?? undefined }));
    if (!state) {
      return;
    }
    state.connId = picked.connId;
    state.db = picked.db;
    this.logger.info('console', `${state.consoleId} 重新绑定 → ${picked.connId}${picked.db ? `/${picked.db}` : ''}`);
    this.preheatCompletions(state);
    this.bindingsChangedEmitter.fire();
    this.updateStatusBar();
  }

  /**
   * 执行时的库选择（§7.1 延伸）：绑定库为空时兜底。
   * 返回：string = 用户选择；null = 数据源无库概念（放行）；undefined = 用户取消（终止执行）。
   */
  private async pickDatabaseForConsole(
    conn: Awaited<ReturnType<ConnectionManager['ensureConnected']>>,
  ): Promise<string | null | undefined> {
    let databases: string[] = [];
    try {
      databases = (await conn.listDatabases()).map((d) => d.name);
    } catch {
      // 列库失败不阻塞（无库概念数据源）
    }
    if (databases.length === 0) {
      return null;
    }
    if (databases.length === 1) {
      return databases[0];
    }
    const picked = await vscode.window.showQuickPick(
      databases.map((d) => ({ label: d, db: d })),
      { title: '选择数据库', placeHolder: '本次执行使用的库（将更新 Console 绑定）' },
    );
    return picked?.db;
  }

  private async pickConnection(): Promise<{ connId: string; db: string | null } | undefined> {    const configs = await this.connections.listConfigs();
    if (configs.length === 0) {
      void vscode.window.showInformationMessage('尚无连接，请先新建连接。');
      return undefined;
    }
    const picked = await vscode.window.showQuickPick(
      configs.map((c) => ({
        label: c.name,
        description: [c.driverId, c.env, c.readOnly ? '只读' : undefined].filter(Boolean).join(' · '),
        connId: c.id,
      })),
      { title: '选择连接', placeHolder: 'SQL Console 绑定的连接' },
    );
    if (!picked) {
      return undefined;
    }
    const cfg = this.connections.getConfig(picked.connId);
    const defaultDb = typeof cfg?.options.database === 'string' && cfg.options.database ? cfg.options.database : null;

    let conn: Awaited<ReturnType<ConnectionManager['ensureConnected']>>;
    try {
      conn = await this.connections.ensureConnected(picked.connId);
    } catch (err) {
      void vscode.window.showErrorMessage(
        `连接失败：${err instanceof Error ? err.message : String(err)}`,
      );
      return undefined;
    }

    let databases: string[] = [];
    try {
      databases = (await conn.listDatabases()).map((d) => d.name);
    } catch {
      // 列库失败不阻塞绑定（某些数据源无库概念）
    }
    let db: string | null = defaultDb;
    if (databases.length > 0) {
      const dbPicked = await vscode.window.showQuickPick(
        [{ label: '(不指定库)', db: null as string | null }, ...databases.map((d) => ({ label: d, db: d as string | null }))],
        { title: '选择数据库', placeHolder: '执行 SQL 时使用的默认库' },
      );
      if (!dbPicked) {
        return undefined;
      }
      db = dbPicked.db;
    }
    return { connId: picked.connId, db };
  }

  private createState(consoleId: string, connId: string, db: string | null): ConsoleState {
    const existing = this.consoles.get(consoleId);
    if (existing) {
      return existing;
    }
    const state: ConsoleState = { consoleId, connId, db, run: null, banner: null };
    this.consoles.set(consoleId, state);
    // 首个 Console 作为底部视图的默认跟随对象（面板先于执行被手动打开时不至于空白）
    if (!this.lastActiveConsoleId) {
      this.lastActiveConsoleId = consoleId;
    }
    this.preheatCompletions(state);
    this.bindingsChangedEmitter.fire();
    return state;
  }

  private async saveFileBinding(fsPath: string, binding: FileBinding): Promise<void> {
    this.fileBindings.set(fsPath, binding);
    await this.context.workspaceState.update(
      FILE_BINDINGS_KEY,
      Object.fromEntries(this.fileBindings.entries()),
    );
    this.bindingsChangedEmitter.fire();
  }

  private onDocumentOpened(doc: vscode.TextDocument): void {
    if (doc.uri.scheme === 'file' && doc.languageId === 'sql' && this.fileBindings.has(doc.uri.fsPath)) {
      this.updateStatusBar();
      this.bindingsChangedEmitter.fire();
    }
  }

  private onDocumentClosed(doc: vscode.TextDocument): void {
    if (doc.uri.scheme === 'untitled') {
      // untitled 关闭（手动关闭或另存）：绑定延迟清理——另存流程中
      // onDidSaveTextDocument 需要借它完成迁移（§7.1）；纯关闭 10s 后回收
      const key = doc.uri.toString();
      this.lastClosedUntitled = { key, textHash: doc.getText(), at: Date.now() };
      const timer = setTimeout(() => {
        this.pendingTimers.delete(timer);
        this.untitledBindings.delete(key);
        this.bindingsChangedEmitter.fire();
      }, 10_000);
      this.pendingTimers.add(timer);
      this.updateStatusBar();
      this.bindingsChangedEmitter.fire();
    }
  }

  /** 另存迁移（§7.1）：untitled → .sql 文件后绑定持久化，consoleId 不变（结果面板延续） */
  private onDocumentSaved(doc: vscode.TextDocument): void {
    if (doc.uri.scheme !== 'file' || doc.languageId !== 'sql') {
      return;
    }
    const fsPath = doc.uri.fsPath;
    if (this.fileBindings.has(fsPath)) {
      return;
    }
    // 另存后原 untitled 文档关闭（onDidCloseTextDocument）；以内容指纹匹配
    const closed = this.lastClosedUntitled;
    if (!closed || closed.at < Date.now() - 10_000) {
      return;
    }
    if (closed.textHash !== doc.getText()) {
      return;
    }
    const consoleId = this.untitledBindings.get(closed.key);
    const state = consoleId ? this.consoles.get(consoleId) : undefined;
    this.lastClosedUntitled = undefined;
    if (!state) {
      return;
    }
    void this.saveFileBinding(fsPath, { consoleId: state.consoleId, connId: state.connId, db: state.db });
    this.untitledBindings.delete(closed.key);
    this.logger.info('console', `绑定随另存迁移：${state.consoleId} → ${fsPath}`);
    this.updateStatusBar();
  }

  private updateStatusBar(): void {
    const doc = vscode.window.activeTextEditor?.document;
    if (!doc || doc.languageId !== 'sql') {
      this.statusItem.hide();
      return;
    }
    this.statusItem.show();
    const state = this.bindingForDocument(doc);
    if (!state) {
      this.statusItem.text = '$(circle-slash) SQL 未绑定连接';
      this.statusItem.tooltip = '点击选择连接/数据库后即可执行';
      return;
    }
    const cfg = this.connections.getConfig(state.connId);
    const label = cfg?.name ?? state.connId;
    this.statusItem.text = `$(database) ${label}${state.db ? ` · ${state.db}` : ''} $(chevron-down)`;
    this.statusItem.tooltip = `${label}${state.db ? ` / ${state.db}` : ''}（点击切换连接/库）`;
  }

  // ── 执行（§7.2）──────────────────────────────────────────

  /** Ctrl+Enter：选区优先，否则光标所在语句/命令；Ctrl+Shift+Enter：全部 */
  async executeActiveEditor(scope: 'cursor' | 'all'): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== 'sql') {
      void vscode.window.showInformationMessage('当前编辑器不是 SQL 文档。');
      return;
    }
    await this.executeDocument(editor, scope);
  }

  /** 命令模式（驱动规范 §5.3）：supportsSQL=false 的驱动按行切分命令，危险/只读走 core 命令白名单 */
  private splitRanges(connId: string, raw: string): SqlStatement[] {
    const driver = this.connections.getDriver(connId);
    if (driver && !driver.capabilities.supportsSQL) {
      return splitCommandLines(raw); // 与 SqlStatement 形状兼容，statementAtOffset 通用
    }
    return splitSqlStatements(raw);
  }

  /** CodeLens「执行」（sqlCodeLens）：执行指定 SQL 文档中包含该位置的语句（与 Ctrl+Enter 同一执行链） */
  async executeStatementAt(uri: vscode.Uri, position: vscode.Position): Promise<void> {
    const doc = await vscode.workspace.openTextDocument(uri);
    if (doc.languageId !== 'sql') {
      return;
    }
    const state = await this.ensureBinding(doc);
    if (!state) {
      return; // 未选择连接
    }
    const stmt = statementAtOffset(this.splitRanges(state.connId, doc.getText()), doc.offsetAt(position));
    if (!stmt) {
      return; // 该位置已无语句（文档刚被编辑等）
    }
    const fullText = doc.getText();
    const origin: ExecutionOrigin = {
      uri,
      version: doc.version,
      ranges: [{ start: stmt.start, end: annotationEnd(fullText, stmt.end) }],
    };
    await this.runStatements(state, [stmt.text], undefined, origin);
  }

  private async executeDocument(
    editor: vscode.TextEditor,
    scope: 'cursor' | 'all',
  ): Promise<void> {
    const doc = editor.document;
    const state = await this.ensureBinding(doc);
    if (!state) {
      return; // 未选择连接
    }
    const fullText = doc.getText();
    const ranges = this.splitRanges(state.connId, fullText);
    let texts: string[] = [];
    let originRanges: Array<{ start: number; end: number }> = [];
    if (scope === 'all') {
      texts = ranges.map((s) => s.text);
      originRanges = ranges.map((s) => ({ start: s.start, end: annotationEnd(fullText, s.end) }));
    } else if (!editor.selection.isEmpty) {
      // 选区执行：选区内再切分，偏移平移回全文坐标
      const base = doc.offsetAt(editor.selection.start);
      const selText = doc.getText(editor.selection);
      const sel = this.splitRanges(state.connId, selText);
      texts = sel.map((s) => s.text);
      originRanges = sel.map((s) => ({ start: s.start + base, end: annotationEnd(selText, s.end) + base }));
    } else {
      const stmt = statementAtOffset(ranges, doc.offsetAt(editor.selection.active));
      if (stmt) {
        texts = [stmt.text];
        originRanges = [{ start: stmt.start, end: annotationEnd(fullText, stmt.end) }];
      }
    }
    const origin: ExecutionOrigin | undefined =
      texts.length > 0 ? { uri: doc.uri, version: doc.version, ranges: originRanges } : undefined;
    await this.runStatements(state, texts, undefined, origin);
  }

  /** 结果面板「重跑」按钮：对指定 Console 重跑一段 SQL/命令（完整危险判定流程） */
  async executeSql(consoleId: string, sql: string): Promise<void> {
    const state = this.consoles.get(consoleId);
    if (!state) {
      throw new DriverError('E_NOT_FOUND', 'Console 不存在（可能已关闭）');
    }
    await this.runStatements(state, this.splitRanges(state.connId, sql).map((s) => s.text));
  }

  /** 历史重跑：活动 Console（一次性连接覆盖）或新建 Console 执行 */
  async rerunHistory(item: import('./consoleHistory').ConsoleHistoryItem): Promise<void> {
    const doc = vscode.window.activeTextEditor?.document;
    const state = doc && doc.languageId === 'sql' ? this.bindingForDocument(doc) : undefined;
    if (state) {
      await this.runStatements(state, this.splitRanges(state.connId, item.sql).map((s) => s.text), {
        connId: item.connId,
        db: item.db,
      });
      return;
    }
    await this.newConsole({ connId: item.connId, db: item.db ?? undefined }, item.sql, { autoExecute: true });
  }

  private async runStatements(
    state: ConsoleState,
    texts: string[],
    override?: { connId: string; db: string | null },
    origin?: ExecutionOrigin,
  ): Promise<void> {
    if (texts.length === 0) {
      void vscode.window.showInformationMessage('没有可执行的语句。');
      return;
    }
    if (state.controller) {
      void vscode.window.showInformationMessage('已有执行在进行中，可先取消。');
      return;
    }
    // 新执行开始：撤销上一轮悬挂横幅
    if (state.pendingBanner) {
      state.pendingBanner.resolve('cancel');
      state.banner = null;
      pushToConsolePanel(state.consoleId, {
        event: RpcEvents.consoleBanner,
        payload: { consoleId: state.consoleId, banner: null },
      });
    }

    const connId = override?.connId ?? state.connId;
    let db = (override ? override.db : state.db) ?? undefined;
    const cfg = this.connections.getConfig(connId);
    if (!cfg) {
      void vscode.window.showErrorMessage(`连接 "${connId}" 不存在，请重新绑定。`);
      return;
    }
    const driver = this.connections.getDriver(connId);
    if (!driver) {
      void vscode.window.showErrorMessage('驱动未注册。');
      return;
    }
    // 命令模式（驱动规范 §5.3 / 评审 P1-6）：supportsSQL=false 仍提供命令控制台，
    // 危险判定/只读 fail-closed 改用 core 命令白名单，其余流程（横幅/Modal/执行/历史）复用
    const commandMode = !driver.capabilities.supportsSQL;

    let conn;
    try {
      conn = await this.connections.ensureConnected(connId);
    } catch (err) {
      void vscode.window.showErrorMessage(
        `连接失败：${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
    const dialectId = conn.dialect?.id;

    // 库绑定保障（§7.1 延伸）：SQL 模式未绑定库时执行 → 提示选择（单库自动绑定），否则
    // 语句落在无库上下文（MySQL 报 No database selected）。取消选择 = 取消执行。
    // 返回 null 表示数据源无库概念（listDatabases 空），放行由驱动自决。
    if (!commandMode && db === undefined) {
      const picked = await this.pickDatabaseForConsole(conn);
      if (picked === undefined) {
        void vscode.window.showInformationMessage('未选择数据库，已取消执行（可点击状态栏绑定库）。');
        return;
      }
      if (picked !== null) {
        state.db = picked;
        db = picked;
        this.bindingsChangedEmitter.fire();
        this.updateStatusBar();
        this.logger.info('console', `${state.consoleId} 绑定库 → ${picked}（执行时选择）`);
      }
    }

    // 只读连接 fail-closed（概要 §5.8）：SQL 无法证明是读 → 拒绝；命令模式下用命令白名单
    if (cfg.readOnly) {
      try {
        if (commandMode) {
          this.editGuard.assertCommandsReadable(texts);
        } else {
          this.editGuard.assertReadable(texts, dialectId);
        }
      } catch (err) {
        void vscode.window.showErrorMessage(err instanceof Error ? err.message : String(err));
        return;
      }
    }

    // 危险判定（概要 §5.8 / 交互稿 §7.4）：任一语句/命令危险 → 横幅（dev/test）或 Modal（prod）
    const assessments = texts.map((t) =>
      commandMode
        ? this.editGuard.assessCommandDanger(t)
        : this.editGuard.assessDanger(t, dialectId),
    );
    const dangerReasons = [...new Set(assessments.flatMap((a) => a.reasons))];
    let dangerOverridden = false;
    if (dangerReasons.length > 0) {
      const offending = texts.filter((_, i) => assessments[i].dangerous).join('\n');
      const env = cfg.env ?? null;
      if (env === 'prod') {
        const pick = await vscode.window.showWarningMessage(
          `生产环境危险${commandMode ? '命令' : '语句'}：${dangerReasons.join('；')}`,
          { modal: true, detail: offending },
          '仍要执行',
        );
        if (pick !== '仍要执行') {
          this.logger.warn('dangerGuard', 'prod 危险语句已拦截（不落历史）');
          return; // 拦截不落历史（§7.4）
        }
        dangerOverridden = true;
      } else {
        const proceed = await this.showBannerAndWait(state, dangerReasons, offending);
        if (!proceed) {
          this.logger.warn('dangerGuard', '危险语句横幅被取消（不落历史）');
          return; // 拦截不落历史
        }
        dangerOverridden = true;
      }
      this.logger.info('dangerGuard', `用户确认覆盖危险语句（${dangerReasons.join('；')}）`);
    }

    // 会话状态检查（评审 P1-5）：仅 SQL 路径——命令模式逐行本就是独立命令（SELECT 等
    // 连接级状态在同一连接内按序执行，无逐条池化丢状态问题）
    if (!commandMode && texts.length > 1 && !driver.capabilities.supportsMultiStatement) {
      const hasSession = texts.some((t) => isSessionStateStatement(t));
      if (hasSession) {
        void vscode.window.showErrorMessage(
          '语句中包含会话状态语句（SET @x / USE / 临时表），当前驱动不支持多语句执行，会话状态无法保留。请逐条执行。',
        );
        return;
      }
    }

    const maxRows = Math.min(
      vscode.workspace.getConfiguration('dbExplorer').get('query.maxRows', 1000),
      MAX_RESULT_ROWS,
    );
    const timeoutMs = vscode.workspace.getConfiguration('dbExplorer').get('query.timeoutMs', 15_000);

    const runId = `run-${Date.now()}-${++this.seq}`;
    const controller = new AbortController();
    state.controller = controller;
    state.runningTotal = texts.length;
    // 新一轮执行：清掉上一轮的行内注记（最新结果为准）
    if (origin) {
      this.annotations?.clear(origin.uri);
    }
    // 逐语句行内注记上报（sqlExecutionDecorations）：ok=耗时绿勾，失败=错误红叉，取消=灰
    const reportOutcome = (i: number, ok: boolean, durationMs: number, err?: unknown): void => {
      if (!origin || !this.annotations) {
        return;
      }
      const r = origin.ranges[i];
      if (!r) {
        return;
      }
      this.annotations.report(origin.uri, origin.version, {
        start: r.start,
        end: r.end,
        ok,
        durationMs,
        code: err ? (DriverError.is(err) ? err.code : 'E_INTERNAL') : undefined,
        message: err
          ? DriverError.is(err) && err.code === 'E_CANCELED'
            ? '已取消'
            : err instanceof Error
              ? err.message
              : String(err)
          : undefined,
      });
    };
    const run: ConsoleRun = {
      consoleId: state.consoleId,
      runId,
      startedAt: Date.now(),
      durationMs: 0,
      status: 'running',
      dangerOverridden: dangerOverridden || undefined,
      items: [],
    };
    state.run = run;

    try {
      // 底部结果视图跟随本次执行：激活显示（用户可立即看到逐语句结果与进度）
      this.setActiveConsole(state.consoleId);
      revealConsoleResultView();
      pushToConsolePanel(state.consoleId, {
        event: RpcEvents.consoleRunning,
        payload: { consoleId: state.consoleId, runId, total: texts.length },
      });
      this.pushRun(state);

      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: commandMode ? '执行命令…' : '执行 SQL…', cancellable: true },
        async (_progress, token) => {
          token.onCancellationRequested(() => controller.abort());
          for (let i = 0; i < texts.length; i++) {
            const sqlText = texts[i]!;
            const stmtStart = Date.now();
            if (controller.signal.aborted) {
              throw new DriverError('E_CANCELED', '已取消');
            }
            try {
              // 交互式事务（§4.6/D-09）：事务动词由 SessionManager 接管；会话内语句走连接级事务上下文
              // USE 语句改绑定不下发（P-36：池化连接上 USE 只改写单个物理连接，不可靠）
              const txnVerb =
                !commandMode && driver.capabilities.supportsInteractiveTransaction
                  ? matchTxnVerb(sqlText)
                  : undefined;
              const useTarget =
                !commandMode && driver.capabilities.supportsSQL ? parseUseStatement(sqlText) : undefined;
              let resultSets: import('@db-explorer/core').ResultSet[];
              if (useTarget !== undefined) {
                if (useTarget === null) {
                  throw new DriverError('E_VALIDATION', '无法解析 USE 语句的目标库名');
                }
                state.db = useTarget;
                db = useTarget;
                this.bindingsChangedEmitter.fire();
                this.updateStatusBar();
                resultSets = [txnMessageRs(`已切换到数据库 ${useTarget}（Console 绑定已更新）`)];
              } else if (txnVerb === 'begin') {
                await this.sessions.begin(connId);
                resultSets = [txnMessageRs('事务已开启（COMMIT 提交 / ROLLBACK 回滚；空闲超时自动回滚）')];
              } else if (txnVerb === 'commit') {
                await this.sessions.commit(connId);
                resultSets = [txnMessageRs('事务已提交')];
              } else if (txnVerb === 'rollback') {
                await this.sessions.rollback(connId);
                resultSets = [txnMessageRs('事务已回滚')];
              } else if (!commandMode && this.sessions.hasActive(connId)) {
                resultSets = await this.sessions.execute(connId, { sql: sqlText, db, maxRows, timeoutMs });
              } else {
                resultSets = await this.host.query(
                  conn,
                  { sql: sqlText, db, maxRows, timeoutMs },
                  { signal: controller.signal },
                );
              }
              for (const rs of resultSets) {
                const item = this.itemFromResultSet(sqlText, rs);
                item.seq = run.items.length + 1;
                run.items.push(item);
              }
              if (commandMode && db && !isProvablyReadRedisCommand(sqlText)) {
                // 写命令失效联动（概要 §7.5 的命令版）：失效该库元数据缓存并联动树刷新
                this.cache.invalidateDb(connId, db);
                this.refreshTree();
              } else if (!commandMode && isDdlStatement(sqlText) && db) {
                // DDL 失效联动（概要 §7.5）：失效该库元数据 + 联动树刷新
                this.cache.invalidateDb(connId, db);
                this.refreshTree();
              }
              reportOutcome(i, true, resultSets.reduce((n, rs) => n + (rs.executionMs ?? 0), 0));
            } catch (err) {
              const canceled = DriverError.is(err) && err.code === 'E_CANCELED';
              reportOutcome(i, false, Date.now() - stmtStart, err);
              run.items.push({
                seq: run.items.length + 1,
                sql: sqlText,
                executionMs: 0,
                error: {
                  code: DriverError.is(err) ? err.code : 'E_INTERNAL',
                  message: err instanceof Error ? err.message : String(err),
                },
              });
              run.status = canceled ? 'canceled' : 'error';
              throw err;
            }
            this.pushRun(state);
          }
          run.status = 'ok';
        },
      );
    } catch (err) {
      if (run.status === 'running') {
        run.status = DriverError.is(err) && err.code === 'E_CANCELED' ? 'canceled' : 'error';
      }
      if (DriverError.is(err) && err.code === 'E_CANCELED') {
        void vscode.window.showInformationMessage('已取消'); // E_CANCELED 静默提示（§7.2）
      } else {
        void vscode.window.showErrorMessage(
          `执行失败：${err instanceof Error ? err.message : String(err)}`,
        );
      }
    } finally {
      run.durationMs = Date.now() - run.startedAt;
      state.controller = undefined;
      this.logRunOutcome(state, run, texts.length);
      this.pushRun(state);
      this.recordHistory(state, run);
    }
  }

  /** 执行终态打点（M8 优化）：完成/取消 info、失败 error（DriverError code 可见，C-6 链路补充） */
  private logRunOutcome(state: ConsoleState, run: ConsoleRun, total: number): void {
    const done = run.items.length;
    if (run.status === 'error') {
      let lastError: ConsoleRunItem['error'] | undefined;
      for (const item of run.items) {
        if (item.error) {
          lastError = item.error;
        }
      }
      this.logger.error(
        'console',
        `${state.consoleId} 执行失败：${lastError ? `${lastError.code} ${lastError.message}` : '未知错误'}（${done}/${total} 条语句，${run.durationMs}ms）`,
      );
      return;
    }
    if (run.status === 'canceled') {
      this.logger.info(
        'console',
        `${state.consoleId} 执行已取消（${done}/${total} 条语句，${run.durationMs}ms）`,
      );
      return;
    }
    const rows = run.items.reduce((n, i) => n + (i.resultSet?.rowCount ?? i.affectedRows ?? 0), 0);
    this.logger.info(
      'console',
      `${state.consoleId} 执行完成：${total} 条语句 / ${rows} 行（${run.durationMs}ms）`,
    );
  }

  private itemFromResultSet(sqlText: string, rs: import('@db-explorer/core').ResultSet): ConsoleRunItem {
    const item: ConsoleRunItem = { seq: 0, sql: sqlText, executionMs: rs.executionMs };
    if (rs.affectedRows !== undefined) {
      item.affectedRows = rs.affectedRows;
      if (rs.messages?.length) {
        item.messages = rs.messages;
      }
    } else {
      item.resultSet = {
        columns: rs.columns,
        rows: rs.rows,
        rowCount: rs.rowCount,
        totalCount: rs.totalCount,
        executionMs: rs.executionMs,
        truncated: rs.truncated,
      };
    }
    return item;
  }

  private async recordHistory(state: ConsoleState, run: ConsoleRun): Promise<void> {
    if (run.items.length === 0) {
      return;
    }
    const last = run.items[run.items.length - 1];
    let summary = '';
    if (last.error) {
      summary = `${last.error.code}: ${last.error.message.slice(0, 60)}`;
    } else if (last.resultSet) {
      summary = `${last.resultSet.rowCount} 行`;
    } else if (last.affectedRows !== undefined) {
      summary = `${last.affectedRows} 行受影响`;
    }
    const sqlText = run.items.map((i) => i.sql).join('\n');
    await this.history.record({
      connId: state.connId,
      db: state.db,
      sql: sqlText,
      ok: run.status === 'ok',
      status: run.status === 'ok' ? 'ok' : run.status === 'canceled' ? 'canceled' : 'error',
      durationMs: run.durationMs,
      summary,
      dangerOverridden: run.dangerOverridden,
    });
  }

  // ── 危险横幅（交互稿 §7.4）───────────────────────────────

  private async showBannerAndWait(
    state: ConsoleState,
    reasons: string[],
    sql: string,
  ): Promise<boolean> {
    const bannerId = `banner-${Date.now()}`;
    state.banner = { bannerId, reasons, sql };
    // 横幅显示在底部结果视图顶部：切换跟随并激活
    this.setActiveConsole(state.consoleId);
    revealConsoleResultView();
    pushToConsolePanel(state.consoleId, {
      event: RpcEvents.consoleBanner,
      payload: { consoleId: state.consoleId, banner: state.banner },
    });
    const action = await new Promise<'proceed' | 'cancel'>((resolve) => {
      state.pendingBanner = { bannerId, resolve };
    });
    state.pendingBanner = undefined;
    state.banner = null;
    pushToConsolePanel(state.consoleId, {
      event: RpcEvents.consoleBanner,
      payload: { consoleId: state.consoleId, banner: null },
    });
    return action === 'proceed';
  }

  async resolveBanner(consoleId: string, bannerId: string, action: 'proceed' | 'cancel'): Promise<void> {
    const state = this.consoles.get(consoleId);
    if (!state?.pendingBanner || state.pendingBanner.bannerId !== bannerId) {
      return; // 过期横幅（已被新执行取代）
    }
    state.pendingBanner.resolve(action);
  }

  cancel(consoleId: string): void {
    this.consoles.get(consoleId)?.controller?.abort();
  }

  // ── 结果面板 RPC（console.*）─────────────────────────────

  /** 底部视图跟随切换：推送 evt:console.activated，单例视图据此重新拉取全量状态 */
  private setActiveConsole(consoleId: string): void {
    this.lastActiveConsoleId = consoleId;
    pushToConsolePanel(consoleId, {
      event: RpcEvents.consoleActivated,
      payload: { consoleId },
    });
  }

  async getState(consoleId: string): Promise<ConsoleStateResult> {
    // 空串 = 底部单例视图引导：解析为最近执行的 Console
    const id = consoleId || this.lastActiveConsoleId;
    const state = id ? this.consoles.get(id) : undefined;
    if (!state) {
      return { consoleId: id ?? '', bound: false };
    }
    const cfg = this.connections.getConfig(state.connId);
    return {
      consoleId: state.consoleId,
      bound: true,
      connLabel: cfg?.name ?? state.connId,
      db: state.db,
      running:
        state.controller && state.run
          ? { runId: state.run.runId, total: state.runningTotal ?? 0 }
          : undefined,
      banner: state.banner,
      run: state.run,
    };
  }

  async exportResult(
    consoleId: string,
    itemSeq: number,
    format: 'csv' | 'json' | 'xlsx',
  ): Promise<{ filePath: string; rows: number; bytes: number; canceled?: boolean }> {
    const state = this.consoles.get(consoleId);
    const rs = state?.run?.items.find((i) => i.seq === itemSeq)?.resultSet;
    if (!rs) {
      throw new DriverError('E_VALIDATION', '该结果不可导出');
    }
    const wsFolder = vscode.workspace.workspaceFolders?.[0];
    const defaultDir = wsFolder ? vscode.Uri.file(`${wsFolder.uri.fsPath}/.db-export`) : undefined;
    const defaultUri = defaultDir
      ? vscode.Uri.joinPath(defaultDir, `结果-${itemSeq}.${format}`)
      : undefined;
    const target = await vscode.window.showSaveDialog({
      defaultUri,
      saveLabel: '导出',
      filters:
        format === 'csv' ? { CSV: ['csv'] } : format === 'xlsx' ? { Excel: ['xlsx'] } : { JSON: ['json'] },
    });
    if (!target) {
      return { filePath: '', rows: 0, bytes: 0, canceled: true };
    }
    const names = rs.columns.map((c) => c.name);
    let content: string;
    let bytes: number;
    if (format === 'xlsx') {
      // D-14：exceljs 写出（结果集已在内存，非流式路径足够）
      const out = await writeXlsxFile(
        target.fsPath,
        names.map((name) => ({ name })),
        [rs.rows],
      );
      bytes = out.bytes;
    } else if (format === 'csv') {
      content = rs.rows.map((row) => csvRow(row)).join('');
      content = csvRow(names) + content;
      bytes = Buffer.byteLength(content);
      await vscode.workspace.fs.writeFile(target, Buffer.from(content, 'utf8'));
    } else {
      content = JSON.stringify(rs.rows.map((row) => toJsonObject(names, row)), null, 2);
      bytes = Buffer.byteLength(content);
      await vscode.workspace.fs.writeFile(target, Buffer.from(content, 'utf8'));
    }
    this.logger.info('console', `结果 ${itemSeq} 已导出：${target.fsPath}（${rs.rowCount} 行）`);
    return { filePath: target.fsPath, rows: rs.rowCount, bytes };
  }

  /** 连接删除/编辑后清理其 Console 状态与绑定（防悬空引用） */
  closeConsolesForConnection(connId: string): void {
    let activeRemoved = false;
    for (const [id, state] of [...this.consoles]) {
      if (state.connId === connId) {
        state.controller?.abort();
        this.consoles.delete(id);
        if (this.lastActiveConsoleId === id) {
          activeRemoved = true;
        }
      }
    }
    if (activeRemoved) {
      this.lastActiveConsoleId = '';
      pushToConsolePanel('', {
        event: RpcEvents.consoleActivated,
        payload: { consoleId: '' },
      });
    }
    this.bindingsChangedEmitter.fire();
    this.updateStatusBar();
  }

  // ── 补全（概要 §5.5.3，DoD <100ms 缓存命中）───────────────

  private preheatCompletions(state: ConsoleState): void {
    void this.loadCompletionSource(state).catch((err) => {
      this.logger.error('console', `补全预热失败：${describeError(err)}`);
    });
  }

  private async loadCompletionSource(state: ConsoleState): Promise<CompletionSource> {
    const conn = await this.connections.ensureConnected(state.connId);
    const cacheKey = state.db ?? '';
    const start = performance.now();
    const source = await this.cache.getCompletionSource(state.connId, cacheKey, () =>
      conn.getCompletionSource(state.db ?? undefined),
    );
    const elapsed = performance.now() - start;
    // DoD 口径：缓存命中 <100ms；首载（>100ms）仅记录不告警。高频路径 → debug 级
    this.logger.debug(
      'console',
      `补全数据源 ${state.connId}/${cacheKey}：${elapsed.toFixed(1)}ms（${elapsed < 100 ? '缓存命中' : '首次加载'}）`,
    );
    return source;
  }

  /** 补全 provider 数据入口（consoleCompletion.ts 调用） */
  async completionFor(consoleId: string): Promise<CompletionSource | undefined> {
    const state = this.consoles.get(consoleId);
    if (!state) {
      return undefined;
    }
    try {
      return await this.loadCompletionSource(state);
    } catch {
      return undefined; // 补全失败静默降级为关键字
    }
  }

  // ── 事件推送 ─────────────────────────────────────────────

  private pushRun(state: ConsoleState): void {
    if (!state.run) {
      return;
    }
    const items = state.run.items.map((item, i) => ({ ...item, seq: item.seq || i + 1 }));
    pushToConsolePanel(state.consoleId, {
      event: RpcEvents.consoleUpdated,
      payload: { consoleId: state.consoleId, run: { ...state.run, items } },
    });
  }
}
