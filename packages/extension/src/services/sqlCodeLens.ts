/**
 * SQL CodeLens 执行动作（M8 优化）：每条可执行语句上方「▶ 执行」，
 * 触发与 Ctrl/Cmd+Enter 同一执行链（dbExplorer.executeQueryAt → consoleService.executeStatementAt
 * → runStatements：绑定/危险判定/横幅/取消/历史全同）。
 * M9-AI（D-24）：同排追加「✨ 生成 SQL」（dbExplorer.ai.generateSql，语句前插入生成结果）；
 * 文档无语句时首行显示生成入口（交互稿 §15.2）。
 * 语句定位复用 core splitSqlStatements（字符串/注释内分号不切分，P-24）。
 * 含 vscode 依赖，不进单测。
 */
import * as vscode from 'vscode';
import { splitSqlStatements } from '@db-explorer/core';

export function registerSqlCodeLens(): vscode.Disposable {
  const provider: vscode.CodeLensProvider = {
    provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
      if (doc.languageId !== 'sql') {
        return [];
      }
      const statements = splitSqlStatements(doc.getText());
      const lenses: vscode.CodeLens[] = [];
      for (const stmt of statements) {
        const pos = doc.positionAt(stmt.start);
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
      }
      return lenses;
    },
  };
  return vscode.languages.registerCodeLensProvider({ language: 'sql' }, provider);
}
