import * as vscode from 'vscode';
import type { ConnectionManager } from './services/connectionManager';
import type { ConnectionsTreeProvider, DbTreeNode } from './tree/treeDataProvider';
import { openTablePanel } from './views/tablePanel';

export function registerCommands(
  context: vscode.ExtensionContext,
  tree: ConnectionsTreeProvider,
  connections: ConnectionManager,
): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand('dbExplorer.focus', async () => {
      await vscode.commands.executeCommand('dbExplorer.connections.focus');
    }),

    vscode.commands.registerCommand('dbExplorer.newConnection', () => {
      void vscode.window.showInformationMessage(
        '连接管理（新建/编辑/SecretStorage）在 M1 交付；当前内置 Mock 数据源用于开发演示。',
      );
    }),

    vscode.commands.registerCommand('dbExplorer.refresh', () => {
      tree.refresh();
    }),

    vscode.commands.registerCommand('dbExplorer.newQuery', () => {
      void vscode.window.showInformationMessage('SQL Console 在 M5 交付。');
    }),

    vscode.commands.registerCommand('dbExplorer.openTable', async (node?: DbTreeNode) => {
      const { connId, db, obj } = node?.payload ?? {};
      if (!connId || !db || !obj) {
        return;
      }
      await openTablePanel(context, connections, {
        connId,
        db,
        obj,
        viewId: `${connId}/${db}/${obj}`,
        title: `${obj} @ ${db}`,
      });
    }),
  ];
}
