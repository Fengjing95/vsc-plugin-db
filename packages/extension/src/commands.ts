import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import type { DriverRegistry } from '@db-explorer/core';
import type { ConnectionManager } from './services/connectionManager';
import type { ConsoleService } from './services/consoleService';
import { pickHistoryItem } from './services/consoleHistory';
import type { EditGuard, ViewStateStore } from './services/editGuard';
import { formatSql } from '@db-explorer/core';
import { pickSavedQuery, saveActiveQuery } from './services/savedQueryActions';
import { secretRefOf, type ConnectionStore } from './services/connectionStore';
import type { ConnectionsTreeProvider, DbTreeNode } from './tree/treeDataProvider';
import { openConnectionForm } from './views/connectionFormPanel';
import { closeTablePanelsFor, openTablePanel } from './views/tablePanel';

export interface AppServices {
  registry: DriverRegistry;
  store: ConnectionStore;
  connections: ConnectionManager;
  output: vscode.OutputChannel;
  /** M4 表格编辑：变更集权威副本 + 视图状态快照 + 编辑护栏 */
  changesets: import('@db-explorer/core').ChangeSetService;
  viewStates: ViewStateStore;
  editGuard: EditGuard;
  /** M5 SQL Console */
  console: ConsoleService;
  /** M5 执行历史 */
  history: import('./services/consoleHistory').ConsoleHistory;
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
  const { store, connections } = services;

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
      services.console.closeConsolesForConnection(connId);
      await services.history.removeConnection(connId);
      await store.delete(connId);
    }),

    vscode.commands.registerCommand('dbExplorer.disconnectConnection', async (node?: DbTreeNode) => {
      const connId = node?.payload.connId;
      if (!connId) {
        return;
      }
      const cfg = store.get(connId);
      if (!cfg) {
        return;
      }
      await connections.disconnect(connId);
      // 断开 = 回到空闲态：自动收起该连接节点（内容已失效，展开即重连）
      tree.collapseConnection(connId);
      // 无破坏性（懒连接 D-10：下次操作自动重连），不弹确认，状态栏轻提示即可
      void vscode.window.setStatusBarMessage(`已断开 ${cfg.name}（下次操作自动重连）`, 3000);
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

    vscode.commands.registerCommand('dbExplorer.newQuery', (node?: DbTreeNode) => {
      // 树上的连接/库节点右键 → 直接绑定该连接（库）；命令面板/快捷键 → 交互选择
      const { connId, db } = node?.payload ?? {};
      if (connId && (node?.type === 'connection' || node?.type === 'database')) {
        void services.console.newConsole({ connId, db: node.type === 'database' ? db : undefined });
      } else {
        void services.console.newConsole();
      }
    }),

    vscode.commands.registerCommand('dbExplorer.executeQuery', () => {
      void services.console.executeActiveEditor('cursor');
    }),

    vscode.commands.registerCommand('dbExplorer.executeQueryAll', () => {
      void services.console.executeActiveEditor('all');
    }),

    vscode.commands.registerCommand('dbExplorer.consoleSelectConnection', () => {
      void services.console.selectConnectionForActiveEditor();
    }),

    vscode.commands.registerCommand('dbExplorer.queryHistory', async () => {
      const item = await pickHistoryItem(services.history.list());
      if (item) {
        await services.console.rerunHistory(item);
      }
    }),

    // 保存查询（概要 §5.5.2 P1）：活动 SQL 文档 → .vscode/db-queries/*.sql
    vscode.commands.registerCommand('dbExplorer.saveQuery', () => {
      void saveActiveQuery(services.console);
    }),

    vscode.commands.registerCommand('dbExplorer.openSavedQuery', () => {
      void pickSavedQuery();
    }),

    // SQL 格式化（概要 §5.5.2 P1）：按绑定连接的方言格式化整个文档/选区（sql-formatter，T-10）
    vscode.commands.registerCommand('dbExplorer.formatSql', async () => {
      const editor = vscode.window.activeTextEditor;
      const doc = editor?.document;
      if (!doc || doc.languageId !== 'sql') {
        void vscode.window.showInformationMessage('当前编辑器不是 SQL 文档。');
        return;
      }
      let dialectId: string | undefined;
      const binding = services.console.bindingForDocument(doc);
      if (binding) {
        const connDriver = services.connections.getDriver(binding.connId);
        if (connDriver && !connDriver.capabilities.supportsSQL) {
          void vscode.window.showInformationMessage('命令控制台为命令模式，不适用 SQL 格式化。');
          return;
        }
        try {
          // 方言随连接（懒连接 D-10：格式化按操作语义按需建连；失败则退标准 SQL 兜底）
          const conn = await services.connections.ensureConnected(binding.connId);
          dialectId = conn.dialect?.id;
        } catch {
          dialectId = undefined;
        }
      }
      const selection = editor.selection;
      const range = selection.isEmpty
        ? new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length))
        : selection;
      const text = doc.getText(range);
      if (!text.trim()) {
        void vscode.window.showInformationMessage('没有可格式化的内容。');
        return;
      }
      const formatted = formatSql(text, dialectId);
      if (formatted === text) {
        return; // 无变化（含格式化失败原样返回），不打断输入状态
      }
      await editor.edit((builder) => builder.replace(range, formatted));
      void vscode.window.setStatusBarMessage(
        dialectId ? `已按 ${dialectId} 方言格式化` : '已格式化（标准 SQL）',
        2500,
      );
    }),

    vscode.commands.registerCommand('dbExplorer.openTable', async (node?: DbTreeNode) => {
      const { connId, db, obj, rowEstimate } = node?.payload ?? {};
      if (!connId || !db || !obj) {
        return;
      }
      await openTablePanel(context, services, {
        connId,
        db,
        obj,
        viewId: `${connId}/${db}/${obj}`,
        title: `${obj} @ ${db}`,
        rowEstimate: typeof rowEstimate === 'number' ? rowEstimate : undefined,
        readOnly: store.get(connId)?.readOnly ?? false,
        env: store.get(connId)?.env ?? null,
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
