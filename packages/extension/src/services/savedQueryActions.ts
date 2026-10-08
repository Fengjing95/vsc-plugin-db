/**
 * 保存查询的 VSCode 交互层（概要设计 §5.5.2 P1）。
 * 纯函数（命名/消毒/摘要）在 savedQueries.ts；本文件含 vscode 依赖，不进单测。
 */
import * as vscode from 'vscode';
import type { ConsoleService } from './consoleService';
import { defaultQueryName, queryPathSegment, querySummary, sanitizeQueryFileName, timestampQueryName } from './savedQueries';

/** 查询目录：<workspace>/.vscode/db-queries（§5.5.2；多根工作区取第一个，与导出默认目录口径一致） */
export function queriesFolder(): vscode.Uri | undefined {
  const ws = vscode.workspace.workspaceFolders?.[0];
  return ws ? vscode.Uri.joinPath(ws.uri, '.vscode', 'db-queries') : undefined;
}

/**
 * 保存活动 SQL 编辑器内容为查询文件。源文档（untitled Console）已有连接绑定时，
 * 新文件自动继承绑定（§7.1 绑定可持久化到文件的语义延伸）。
 */
export async function saveActiveQuery(consoleService: ConsoleService): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  const doc = editor?.document;
  if (!doc || doc.languageId !== 'sql') {
    void vscode.window.showInformationMessage('当前编辑器不是 SQL 文档。');
    return;
  }
  const text = doc.getText();
  if (!text.trim()) {
    void vscode.window.showInformationMessage('没有可保存的内容。');
    return;
  }
  const folderRoot = queriesFolder();
  if (!folderRoot) {
    void vscode.window.showErrorMessage('当前没有打开的工作区，无法保存查询。');
    return;
  }
  // 源文档已有绑定（connId+db）时保存到对应「查询」目录子目录（与树查询目录同构）；未绑定落根目录
  const sourceBinding = consoleService.bindingForDocument(doc);
  const folder =
    sourceBinding?.connId && sourceBinding.db
      ? vscode.Uri.joinPath(folderRoot, sourceBinding.connId, queryPathSegment(sourceBinding.db))
      : folderRoot;

  const name = await vscode.window.showInputBox({
    title: '保存查询',
    prompt: '保存到工作区 .vscode/db-queries/…/<名称>.sql',
    placeHolder: '查询名称',
    value: defaultQueryName(text),
  });
  if (name === undefined) {
    return; // 用户取消
  }
  const safe = sanitizeQueryFileName(name) || timestampQueryName();
  const target = vscode.Uri.joinPath(folder, `${safe}.sql`);

  try {
    await vscode.workspace.fs.stat(target);
    const overwrite = await vscode.window.showWarningMessage(
      `查询 "${safe}.sql" 已存在，覆盖？`,
      { modal: true },
      '覆盖',
    );
    if (overwrite !== '覆盖') {
      return;
    }
  } catch {
    // 不存在 → 直接创建
  }

  await vscode.workspace.fs.createDirectory(folder);
  await vscode.workspace.fs.writeFile(target, Buffer.from(text, 'utf8'));

  const newDoc = await vscode.workspace.openTextDocument(target);
  await vscode.window.showTextDocument(newDoc, { preview: false, viewColumn: editor.viewColumn });
  // 绑定继承：保存出的查询文件可立即执行（§7.1 文件绑定持久化）；sourceBinding 已在保存目录决策时取得
  if (sourceBinding && !consoleService.bindingForDocument(newDoc)) {
    await consoleService.ensureBinding(newDoc, { connId: sourceBinding.connId, db: sourceBinding.db ?? undefined });
  }
  void vscode.window.setStatusBarMessage(`已保存查询：${safe}.sql`, 3000);
}

/** 打开保存的查询：QuickPick 列出（含各连接/库子目录，按修改时间倒序），回车打开文件 */
export async function pickSavedQuery(): Promise<void> {
  const files = await vscode.workspace.findFiles('.vscode/db-queries/**/*.sql', '**/node_modules/**', 200);
  if (files.length === 0) {
    void vscode.window.showInformationMessage('还没有保存的查询（树「查询」目录或 Console 中「保存查询」）。');
    return;
  }
  const items = await Promise.all(
    files.map(async (uri) => {
      let summary = '';
      let modified = '';
      try {
        const stat = await vscode.workspace.fs.stat(uri);
        modified = new Date(stat.mtime).toLocaleString();
        const text = new TextDecoder('utf-8', { fatal: false }).decode(await vscode.workspace.fs.readFile(uri));
        summary = querySummary(text);
      } catch {
        // 读取失败仅降级摘要
      }
      // 含子目录时以 db-queries 下相对路径区分（同 displaying 名文件可能分布在多个连接/库）
      const rel = uri.path.split('/db-queries/')[1] ?? uri.fsPath;
      return {
        label: rel,
        description: modified,
        detail: summary,
        uri,
      };
    }),
  );
  items.sort((a, b) => (a.description < b.description ? 1 : -1));
  const picked = await vscode.window.showQuickPick(items, {
    title: '打开保存的查询',
    placeHolder: '.vscode/db-queries/**/*.sql（按修改时间排序）',
  });
  if (!picked) {
    return;
  }
  const doc = await vscode.workspace.openTextDocument(picked.uri);
  await vscode.window.showTextDocument(doc, { preview: false });
}
