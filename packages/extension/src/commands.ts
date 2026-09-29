import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import type { DriverRegistry } from '@db-explorer/core';
import type { ConnectionManager } from './services/connectionManager';
import { secretRefOf, type ConnectionStore } from './services/connectionStore';
import type { ConnectionsTreeProvider, DbTreeNode } from './tree/treeDataProvider';
import { openConnectionForm } from './views/connectionFormPanel';
import { closeTablePanelsFor, openTablePanel } from './views/tablePanel';

export interface AppServices {
  registry: DriverRegistry;
  store: ConnectionStore;
  connections: ConnectionManager;
  output: vscode.OutputChannel;
}

export function registerCommands(
  context: vscode.ExtensionContext,
  services: AppServices,
  tree: ConnectionsTreeProvider,
): vscode.Disposable[] {
  const { store, connections, output } = services;

  return [
    vscode.commands.registerCommand('dbExplorer.focus', async () => {
      await vscode.commands.executeCommand('dbExplorer.connections.focus');
    }),

    vscode.commands.registerCommand('dbExplorer.newConnection', () => {
      openConnectionForm(context, services, undefined);
    }),

    vscode.commands.registerCommand('dbExplorer.editConnection', (node?: DbTreeNode) => {
      const connId = node?.payload.connId;
      if (connId) {
        openConnectionForm(context, services, connId);
      }
    }),

    vscode.commands.registerCommand('dbExplorer.copyConnection', async (node?: DbTreeNode) => {
      const connId = node?.payload.connId;
      if (!connId) {
        return;
      }
      const cfg = store.get(connId);
      if (!cfg) {
        return;
      }
      const newId = randomUUID();
      await store.save({ ...cfg, id: newId, name: `${cfg.name} 副本`, secretRef: secretRefOf(newId) });
      await store.copySecret(connId, newId);
    }),

    vscode.commands.registerCommand('dbExplorer.deleteConnection', async (node?: DbTreeNode) => {
      const connId = node?.payload.connId;
      if (!connId) {
        return;
      }
      const cfg = store.get(connId);
      if (!cfg) {
        return;
      }
      const confirmed = await vscode.window.showWarningMessage(
        `删除连接 "${cfg.name}"？`,
        {
          modal: true,
          detail: '将同时清除该连接保存的密码（SecretStorage），不影响数据库本身。',
        },
        '删除',
      );
      if (confirmed !== '删除') {
        return;
      }
      connections.invalidate(connId);
      closeTablePanelsFor(connId);
      await store.delete(connId);
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
      await openTablePanel(context, connections, output, {
        connId,
        db,
        obj,
        viewId: `${connId}/${db}/${obj}`,
        title: `${obj} @ ${db}`,
      });
    }),
  ];
}
