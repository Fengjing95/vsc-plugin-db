/**
 * SQL CodeLens（M8 优化 + M9-AI 实机反馈）：
 * - 「▶ 执行」：每条可执行语句上方，与 Ctrl/Cmd+Enter 同一执行链（dbExplorer.executeQueryAt
 *   → consoleService.executeStatementAt → runStatements：绑定/危险判定/横幅/取消/历史全同）
 * - 「✨ 生成 SQL」（dbExplorer.ai.generateSql）：语句上方同排 + **光标跟随**——光标所在行
 *   没有语句入口（如空行）时在该行补一个（交互稿 §15.2 实机反馈：空行也能就地生成）
 * - 「✨ 修复建议」（dbExplorer.ai.fixErrorAt）：执行失败的语句行内入口——按执行注记的
 *   失败结果渲染，文档编辑即消失（注记同生命周期，交互稿 §15.4 实机反馈）
 * 语句定位复用 core splitSqlStatements（字符串/注释内分号不切分，P-24）。
 * 含 vscode 依赖，不进单测。
 */
import * as vscode from 'vscode';
import { splitSqlStatements } from '@db-explorer/core';
import type { ExecutionAnnotations } from './sqlExecutionDecorations';

export function registerSqlCodeLens(annotations: ExecutionAnnotations): vscode.Disposable {
  // 光标跟随：行号变化才触发 lens 重渲染（避免每次移动光标全量刷新）
  let cursorLine = -1;
  const changeEmitter = new vscode.EventEmitter<void>();

  const provider: vscode.CodeLensProvider = {
    onDidChangeCodeLenses: changeEmitter.event,
    provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
      if (doc.languageId !== 'sql') {
        return [];
      }
      const lenses: vscode.CodeLens[] = [];
      const lensLines = new Set<number>();
      const statements = splitSqlStatements(doc.getText());
      for (const stmt of statements) {
        const pos = doc.positionAt(stmt.start);
        lensLines.add(pos.line);
        const range = new vscode.Range(pos, pos);
        lenses.push(
          new vscode.CodeLens(range, {
            command: 'dbExplorer.executeQueryAt',
            title: '$(play) 执行',
            arguments: [doc.uri, pos],
          }),
          new vscode.CodeLens(range, {
            command: 'dbExplorer.ai.generateSql',
            title: '$(sparkle) 生成 SQL',
            arguments: [doc.uri, pos],
          }),
        );
      }
      if (statements.length === 0) {
        // 空文档：首行提供生成入口（生成结果直插光标处）
        const origin = new vscode.Range(0, 0, 0, 0);
        lenses.push(
          new vscode.CodeLens(origin, {
            command: 'dbExplorer.ai.generateSql',
            title: '$(sparkle) 生成 SQL',
            arguments: [doc.uri, new vscode.Position(0, 0)],
          }),
        );
        lensLines.add(0);
      }
      // 光标跟随：光标行无语句入口（空行/语句间）时补生成入口
      if (cursorLine >= 0 && cursorLine < doc.lineCount && !lensLines.has(cursorLine)) {
        const pos = new vscode.Position(cursorLine, 0);
        lenses.push(
          new vscode.CodeLens(new vscode.Range(pos, pos), {
            command: 'dbExplorer.ai.generateSql',
            title: '$(sparkle) 生成 SQL',
            arguments: [doc.uri, pos],
          }),
        );
      }
      // 执行失败的语句：行内修复入口（注记同生命周期——文档编辑即消失）
      for (const outcome of annotations.failedOutcomes(doc.uri)) {
        const pos = doc.positionAt(outcome.start);
        lenses.push(
          new vscode.CodeLens(new vscode.Range(pos, pos), {
            command: 'dbExplorer.ai.fixErrorAt',
            title: '$(sparkle) 修复建议',
            arguments: [doc.uri, pos],
          }),
        );
      }
      return lenses;
    },
  };

  return vscode.Disposable.from(
    changeEmitter,
    vscode.window.onDidChangeTextEditorSelection((e) => {
      const line = e.selections[0]?.active.line ?? -1;
      if (line !== cursorLine) {
        cursorLine = line;
        changeEmitter.fire();
      }
    }),
    annotations.onDidChange(() => changeEmitter.fire()),
    vscode.languages.registerCodeLensProvider({ language: 'sql' }, provider),
  );
}
