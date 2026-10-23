import * as vscode from 'vscode';
import {
  AI_CONTEXT_TABLE_LIMIT,
  DriverError,
  buildExplainPrompt,
  buildFixPrompt,
  buildGeneratePrompt,
  extractSqlFromResponse,
  splitSqlStatements,
  statementAtOffset,
  type AiPromptContext,
} from '@db-explorer/core';
import type { AiFixErrorResult, ConsoleAi } from '@db-explorer/protocol';
import { describeError, type Logger } from './logger';
import type { ConnectionManager } from './connectionManager';
import type { ConsoleService } from './consoleService';
import type { AiSettingsStore } from './aiSettings';

/**
 * AI 辅助三能力（M9-AI / ADR D-24 / 交互稿 §15）：
 * - 生成（NL→SQL）：QuickPick 输入 → 结果直插编辑器并选中新文本（无预览确认步，护栏在执行侧）
 * - 解释：光标语句/选区 → Console 结果面板「AI 解释」Tab 流式 Markdown（evt:console.ai）
 * - 错误修复：Console 错误 item → 文档语句定位 → AI → diff 确认（applyFix 校验原文仍匹配）
 * 护栏不变式（D-24）：AI 产物一律草稿/diff，绝不直接执行——本服务只产生文档编辑，
 * 执行链（DangerGuard / prod 确认 / 只读拦截）零改动。
 */

interface ConsoleBindingInfo {
  connId: string;
  db: string | null;
  consoleId?: string;
}

interface LoadedContext {
  context: AiPromptContext;
  selectedTables?: string[];
  label: string;
}

interface FixEntry {
  uriString: string;
  /** 定位快照：偏移 + 原文——applyFix 时按「偏移处文本仍与原文一致」校验（版本号对逐步编辑太脆） */
  start: number;
  end: number;
  originalSql: string;
  suggestedSql: string;
}

const MAX_STREAM_PUSH_INTERVAL_MS = 120;
const MAX_FIX_ENTRIES = 20;

export class AiAssistService {
  /** 圈选记忆（会话级）：key = connId/db（交互稿 §15.2「记住上次选择」仅内存） */
  private readonly tablePickMemory = new Map<string, string[]>();
  /** 每文档进行中的解释（新一轮取消上一轮，交互稿 §15.3） */
  private readonly explainControllers = new Map<string, AbortController>();
  /** 最近一次解释的入参（Tab 错误态「重试」按钮复跑，交互稿 §15.5） */
  private readonly lastExplains = new Map<string, { info: ConsoleBindingInfo; sql: string }>();
  private readonly fixes = new Map<string, FixEntry>();
  private aiSeq = 0;
  private fixSeq = 0;
  /** 锚点行内 loading 装饰（行尾 `$(sync~spin) AI 正在生成…`，随进度清除）——复用单例 DecorationType 防泄漏 */
  private aiStatusDecoration?: vscode.TextEditorDecorationType;

  constructor(
    private readonly connections: ConnectionManager,
    private readonly console: ConsoleService,
    private readonly settings: AiSettingsStore,
    private readonly logger: Logger,
    /** 打开 AI 设置页（extension.ts 注入视图打开器，避免 services→views 环依赖） */
    private readonly openSettingsPanel: () => void,
  ) {}

  // ── 配置守卫（交互稿 §15.1：未配置不占 UI，入口点击引导） ──────────────

  /** 设置页入口（命令 / webview [去配置] 引导共用） */
  openSettings(): void {
    this.openSettingsPanel();
  }

  /** 锚点行尾内联状态（生成 loading；装饰渲染不入文件，交互稿 §15.2/实机反馈） */
  private showEditorStatus(editor: vscode.TextEditor, position: vscode.Position, text: string): void {
    if (!this.aiStatusDecoration) {
      this.aiStatusDecoration = vscode.window.createTextEditorDecorationType({});
    }
    const lineEnd = editor.document.lineAt(position.line).range.end;
    editor.setDecorations(this.aiStatusDecoration, [
      {
        range: new vscode.Range(lineEnd, lineEnd),
        renderOptions: {
          after: {
            contentText: `  $(sync~spin) ${text}`,
            color: new vscode.ThemeColor('editorGhostText.foreground'),
            fontStyle: 'italic',
          },
        },
      },
    ]);
  }

  private clearEditorStatus(editor: vscode.TextEditor): void {
    if (this.aiStatusDecoration) {
      editor.setDecorations(this.aiStatusDecoration, []);
    }
  }

  private async ensureConfiguredOrGuide(): Promise<boolean> {
    if (await this.settings.isConfigured()) {
      return true;
    }
    const pick = await vscode.window.showInformationMessage(
      'AI 功能需要先配置模型服务（API 地址 / 模型 / API 密钥）。',
      '去配置',
    );
    if (pick === '去配置') {
      this.openSettingsPanel();
    }
    return false;
  }

  private notConfigured(): DriverError {
    return new DriverError('E_AI_NOT_CONFIGURED', 'AI 功能需要先配置模型服务（API 地址 / 模型 / API 密钥）');
  }

  /** 统一错误呈现：取消静默、未配置引导、其余 error Toast（交互稿 §15.5） */
  private showAiError(err: unknown, where: 'toast' | 'modal'): void {
    if (DriverError.is(err) && err.code === 'E_AI_ABORTED') {
      return; // 用户取消不提示
    }
    if (DriverError.is(err) && err.code === 'E_AI_NOT_CONFIGURED' && where === 'toast') {
      void vscode.window.showInformationMessage(err.message, '去配置').then((pick) => {
        if (pick === '去配置') {
          this.openSettingsPanel();
        }
      });
      return;
    }
    const text = err instanceof Error ? err.message : String(err);
    void vscode.window.showErrorMessage(`AI 请求失败：${text}`);
  }

  // ── 上下文（绑定库 schema 摘要；>50 表圈选，会话级记忆） ───────────────

  /** undefined = 用户在圈选步骤取消 */
  private async loadAiContext(info?: ConsoleBindingInfo): Promise<LoadedContext | undefined> {
    if (!info) {
      return { context: { tables: [], columns: [] }, label: '未绑定连接（不携带表结构）' };
    }
    const cfg = this.connections.getConfig(info.connId);
    const label = `${cfg?.name ?? info.connId}${info.db ? ` · ${info.db}` : ''}`;
    const context: AiPromptContext = {
      dialectId: this.connections.getDriver(info.connId)?.id,
      tables: [],
      columns: [],
    };
    if (info.consoleId) {
      // 补全数据源即 schema 摘要（MetadataCache 缓存命中；失败静默降级为无结构）
      const source = await this.console.completionFor(info.consoleId);
      if (source) {
        context.tables = source.tables;
        context.columns = source.columns;
      }
    }
    let selectedTables: string[] | undefined;
    if (context.tables.length > AI_CONTEXT_TABLE_LIMIT) {
      const key = `${info.connId}/${info.db ?? ''}`;
      const picked = await this.pickTables(key, context);
      if (!picked) {
        return undefined;
      }
      selectedTables = picked;
    }
    return { context, selectedTables, label };
  }

  private pickTables(key: string, context: AiPromptContext): Promise<string[] | undefined> {
    return new Promise((resolve) => {
      const qp = vscode.window.createQuickPick();
      qp.canSelectMany = true;
      qp.matchOnDescription = true;
      qp.title = `选择提供给 AI 的表（当前库共 ${context.tables.length} 张）`;
      qp.placeholder = '键入过滤，Enter 确认所选（至少一张）——所选表结构将发送给 AI 服务';
      qp.items = context.tables.map((t) => ({ label: t.name, description: t.comment }));
      const remembered = this.tablePickMemory.get(key);
      if (remembered) {
        qp.selectedItems = qp.items.filter((i) => remembered.includes(i.label));
      }
      let done = false;
      const finish = (v?: string[]): void => {
        if (!done) {
          done = true;
          qp.dispose();
          resolve(v);
        }
      };
      qp.onDidAccept(() => {
        const names = qp.selectedItems.map((i) => i.label);
        if (names.length === 0) {
          qp.placeholder = '至少选择一张表（Esc 取消）';
          return;
        }
        this.tablePickMemory.set(key, names);
        finish(names);
      });
      qp.onDidHide(() => finish());
      qp.show();
    });
  }

  // ── 生成（NL→SQL，交互稿 §15.2） ─────────────────────────────────

  /** CodeLens 传 (uri, position)=语句前插入；快捷键/命令面板无参 = 光标处插入 */
  async generateSql(uri?: vscode.Uri, position?: vscode.Position): Promise<void> {
    const doc = uri ? await vscode.workspace.openTextDocument(uri) : vscode.window.activeTextEditor?.document;
    if (!doc || doc.languageId !== 'sql') {
      void vscode.window.showInformationMessage('当前编辑器不是 SQL 文档。');
      return;
    }
    if (!(await this.ensureConfiguredOrGuide())) {
      return;
    }
    const binding = this.console.bindingForDocument(doc);
    const info: ConsoleBindingInfo | undefined = binding
      ? { connId: binding.connId, db: binding.db, consoleId: binding.consoleId }
      : undefined;
    if (info && this.connections.getDriver(info.connId)?.capabilities.supportsSQL === false) {
      void vscode.window.showInformationMessage('AI 生成仅支持 SQL 数据源。');
      return;
    }
    const loaded = await this.loadAiContext(info);
    if (!loaded) {
      return; // 圈选取消
    }
    const nl = await this.askPrompt(
      `生成 SQL${info ? ` · ${loaded.label}` : ''}`,
      '描述你要的查询，Enter 生成、Esc 取消',
    );
    if (!nl) {
      return;
    }
    const provider = await this.settings.resolveProvider().catch((err) => {
      this.showAiError(err, 'toast');
      return undefined;
    });
    if (!provider) {
      return;
    }
    const { system, user } = buildGeneratePrompt({ nl, context: loaded.context, selectedTables: loaded.selectedTables });
    this.logger.info(
      'ai',
      `AI 生成开始：${loaded.label} · 模型 ${provider.modelId} · 上下文 ${loaded.context.tables.length} 表${
        loaded.selectedTables ? `（选定 ${loaded.selectedTables.length}）` : ''
      } · prompt ${user.length} 字符`,
    );

    const editor = await vscode.window.showTextDocument(doc);
    const anchored = position !== undefined;
    const anchorOffset = anchored ? doc.offsetAt(position) : doc.offsetAt(editor.selection.active);
    const anchorPos = doc.positionAt(anchorOffset);
    // 编辑器内 loading（锚点行尾 spinner 装饰，渲染不入文件）+ 窗口进度通知（取消入口）
    this.showEditorStatus(editor, anchorPos, 'AI 正在生成…');
    let sql = '';
    try {
      sql = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: 'AI 正在生成 SQL…', cancellable: true },
        async (_progress, token) => {
          const controller = new AbortController();
          token.onCancellationRequested(() => controller.abort());
          return extractSqlFromResponse(
            await provider.complete({ system, prompt: user, signal: controller.signal }),
          );
        },
      );
    } catch (err) {
      this.logger.error('ai', `AI 生成失败：${describeError(err)}`);
      this.showAiError(err, 'toast');
      return;
    } finally {
      this.clearEditorStatus(editor);
    }
    if (!sql) {
      void vscode.window.showInformationMessage('AI 未返回可用的 SQL，可重试。');
      return;
    }
    const offset = anchored ? anchorOffset : doc.offsetAt(editor.selection.active);
    // 直插即草稿（D-24）：CodeLens 锚点 = 语句前插入（补两空行分隔）；光标 = 原位插入
    const insertText = anchored ? `${sql}\n\n` : sql;
    const applied = await editor.edit((builder) => builder.insert(doc.positionAt(offset), insertText));
    if (!applied) {
      return;
    }
    editor.selection = new vscode.Selection(doc.positionAt(offset), doc.positionAt(offset + sql.length));
    this.logger.info(
      'ai',
      `AI 生成完成：${provider.modelId} · ${sql.length} 字符 → ${doc.uri.fsPath}${anchored ? '（语句前插入）' : '（光标处）'}`,
    );
  }

  private askPrompt(title: string, placeholder: string): Promise<string | undefined> {
    return new Promise((resolve) => {
      const qp = vscode.window.createQuickPick();
      qp.title = title;
      qp.placeholder = placeholder;
      qp.ignoreFocusOut = true;
      let done = false;
      const finish = (v?: string): void => {
        if (!done) {
          done = true;
          qp.dispose();
          resolve(v);
        }
      };
      qp.onDidAccept(() => {
        const value = qp.value.trim();
        if (value) {
          finish(value);
        }
      });
      qp.onDidHide(() => finish());
      qp.show();
    });
  }

  // ── 解释（交互稿 §15.3）：流式写入 Console「AI 解释」Tab ─────────────

  async explainActiveSql(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== 'sql') {
      void vscode.window.showInformationMessage('当前编辑器不是 SQL 文档。');
      return;
    }
    if (!(await this.ensureConfiguredOrGuide())) {
      return;
    }
    const doc = editor.document;
    const state = await this.console.ensureBinding(doc);
    if (!state) {
      return; // 未选择连接
    }
    if (this.connections.getDriver(state.connId)?.capabilities.supportsSQL === false) {
      void vscode.window.showInformationMessage('AI 解释仅支持 SQL 数据源。');
      return;
    }
    let sql: string | undefined;
    if (!editor.selection.isEmpty) {
      sql = doc.getText(editor.selection);
    } else {
      sql = statementAtOffset(splitSqlStatements(doc.getText()), doc.offsetAt(editor.selection.active))?.text;
    }
    if (!sql || !sql.trim()) {
      void vscode.window.showInformationMessage('未找到可解释的 SQL：选中一段 SQL，或把光标放在语句内。');
      return;
    }
    const loaded = await this.loadAiContext({ connId: state.connId, db: state.db, consoleId: state.consoleId });
    if (!loaded) {
      return;
    }
    await this.runExplain(
      state.consoleId,
      { connId: state.connId, db: state.db, consoleId: state.consoleId },
      sql,
      loaded,
    );
  }

  /** 「AI 解释」Tab 错误态的重试入口：复跑最近一次解释（入参原样，上下文重载） */
  async retryExplain(consoleId: string): Promise<void> {
    const last = this.lastExplains.get(consoleId);
    if (!last) {
      throw new DriverError('E_NOT_FOUND', '没有可重试的 AI 解释');
    }
    if (!(await this.settings.isConfigured())) {
      throw this.notConfigured();
    }
    const loaded = await this.loadAiContext(last.info);
    if (!loaded) {
      throw new DriverError('E_CANCELED', '已取消');
    }
    await this.runExplain(consoleId, last.info, last.sql, loaded);
  }

  private async runExplain(
    consoleId: string,
    info: ConsoleBindingInfo,
    sql: string,
    loaded: LoadedContext,
  ): Promise<void> {
    const provider = await this.settings.resolveProvider();
    const { system, user } = buildExplainPrompt({ sql, context: loaded.context, selectedTables: loaded.selectedTables });
    this.lastExplains.set(consoleId, { info, sql });
    this.logger.info(
      'ai',
      `AI 解释开始：${consoleId} · 模型 ${provider.modelId} · 上下文 ${loaded.context.tables.length} 表 · SQL ${sql.length} 字符 / prompt ${user.length} 字符`,
    );

    this.explainControllers.get(consoleId)?.abort(); // 新一轮取消上一轮（结果面板以最近一次为准）
    const controller = new AbortController();
    this.explainControllers.set(consoleId, controller);
    const seq = ++this.aiSeq;
    const isLatest = (): boolean => this.explainControllers.get(consoleId) === controller;

    this.console.setAi(consoleId, { seq, status: 'running', content: '' }, { reveal: true });
    const start = Date.now();
    let content = '';
    let lastPush = 0;
    const push = (
      status: ConsoleAi['status'],
      force: boolean,
      extra?: { errorCode?: string; errorMessage?: string },
    ): void => {
      const now = Date.now();
      if (!force && now - lastPush < MAX_STREAM_PUSH_INTERVAL_MS) {
        return;
      }
      lastPush = now;
      if (isLatest()) {
        this.console.setAi(consoleId, { seq, status, content, ...extra });
      }
    };
    try {
      const final = await provider.complete({
        system,
        prompt: user,
        signal: controller.signal,
        onDelta: (delta) => {
          content += delta;
          push('running', false);
        },
      });
      content = final || content;
      if (isLatest()) {
        this.console.setAi(consoleId, { seq, status: 'done', content });
      }
      this.logger.info('ai', `AI 解释完成：${consoleId} #${seq}（${Date.now() - start}ms，${content.length} 字符）`);
    } catch (err) {
      const stale = !isLatest();
      if (!stale) {
        this.console.setAi(consoleId, {
          seq,
          status: 'error',
          content,
          errorCode: DriverError.is(err) ? err.code : 'E_INTERNAL',
          errorMessage: err instanceof Error ? err.message : String(err),
        });
      }
      this.logger[stale ? 'debug' : 'error']('ai', `AI 解释${stale ? '被新一轮取代' : '失败'}：${describeError(err)}`);
    } finally {
      if (isLatest()) {
        this.explainControllers.delete(consoleId);
      }
    }
  }

  // ── 错误修复（交互稿 §15.4）：错误 item → 语句定位 → AI → diff 确认 ──

  async fixError(consoleId: string, seq: number): Promise<AiFixErrorResult> {
    const info = this.console.consoleInfoFor(consoleId);
    if (!info) {
      throw new DriverError('E_NOT_FOUND', 'Console 不存在（可能已关闭）');
    }
    const item = this.console.errorItemFor(consoleId, seq);
    if (!item || !item.error) {
      throw new DriverError('E_VALIDATION', '该执行项不是错误或已不存在');
    }
    const uri = this.console.documentUriForConsole(consoleId);
    if (!uri) {
      throw new DriverError('E_VALIDATION', '该错误无文档来源，无法生成修复建议');
    }
    if (!(await this.settings.isConfigured())) {
      throw this.notConfigured();
    }
    if (this.connections.getDriver(info.connId)?.capabilities.supportsSQL === false) {
      throw new DriverError('E_UNSUPPORTED', 'AI 修复仅支持 SQL 数据源');
    }
    const doc = await vscode.workspace.openTextDocument(uri);
    const stmt = this.locateStatement(doc, item.sql);
    if (!stmt) {
      throw new DriverError('E_VALIDATION', '文档已修改，无法定位原语句——请基于当前文档重新执行后再试');
    }
    const provider = await this.settings.resolveProvider();
    const loaded = await this.loadAiContext({ connId: info.connId, db: info.db, consoleId });
    if (!loaded) {
      throw new DriverError('E_CANCELED', '已取消');
    }
    const { system, user } = buildFixPrompt({
      sql: item.sql,
      code: item.error.code,
      message: item.error.message,
      context: loaded.context,
      selectedTables: loaded.selectedTables,
    });
    this.logger.info(
      'ai',
      `AI 修复开始：${consoleId} #${seq} · 模型 ${provider.modelId} · 上下文 ${loaded.context.tables.length} 表 · 语句 ${item.sql.length} 字符 / 错误码 ${item.error.code}`,
    );
    const response = await provider.complete({ system, prompt: user }).catch((err) => {
      this.logger.error('ai', `AI 修复失败：${describeError(err)}`);
      throw err;
    });
    const suggestedSql = extractSqlFromResponse(response);
    if (!suggestedSql) {
      this.logger.error('ai', `AI 修复失败：模型未返回 SQL（响应 ${response.length} 字符）`);
      throw new DriverError('E_AI_REQUEST_FAILED', 'AI 未返回可用的 SQL，可重试');
    }
    const fixId = `fix-${Date.now()}-${++this.fixSeq}`;
    // 上限裁剪：只保留最近 20 条（一次性凭据，Modal 确认后即消费）
    while (this.fixes.size >= MAX_FIX_ENTRIES) {
      const oldest = this.fixes.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.fixes.delete(oldest);
    }
    this.fixes.set(fixId, {
      uriString: uri.toString(),
      start: stmt.start,
      end: stmt.end,
      originalSql: stmt.text,
      suggestedSql,
    });
    this.logger.info('ai', `AI 修复建议生成：${consoleId} #${seq} → ${doc.uri.fsPath}（原 ${item.sql.length} 字符 / 建议 ${suggestedSql.length} 字符）`);
    return { fixId, originalSql: item.sql, suggestedSql };
  }

  /** 在当前文档文本中按空白归一化匹配原语句（执行后文档未被编辑即命中） */
  private locateStatement(doc: vscode.TextDocument, sql: string): { start: number; end: number; text: string } | undefined {
    const target = sql.replace(/\s+/g, ' ').trim();
    return splitSqlStatements(doc.getText()).find(
      (s) => s.text.replace(/\s+/g, ' ').trim() === target,
    );
  }

  async applyFix(fixId: string, mode: 'replace' | 'insert'): Promise<Record<string, never>> {
    const entry = this.fixes.get(fixId);
    if (!entry) {
      throw new DriverError('E_STATE_LOST', '修复建议已过期或已应用，请重新生成');
    }
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(entry.uriString));
    const start = doc.positionAt(entry.start);
    const end = doc.positionAt(entry.end);
    const current = doc.getText(new vscode.Range(start, end));
    // 状态校验（D-24 决议 3）：偏移处文本仍与原语句一致才应用——比严格版本号更能容忍无关编辑
    if (current.replace(/\s+/g, ' ').trim() !== entry.originalSql.replace(/\s+/g, ' ').trim()) {
      this.fixes.delete(fixId);
      throw new DriverError('E_STATE_LOST', '文档已修改，建议基于最新内容重新生成');
    }
    const editor = await vscode.window.showTextDocument(doc, { preserveFocus: true });
    const edit = new vscode.WorkspaceEdit();
    let selection: vscode.Selection;
    if (mode === 'replace') {
      edit.replace(doc.uri, new vscode.Range(start, end), entry.suggestedSql);
      selection = new vscode.Selection(start, doc.positionAt(entry.start + entry.suggestedSql.length));
    } else {
      // 插入为新语句：越过尾分号，另起两行插入
      let insertOffset = entry.end;
      if (doc.getText().charCodeAt(insertOffset) === 59 /* ';' */) {
        insertOffset += 1;
      }
      const text = `\n\n${entry.suggestedSql}`;
      edit.insert(doc.uri, doc.positionAt(insertOffset), text);
      selection = new vscode.Selection(
        doc.positionAt(insertOffset + 2),
        doc.positionAt(insertOffset + text.length),
      );
    }
    const applied = await vscode.workspace.applyEdit(edit);
    if (!applied) {
      throw new DriverError('E_INTERNAL', '文档编辑失败，请重试');
    }
    editor.selection = selection;
    this.fixes.delete(fixId);
    this.logger.info('ai', `AI 修复建议已应用（${mode === 'replace' ? '替换原语句' : '插入为新语句'}）→ ${doc.uri.fsPath}`);
    return {};
  }
}
