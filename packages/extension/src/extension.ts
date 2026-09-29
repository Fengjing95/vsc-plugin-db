import * as vscode from 'vscode';
import { ChangeSetService, DriverRegistry, MetadataCache, type ConnectionConfig } from '@db-explorer/core';
import { createMockDriver } from '@db-explorer/driver-mock';
import { createMysqlDriver } from '@db-explorer/driver-mysql';
import { registerCommands } from './commands';
import { ConnectionManager } from './services/connectionManager';
import { ConnectionStore } from './services/connectionStore';
import { EditGuard, ViewStateStore } from './services/editGuard';
import { ConnectionsTreeProvider } from './tree/treeDataProvider';

const MOCK_CONNECTION: ConnectionConfig = {
  id: 'mock-local',
  name: '本地 Mock 数据源',
  driverId: 'mock',
  env: 'dev',
  options: { host: '127.0.0.1', port: 3306 },
  secretRef: 'dbExplorer.secrets.mock-local',
};

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const registry = new DriverRegistry();
  registry.register(createMockDriver());
  registry.register(createMysqlDriver());

  const output = vscode.window.createOutputChannel('Database Explorer');
  const store = new ConnectionStore(context.globalState, context.secrets);
  const connections = new ConnectionManager(registry, store);
  const cache = new MetadataCache();
  // M4 表格编辑：ChangeSet 权威副本（ADR D-06）+ 视图状态快照 + 编辑护栏（§5.8 / D-03）
  const changesets = new ChangeSetService();
  const viewStates = new ViewStateStore();
  const editGuard = new EditGuard(connections, cache, output);
  const tree = new ConnectionsTreeProvider(connections, cache);
  const treeView = vscode.window.createTreeView('dbExplorer.connections', {
    treeDataProvider: tree,
    showCollapseAll: true,
  });

  await store.ensureSeed(MOCK_CONNECTION);

  context.subscriptions.push(
    registry,
    connections,
    output,
    treeView,
    store.onDidChange(() => tree.refresh()),
    ...registerCommands(
      context,
      { registry, store, connections, output, changesets, viewStates, editGuard },
      tree,
    ),
  );
}

export function deactivate(): void {
  // ConnectionManager 随 context.subscriptions dispose，统一关闭连接池
}
