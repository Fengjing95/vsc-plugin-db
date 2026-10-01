import * as vscode from 'vscode';
import {
  DriverError,
  InProcessDriverHost,
  isDdlStatement,
  isSessionStateStatement,
  splitSqlStatements,
  statementAtOffset,
  type CompletionSource,
  type MetadataCache,
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
import { ensureConsolePanel, disposeConsolePanelsFor, pushToConsolePanel } from '../views/consolePanel';
import type { ConsoleHistory } from './consoleHistory';
import type { EditGuard } from './editGuard';

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
  private readonly host: InProcessDriverHost;
  private readonly disposables: vscode.Disposable[] = [];
  /** untitled 关闭后的绑定回收定时器（另存迁移窗口，§7.1） */
  private readonly pendingTimers = new Set<ReturnType<typeof setTimeout>>();
  private lastClosedUntitled?: { key: string; textHash: string; at: number };

  /** 结果面板依赖（consolePanel 用） */
  private get panelDeps(): import('../views/consolePanel').ConsolePanelDeps {
    return { connections: this.connections, output: this.output, console: this };
  }

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly connections: ConnectionManager,
    private readonly cache: MetadataCache,
    private readonly editGuard: EditGuard,
    private readonly history: ConsoleHistory,
    private readonly output: vscode.OutputChannel,
    /** DDL 执行后联动树刷新（概要 §7.5） */
    private readonly refreshTree: () => void,
  ) {
    this.fileBindings = new Map(
      Object.entries(context.workspaceState.get<Record<string, FileBinding>>(FILE_BINDINGS_KEY) ?? {}),
    );
    this.host = new InProcessDriverHost(
      vscode.workspace.getConfiguration('dbExplorer').get('query.timeoutMs', 15_000),
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
    disposeConsolePanelsFor();
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
    const state = this.bindingForDocument(doc) ?? (await this.ensureBinding(doc));
    if (!state) {
      return;
    }
    state.connId = picked.connId;
    state.db = picked.db;
    this.output.appendLine(`[console] ${state.consoleId} 重新绑定 → ${picked.connId}${picked.db ? `/${picked.db}` : ''}`);
    this.preheatCompletions(state);
    this.bindingsChangedEmitter.fire();
    this.updateStatusBar();
  }

  private async pickConnection(): Promise<{ connId: string; db: string | null } | undefined> {
    const configs = await this.connections.listConfigs();
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
    this.output.appendLine(`[console] 绑定随另存迁移：${state.consoleId} → ${fsPath}`);
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

  /** Ctrl+Enter：选区优先，否则光标所在语句；Ctrl+Shift+Enter：全部 */
  async executeActiveEditor(scope: 'cursor' | 'all'): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== 'sql') {
      void vscode.window.showInformationMessage('当前编辑器不是 SQL 文档。');
      return;
    }
    await this.executeDocument(editor, scope);
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
    let texts: string[];
    if (scope === 'all') {
      texts = splitSqlStatements(doc.getText()).map((s) => s.text);
    } else if (!editor.selection.isEmpty) {
      texts = splitSqlStatements(doc.getText(editor.selection)).map((s) => s.text);
    } else {
      const stmt = statementAtOffset(splitSqlStatements(doc.getText()), doc.offsetAt(editor.selection.active));
      texts = stmt ? [stmt.text] : [];
    }
    await this.runStatements(state, texts);
  }

  /** 结果面板「重跑」按钮：对指定 Console 重跑一段 SQL（完整危险判定流程） */
  async executeSql(consoleId: string, sql: string): Promise<void> {
    const state = this.consoles.get(consoleId);
    if (!state) {
      throw new DriverError('E_NOT_FOUND', 'Console 不存在（可能已关闭）');
    }
    await this.runStatements(state, splitSqlStatements(sql).map((s) => s.text));
  }

  /** 历史重跑：活动 Console（一次性连接覆盖）或新建 Console 执行 */
  async rerunHistory(item: import('./consoleHistory').ConsoleHistoryItem): Promise<void> {
    const doc = vscode.window.activeTextEditor?.document;
    const state = doc && doc.languageId === 'sql' ? this.bindingForDocument(doc) : undefined;
    if (state) {
      await this.runStatements(state, [item.sql], { connId: item.connId, db: item.db });
      return;
    }
    await this.newConsole({ connId: item.connId, db: item.db ?? undefined }, item.sql, { autoExecute: true });
  }

  private async runStatements(
    state: ConsoleState,
    texts: string[],
    override?: { connId: string; db: string | null },
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
    const db = (override ? override.db : state.db) ?? undefined;
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
    if (!driver.capabilities.supportsSQL) {
      // M6 Redis：命令白名单控制台预留接口（驱动规范 §5.3）
      void vscode.window.showInformationMessage('当前驱动不支持 SQL 执行（命令控制台将于后续版本提供）。');
      return;
    }

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

    // 只读连接 fail-closed（概要 §5.8）：无法证明是读 → 拒绝
    if (cfg.readOnly) {
      try {
        this.editGuard.assertReadable(texts, dialectId);
      } catch (err) {
        void vscode.window.showErrorMessage(err instanceof Error ? err.message : String(err));
        return;
      }
    }

    // 危险判定（概要 §5.8 / 交互稿 §7.4）：任一语句危险 → 横幅（dev/test）或 Modal（prod）
    const assessments = texts.map((t) => this.editGuard.assessDanger(t, dialectId));
    const dangerReasons = [...new Set(assessments.flatMap((a) => a.reasons))];
    let dangerOverridden = false;
    if (dangerReasons.length > 0) {
      const offending = texts.filter((_, i) => assessments[i].dangerous).join('\n');
      const env = cfg.env ?? null;
      if (env === 'prod') {
        const pick = await vscode.window.showWarningMessage(
          `生产环境危险语句：${dangerReasons.join('；')}`,
          { modal: true, detail: offending },
          '仍要执行',
        );
        if (pick !== '仍要执行') {
          this.output.appendLine('[dangerGuard] prod 危险语句已拦截（不落历史）');
          return; // 拦截不落历史（§7.4）
        }
        dangerOverridden = true;
      } else {
        const proceed = await this.showBannerAndWait(state, dangerReasons, offending);
        if (!proceed) {
          this.output.appendLine('[dangerGuard] 危险语句横幅被取消（不落历史）');
          return; // 拦截不落历史
        }
        dangerOverridden = true;
      }
      this.output.appendLine(`[dangerGuard] 用户确认覆盖危险语句（${dangerReasons.join('；')}）`);
    }

    // 会话状态检查（评审 P1-5）：切分逐条执行会丢失 SET @x/USE 的会话上下文
    if (texts.length > 1 && !driver.capabilities.supportsMultiStatement) {
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
      // 结果面板未打开时自动在编辑组右侧打开；已打开则复用（交互稿 §7.2 / D-02）
      ensureConsolePanel(this.context, this.panelDeps, state);
      pushToConsolePanel(state.consoleId, {
        event: RpcEvents.consoleRunning,
        payload: { consoleId: state.consoleId, runId, total: texts.length },
      });
      this.pushRun(state);

      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: '执行 SQL…', cancellable: true },
        async (_progress, token) => {
          token.onCancellationRequested(() => controller.abort());
          for (const sqlText of texts) {
            if (controller.signal.aborted) {
              throw new DriverError('E_CANCELED', '已取消');
            }
            try {
              const resultSets = await this.host.query(
                conn,
                { sql: sqlText, db, maxRows, timeoutMs },
                { signal: controller.signal },
              );
              for (const rs of resultSets) {
                const item = this.itemFromResultSet(sqlText, rs);
                item.seq = run.items.length + 1;
                run.items.push(item);
              }
              if (isDdlStatement(sqlText) && db) {
                // DDL 失效联动（概要 §7.5）：失效该库元数据 + 联动树刷新
                this.cache.invalidateDb(connId, db);
                this.refreshTree();
              }
            } catch (err) {
              const canceled = DriverError.is(err) && err.code === 'E_CANCELED';
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
      this.pushRun(state);
      this.recordHistory(state, run);
    }
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
    ensureConsolePanel(this.context, this.panelDeps, state);
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

  async getState(consoleId: string): Promise<ConsoleStateResult> {
    const state = this.consoles.get(consoleId);
    if (!state) {
      return { bound: false };
    }
    const cfg = this.connections.getConfig(state.connId);
    return {
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
    format: 'csv' | 'json',
  ): Promise<{ filePath: string; rows: number; bytes: number; canceled?: boolean }> {
    const state = this.consoles.get(consoleId);
    const rs = state?.run?.items.find((i) => i.seq === itemSeq)?.resultSet;
    if (!rs) {
      throw new DriverError('E_VALIDATION', '该结果不可导出');
    }
    const wsFolder = vscode.workspace.workspaceFolders?.[0];
    const defaultDir = wsFolder ? vscode.Uri.file(`${wsFolder.uri.fsPath}/.db-export`) : undefined;
    const target = await vscode.window.showSaveDialog({
      defaultUri: defaultDir ? vscode.Uri.joinPath(defaultDir, `结果-${itemSeq}.${format}`) : undefined,
      saveLabel: '导出',
      filters: format === 'csv' ? { CSV: ['csv'] } : { JSON: ['json'] },
    });
    if (!target) {
      return { filePath: '', rows: 0, bytes: 0, canceled: true };
    }
    const names = rs.columns.map((c) => c.name);
    let content: string;
    if (format === 'csv') {
      content = rs.rows.map((row) => csvRow(row)).join('');
      content = csvRow(names) + content;
    } else {
      content = JSON.stringify(rs.rows.map((row) => toJsonObject(names, row)), null, 2);
    }
    await vscode.workspace.fs.writeFile(target, Buffer.from(content, 'utf8'));
    this.output.appendLine(`[console] 结果 ${itemSeq} 已导出：${target.fsPath}（${rs.rowCount} 行）`);
    return { filePath: target.fsPath, rows: rs.rowCount, bytes: Buffer.byteLength(content) };
  }

  closePanel(consoleId: string): void {
    disposeConsolePanelsFor(consoleId);
  }

  /** 连接删除/编辑后清理其 Console 面板与绑定（防悬空引用） */
  closeConsolesForConnection(connId: string): void {
    for (const [id, state] of [...this.consoles]) {
      if (state.connId === connId) {
        state.controller?.abort();
        disposeConsolePanelsFor(id);
        this.consoles.delete(id);
      }
    }
    this.bindingsChangedEmitter.fire();
    this.updateStatusBar();
  }

  // ── 补全（概要 §5.5.3，DoD <100ms 缓存命中）───────────────

  private preheatCompletions(state: ConsoleState): void {
    void this.loadCompletionSource(state).catch((err) => {
      this.output.appendLine(`[console] 补全预热失败：${String(err)}`);
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
    // DoD 口径：缓存命中 <100ms；首载（>100ms）仅记录不告警
    this.output.appendLine(
      `[console] 补全数据源 ${state.connId}/${cacheKey}：${elapsed.toFixed(1)}ms（${elapsed < 100 ? '缓存命中' : '首次加载'}）`,
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
