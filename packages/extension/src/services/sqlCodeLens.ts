/**
 * SQL CodeLens 执行动作（M8 优化）：每条可执行语句上方「▶ 执行」，
 * 触发与 Ctrl/Cmd+Enter 同一执行链（dbExplorer.executeQueryAt → consoleService.executeStatementAt
 * → runStatements：绑定/危险判定/横幅/取消/历史全同）。
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
      return splitSqlStatements(doc.getText()).map((stmt) => {
        const pos = doc.positionAt(stmt.start);
        return new vscode.CodeLens(new vscode.Range(pos, pos), {
          command: 'dbExplorer.executeQueryAt',
          title: '$(play) 执行',
          arguments: [doc.uri, pos],
        });
      });
    },
  };
  return vscode.languages.registerCodeLensProvider({ language: 'sql' }, provider);
}
