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

function copy(text: string, hint: string): void {
  void vscode.env.clipboard.writeText(text);
  void vscode.window.setStatusBarMessage(`已复制 ${hint}`, 2000);
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
      // 全局刷新：清空全部元数据缓存并重载（概要设计 5.3.3）
      tree.clearCacheAndRefresh();
    }),

    vscode.commands.registerCommand('dbExplorer.refreshNode', (node?: DbTreeNode) => {
      if (node) {
        tree.refreshSubtree(node);
      }
    }),

    vscode.commands.registerCommand('dbExplorer.newQuery', () => {
      void vscode.window.showInformationMessage('SQL Console 在 M5 交付。');
    }),

    vscode.commands.registerCommand('dbExplorer.openTable', async (node?: DbTreeNode) => {
      const { connId, db, obj, rowEstimate } = node?.payload ?? {};
      if (!connId || !db || !obj) {
        return;
      }
      await openTablePanel(context, connections, output, {
        connId,
        db,
        obj,
        viewId: `${connId}/${db}/${obj}`,
        title: `${obj} @ ${db}`,
        rowEstimate: typeof rowEstimate === 'number' ? rowEstimate : undefined,
        readOnly: store.get(connId)?.readOnly ?? false,
      });
    }),

    vscode.commands.registerCommand('dbExplorer.copyName', (node?: DbTreeNode) => {
      if (node) {
        copy(node.label, node.label);
      }
    }),

    vscode.commands.registerCommand('dbExplorer.copyQualifiedName', (node?: DbTreeNode) => {
      const { db, obj, column } = node?.payload ?? {};
      if (db && obj && column) {
        copy(`${db}.${obj}.${column}`, `${db}.${obj}.${column}`);
      }
    }),

    vscode.commands.registerCommand('dbExplorer.generateSelect', async (node?: DbTreeNode) => {
      const { connId, db, obj } = node?.payload ?? {};
      if (!connId || !db || !obj) {
        return;
      }
      const conn = await connections.ensureConnected(connId);
      const q = conn.quoteIdentifier ?? ((n: string) => `\`${n.replace(/`/g, '``')}\``);
      copy(`SELECT * FROM ${q(db)}.${q(obj)} LIMIT 100;`, 'SELECT 语句');
    }),

    vscode.commands.registerCommand('dbExplorer.viewDdl', async (node?: DbTreeNode) => {
      const { connId, db, obj } = node?.payload ?? {};
      if (!connId || !db || !obj) {
        return;
      }
      const conn = await connections.ensureConnected(connId);
      if (typeof conn.getDdl !== 'function') {
        void vscode.window.showInformationMessage('当前驱动未实现 DDL 查看。');
        return;
      }
      try {
        const ddl = await conn.getDdl(db, obj);
        const doc = await vscode.workspace.openTextDocument({ content: ddl, language: 'sql' });
        await vscode.window.showTextDocument(doc, { preview: true });
      } catch (err) {
        void vscode.window.showErrorMessage(
          `获取 DDL 失败：${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }),
  ];
}
