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
import { t } from './i18n';
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

/**
 * C 方案内联 diff 预览态（实机反馈二修：行尾小字不直观 → 预览即真实插入建议文本，
 * 红块（旧语句，删除线）+ 绿块（新语句，多行语法高亮）真实对照）：
 * - 生成后把建议 SQL 真实插入到原语句尾分号之后（另起两行），文档此时包含新旧两份
 * - 「保留更改」= 删除 [原语句起, 插入段止) 整段并替换为建议 SQL（建议顶替原位置）
 * - 「放弃」= 删除插入段，文档还原
 * - 预览期间编辑文档 → 自动放弃并还原插入段（按内容定位，偏移漂移不依赖）
 */
interface PendingInlineFix {
  fixId: string;
  uri: vscode.Uri;
  /** 原语句裸范围（不含尾分号） */
  start: number;
  end: number;
  originalSql: string;
  suggestedSql: string;
  /** 插入段：插入点（原语句尾分号之后）与完整插入文本（前导两换行 + 建议 SQL） */
  insertOffset: number;
  insertedText: string;
  consoleId: string;
}

const MAX_STREAM_PUSH_INTERVAL_MS = 120;

export class AiAssistService {
  /** 圈选记忆（会话级）：key = connId/db（交互稿 §15.2「记住上次选择」仅内存） */
  private readonly tablePickMemory = new Map<string, string[]>();
  /** 每文档进行中的解释（新一轮取消上一轮，交互稿 §15.3） */
  private readonly explainControllers = new Map<string, AbortController>();
  /** 最近一次解释的入参（Tab 错误态「重试」按钮复跑，交互稿 §15.5） */
  private readonly lastExplains = new Map<string, { info: ConsoleBindingInfo; sql: string }>();
  private aiSeq = 0;
  private fixSeq = 0;
  /** 锚点行内 loading 装饰（行尾 `$(sync~spin) AI 正在生成…`，随进度清除）——复用单例 DecorationType 防泄漏 */
  private aiStatusDecoration?: vscode.TextEditorDecorationType;
  /** C 方案内联 diff 预览态（单例：一次一条，新建议顶掉旧建议） */
  private pendingFix?: PendingInlineFix;
  private guardRegistered = false;
  private readonly pendingFixChangeEmitter = new vscode.EventEmitter<void>();
  /** CodeLens 据此重渲染（箭头包装保 this，P-34） */
  readonly onPendingFixChanged = (fn: () => void): vscode.Disposable => this.pendingFixChangeEmitter.event(fn);
  private readonly delDecoration = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor('diffEditor.removedTextBackground'),
    textDecoration: 'line-through; opacity:0.75',
  });
  /** 插入段（新语句）绿色块——diff 编辑器「新增行」主题色 */
  private readonly addDecoration = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor('diffEditor.insertedTextBackground'),
  });
  private readonly disposables: vscode.Disposable[] = [
    this.pendingFixChangeEmitter,
    this.delDecoration,
    this.addDecoration,
  ];

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

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
    this.pendingFix = undefined;
  }

  // ── C 方案：编辑器内联 diff 预览（实机反馈：Modal 面积小 → decorations 就地呈现）──

  /** 当前内联预览（CodeLens「保留/放弃」数据源） */
  get currentInlineFix(): PendingInlineFix | undefined {
    return this.pendingFix;
  }

  private renderInlineFix(): void {
    const fix = this.pendingFix;
    for (const editor of vscode.window.visibleTextEditors) {
      if (!fix || editor.document.uri.toString() !== fix.uri.toString()) {
        // 非目标文档（或已清空）一律清残留——旧文档不留色块
        editor.setDecorations(this.delDecoration, []);
        editor.setDecorations(this.addDecoration, []);
        continue;
      }
      const doc = editor.document;
      // 红块：原语句（含尾分号，渲染到分号更有「整句被替换」的语义）
      const delEnd = Math.min(fix.insertOffset, doc.getText().length);
      editor.setDecorations(this.delDecoration, [
        { range: new vscode.Range(doc.positionAt(fix.start), doc.positionAt(delEnd)) },
      ]);
      // 绿块：插入的建议段（不含前导换行）
      const addStart = fix.insertOffset + 2; // 跳过前导 \n\n
      editor.setDecorations(this.addDecoration, [
        {
          range: new vscode.Range(doc.positionAt(addStart), doc.positionAt(addStart + fix.suggestedSql.length)),
          hoverMessage: t('AI 修复建议（绿色段）——行首选择「保留更改 / 放弃」'),
        },
      ]);
    }
  }

  private clearInlineFix(): void {
    this.pendingFix = undefined;
    this.renderInlineFix();
    this.pendingFixChangeEmitter.fire();
  }

  /** 文档编辑/关闭 → 预览失效：编辑场景自动放弃并还原插入段（按内容定位，不依赖偏移） */
  private registerInlineFixGuards(): void {
    if (this.guardRegistered) {
      return;
    }
    this.guardRegistered = true;
    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (
          e.contentChanges.length > 0 &&
          this.pendingFix &&
          e.document.uri.toString() === this.pendingFix.uri.toString()
        ) {
          void this.revertInsertedText();
          this.clearInlineFix();
        }
      }),
      vscode.workspace.onDidCloseTextDocument((doc) => {
        if (this.pendingFix && doc.uri.toString() === this.pendingFix.uri.toString()) {
          this.clearInlineFix();
        }
      }),
    );
  }

  /** 按内容定位并删除插入段（编辑导致偏移漂移时仍可靠）；找不到则交给用户 Ctrl+Z */
  private async revertInsertedText(): Promise<void> {
    const fix = this.pendingFix;
    if (!fix) {
      return;
    }
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === fix.uri.toString());
    if (!doc) {
      return; // 文档已关闭：untitled 丢弃即消失；file 文档未保存关闭时 VSCode 自会确认
    }
    const idx = doc.getText().indexOf(fix.insertedText, Math.max(0, fix.insertOffset - 32));
    if (idx >= 0) {
      const editor = vscode.window.visibleTextEditors.find(
        (e) => e.document.uri.toString() === fix.uri.toString(),
      );
      const range = new vscode.Range(doc.positionAt(idx), doc.positionAt(idx + fix.insertedText.length));
      if (editor) {
        await editor.edit((builder) => builder.delete(range));
      } else {
        const we = new vscode.WorkspaceEdit();
        we.delete(fix.uri, range);
        await vscode.workspace.applyEdit(we);
      }
    }
  }

  /** 「保留更改」：建议 SQL 顶替原语句（删除 [原语句起, 插入段止) 整段并替换为建议） */
  async acceptInlineFix(): Promise<void> {
    const fix = this.pendingFix;
    if (!fix) {
      return;
    }
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === fix.uri.toString());
    if (!doc) {
      this.clearInlineFix();
      return;
    }
    const editor = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === fix.uri.toString());
    const range = new vscode.Range(
      doc.positionAt(fix.start),
      doc.positionAt(fix.insertOffset + fix.insertedText.length),
    );
    // 最终校验：段内文本应仍为「原语句 + 插入段」形状（竞态防御；失配则按失效处理）
    const current = doc.getText(range);
    if (!current.startsWith(fix.originalSql) || !current.endsWith(fix.suggestedSql)) {
      this.clearInlineFix();
      void vscode.window.showInformationMessage(t('文档已修改，修复建议已失效——请重新执行后再试。'));
      return;
    }
    const applied = editor
      ? await editor.edit((builder) => builder.replace(range, fix.suggestedSql))
      : await vscode.workspace.applyEdit(
          (() => {
            const we = new vscode.WorkspaceEdit();
            we.replace(fix.uri, range, fix.suggestedSql);
            return we;
          })(),
        );
    this.clearInlineFix();
    if (applied && editor) {
      editor.selection = new vscode.Selection(
        range.start,
        editor.document.positionAt(fix.start + fix.suggestedSql.length),
      );
    }
    this.logger.info('ai', `AI 修复建议已保留（内联确认）：${fix.uri.fsPath}`);
  }

  /** 「放弃更改」：删除插入段还原文档，清预览 */
  async discardInlineFix(): Promise<void> {
    if (!this.pendingFix) {
      return;
    }
    await this.revertInsertedText();
    this.clearInlineFix();
    this.logger.info('ai', 'AI 修复建议已放弃（内联确认）');
  }

  /**
   * 应用后的「放弃」出口（实机反馈 #5：Copilot 式保留/丢弃）——VSCode 公开 API 无法在
   * diff 编辑器里放「保留/放弃」按钮（Copilot 内联聊天是私有 UI），最接近的形态：
   * 应用即生效 + 通知按钮一键还原原文（或 Ctrl+Z）。后续编辑介入时拒绝盲还原。
   */
  private offerDiscard(
    editor: vscode.TextEditor,
    start: vscode.Position,
    originalText: string,
    appliedText: string,
    label: string,
  ): void {
    const norm = (s: string): string => s.replace(/\s+/g, ' ').trim();
    const discardBtn = t('放弃这次修改');
    void vscode.window
      .showInformationMessage(t('{0}（Ctrl+Z 可撤销）', [label]), discardBtn)
      .then((pick) => {
        if (pick !== discardBtn) {
          return;
        }
        try {
          const doc = editor.document;
          const appliedRange = new vscode.Range(
            start,
            doc.positionAt(doc.offsetAt(start) + appliedText.length),
          );
          if (norm(doc.getText(appliedRange)) !== norm(appliedText)) {
            void vscode.window.showInformationMessage(t('后续编辑已介入，无法自动放弃——请用 Ctrl+Z 逐步撤销。'));
            return;
          }
          void editor.edit((builder) => builder.replace(appliedRange, originalText)).then((ok) => {
            if (ok) {
              this.logger.info('ai', `已放弃 AI 修改（还原原文）：${doc.uri.fsPath}`);
            }
          });
        } catch {
          void vscode.window.showInformationMessage(t('编辑器已关闭，无法自动放弃——重新打开后用 Ctrl+Z。'));
        }
      });
  }

  private async ensureConfiguredOrGuide(): Promise<boolean> {
    if (await this.settings.isConfigured()) {
      return true;
    }
    const setUp = t('去配置');
    const pick = await vscode.window.showInformationMessage(
      t('AI 功能需要先配置模型服务（API 地址 / 模型 / API 密钥）。'),
      setUp,
    );
    if (pick === setUp) {
      this.openSettingsPanel();
    }
    return false;
  }

  private notConfigured(): DriverError {
    return new DriverError('E_AI_NOT_CONFIGURED', t('AI 功能需要先配置模型服务（API 地址 / 模型 / API 密钥）'));
  }

  /** 统一错误呈现：取消静默、未配置引导、其余 error Toast（交互稿 §15.5） */
  private showAiError(err: unknown, where: 'toast' | 'modal'): void {
    if (DriverError.is(err) && err.code === 'E_AI_ABORTED') {
      return; // 用户取消不提示
    }
    if (DriverError.is(err) && err.code === 'E_AI_NOT_CONFIGURED' && where === 'toast') {
      const setUp = t('去配置');
      void vscode.window.showInformationMessage(err.message, setUp).then((pick) => {
        if (pick === setUp) {
          this.openSettingsPanel();
        }
      });
      return;
    }
    const text = err instanceof Error ? err.message : String(err);
    void vscode.window.showErrorMessage(t('AI 请求失败：{0}', [text]));
  }

  // ── 上下文（绑定库 schema 摘要；>50 表圈选，会话级记忆） ───────────────

  /** undefined = 用户在圈选步骤取消 */
  private async loadAiContext(info?: ConsoleBindingInfo): Promise<LoadedContext | undefined> {
    if (!info) {
      return { context: { tables: [], columns: [] }, label: t('未绑定连接（不携带表结构）') };
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
      qp.title = t('选择提供给 AI 的表（当前库共 {0} 张）', [context.tables.length]);
      qp.placeholder = t('键入过滤，Enter 确认所选（至少一张）——所选表结构将发送给 AI 服务');
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
          qp.placeholder = t('至少选择一张表（Esc 取消）');
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
      void vscode.window.showInformationMessage(t('当前编辑器不是 SQL 文档。'));
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
      void vscode.window.showInformationMessage(t('AI 生成仅支持 SQL 数据源。'));
      return;
    }
    const loaded = await this.loadAiContext(info);
    if (!loaded) {
      return; // 圈选取消
    }
    const nl = await this.askPrompt(
      info ? t('生成 SQL · {0}', [loaded.label]) : t('生成 SQL'),
      t('描述你要的查询，Enter 生成、Esc 取消'),
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
    // 编辑器内 loading（锚点行尾 spinner 装饰，渲染不入文件）+ 通知进度（右下角常驻可见、
    // 可取消、思考过程滚动显示——实机反馈 #1/#2）
    this.showEditorStatus(editor, anchorPos, t('AI 正在生成…'));
    let sql = '';
    try {
      sql = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: t('AI 正在生成 SQL…'), cancellable: true },
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
      void vscode.window.showInformationMessage(t('AI 未返回可用的 SQL，可重试。'));
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
    this.offerDiscard(editor, doc.positionAt(offset), '', insertText, t('已插入 AI 生成的 SQL（{0} 字符）', [sql.length]));
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
      void vscode.window.showInformationMessage(t('当前编辑器不是 SQL 文档。'));
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
      void vscode.window.showInformationMessage(t('AI 解释仅支持 SQL 数据源。'));
      return;
    }
    let sql: string | undefined;
    if (!editor.selection.isEmpty) {
      sql = doc.getText(editor.selection);
    } else {
      sql = statementAtOffset(splitSqlStatements(doc.getText()), doc.offsetAt(editor.selection.active))?.text;
    }
    if (!sql || !sql.trim()) {
      void vscode.window.showInformationMessage(t('未找到可解释的 SQL：选中一段 SQL，或把光标放在语句内。'));
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
      throw new DriverError('E_NOT_FOUND', t('没有可重试的 AI 解释'));
    }
    if (!(await this.settings.isConfigured())) {
      throw this.notConfigured();
    }
    const loaded = await this.loadAiContext(last.info);
    if (!loaded) {
      throw new DriverError('E_CANCELED', t('已取消'));
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
      throw new DriverError('E_NOT_FOUND', t('Console 不存在（可能已关闭）'));
    }
    const item = this.console.errorItemFor(consoleId, seq);
    if (!item || !item.error) {
      throw new DriverError('E_VALIDATION', t('该执行项不是错误或已不存在'));
    }
    // 定位主路径（实机反馈 #3 日志定因）：有快照时**直接用快照里的 uri 打开文档**——
    // 反查重建的 Uri.file(fsPath) 与执行时 doc.uri.toString() 在含空格/特殊字符路径上
    // 存在编码往返差异，uriString 比对会假失配；快照 uri 即执行时文档本身，无此问题
    const origin = this.console.itemOriginFor(consoleId, seq);
    const fallbackUri = origin ? undefined : this.console.documentUriForConsole(consoleId);
    if (!origin && !fallbackUri) {
      throw new DriverError('E_VALIDATION', t('该错误无文档来源，无法生成修复建议'));
    }
    if (!(await this.settings.isConfigured())) {
      throw this.notConfigured();
    }
    if (this.connections.getDriver(info.connId)?.capabilities.supportsSQL === false) {
      throw new DriverError('E_UNSUPPORTED', t('AI 修复仅支持 SQL 数据源'));
    }
    const doc = await vscode.workspace.openTextDocument(
      origin ? vscode.Uri.parse(origin.uriString) : (fallbackUri as vscode.Uri),
    );
    // 回退 = 全文语句文本匹配（文档其他位置被编辑导致偏移漂移时仍可命中）
    const stmt = this.locateByOrigin(doc, origin, item.sql) ?? this.locateStatement(doc, item.sql);
    if (!stmt) {
      this.logger.error(
        'ai',
        `AI 修复定位失败：文档 ${doc.uri.fsPath}（${doc.lineCount} 行，版本 执行时=${origin?.version ?? '?'} / 当前=${doc.version}，快照=${origin ? '有' : '无'}）；原语句前 40 字符「${item.sql.slice(0, 40)}」`,
      );
      throw new DriverError(
        'E_VALIDATION',
        t('无法在当前文档中定位原语句（文档可能已修改或已关闭重建）——请基于当前文档重新执行后再试'),
      );
    }
    const provider = await this.settings.resolveProvider();
    const loaded = await this.loadAiContext({ connId: info.connId, db: info.db, consoleId });
    if (!loaded) {
      throw new DriverError('E_CANCELED', t('已取消'));
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
      throw new DriverError('E_AI_REQUEST_FAILED', t('AI 未返回可用的 SQL，可重试'));
    }
    // 进入内联预览（C 方案二修）：建议 SQL **真实插入**到原语句尾分号之后（另起两行）——
    // 红块（原语句，删除线）+ 绿块（新语句，多行语法高亮）真实对照；「保留更改」= 建议
    // 顶替原语句位置，「放弃」= 删除插入段还原。行首 CodeLens「保留/放弃」+ 通知双入口。
    this.registerInlineFixGuards();
    const editor = await vscode.window.showTextDocument(doc, { preserveFocus: true, preview: false });
    const fullText = doc.getText();
    // 插入点：越过尾分号（快照裸终点即语句文本末尾；stmt.end 可能停分号前）
    let insertOffset = stmt.end;
    if (fullText.charCodeAt(insertOffset) === 59 /* ';' */) {
      insertOffset += 1;
    }
    const insertedText = `\n\n${suggestedSql}`;
    const appliedInsert = await editor.edit((builder) => builder.insert(doc.positionAt(insertOffset), insertedText));
    if (!appliedInsert) {
      throw new DriverError('E_INTERNAL', t('编辑器插入失败，请重试'));
    }
    const fixId = `fix-${Date.now()}-${++this.fixSeq}`;
    this.pendingFix = {
      fixId,
      uri: doc.uri,
      start: stmt.start,
      end: stmt.end,
      originalSql: stmt.text,
      suggestedSql,
      insertOffset,
      insertedText,
      consoleId,
    };
    this.renderInlineFix();
    this.pendingFixChangeEmitter.fire();
    this.logger.info('ai', `AI 修复建议生成（内联预览）：${consoleId} #${seq} → ${doc.uri.fsPath}（原 ${item.sql.length} 字符 / 建议 ${suggestedSql.length} 字符）`);
    // 通知冗余入口（编辑器标签被盖住时也可操作；不 await——预览态持续到用户操作，P-37 无 finally 依赖）
    const keepBtn = t('保留更改');
    const discardBtn = t('放弃');
    void vscode.window
      .showInformationMessage(t('已生成修复建议，请在编辑器中选择保留或放弃'), keepBtn, discardBtn)
      .then((pick) => {
        if (pick === keepBtn) {
          void this.acceptInlineFix();
        } else if (pick === discardBtn) {
          void this.discardInlineFix();
        }
      });
    return { fixId, originalSql: item.sql, suggestedSql };
  }

  /**
   * 主路径：执行时的语句范围快照（doc 即按快照 uri 打开的执行时文档）。
   * 版本一致（文档自执行以来一个字符都没动过）→ 快照必然有效，直通命中——绕开任何
   * 文本归一化死角；版本不同（确实编辑过）→ 再按偏移处文本与原语句（空白归一化）一致校验。
   */
  private locateByOrigin(
    doc: vscode.TextDocument,
    origin: { uriString: string; start: number; end: number; version: number } | undefined,
    sql: string,
  ): { start: number; end: number; text: string } | undefined {
    if (!origin) {
      return undefined;
    }
    if (origin.version === doc.version) {
      return { start: origin.start, end: origin.end, text: sql };
    }
    const text = doc.getText(new vscode.Range(doc.positionAt(origin.start), doc.positionAt(origin.end)));
    if (text.replace(/\s+/g, ' ').trim() !== sql.replace(/\s+/g, ' ').trim()) {
      return undefined;
    }
    return { start: origin.start, end: origin.end, text };
  }

  /** 回退：在当前文档全文中按空白归一化匹配原语句 */
  private locateStatement(doc: vscode.TextDocument, sql: string): { start: number; end: number; text: string } | undefined {
    const target = sql.replace(/\s+/g, ' ').trim();
    return splitSqlStatements(doc.getText()).find(
      (s) => s.text.replace(/\s+/g, ' ').trim() === target,
    );
  }

  /**
   * 编辑器内修复入口（实机反馈 #4）：失败语句行 CodeLens「✨ 修复建议」→ 定位 Console
   * 错误 item → 直接走 fixError（内联预览在编辑器呈现，不再经结果面板）。
   */
  async fixErrorAt(uri: vscode.Uri, position: vscode.Position): Promise<void> {
    const doc = await vscode.workspace.openTextDocument(uri);
    if (doc.languageId !== 'sql') {
      return;
    }
    const state = await this.console.ensureBinding(doc);
    if (!state) {
      return; // 未选择连接
    }
    const stmt = statementAtOffset(splitSqlStatements(doc.getText()), doc.offsetAt(position));
    if (!stmt) {
      void vscode.window.showInformationMessage(t('该位置已无语句（文档可能刚被编辑）。'));
      return;
    }
    const item = this.console.findErrorItemBySql(state.consoleId, stmt.text);
    if (!item) {
      void vscode.window.showInformationMessage(t('该语句最近的执行没有错误记录——编辑后请重新执行再试。'));
      return;
    }
    try {
      await this.fixError(state.consoleId, item.seq);
    } catch (err) {
      if (DriverError.is(err) && err.code === 'E_AI_ABORTED') {
        return;
      }
      void vscode.window.showErrorMessage(
        t('AI 修复建议失败：{0}', [err instanceof Error ? err.message : String(err)]),
      );
    }
  }

}
