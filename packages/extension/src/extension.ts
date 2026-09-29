import * as vscode from 'vscode';
import { DriverRegistry, type ConnectionConfig } from '@db-explorer/core';
import { createMockDriver } from '@db-explorer/driver-mock';
import { createMysqlDriver } from '@db-explorer/driver-mysql';
import { registerCommands } from './commands';
import { ConnectionManager } from './services/connectionManager';
import { ConnectionStore } from './services/connectionStore';
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
  const tree = new ConnectionsTreeProvider(connections);
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
    ...registerCommands(context, { registry, store, connections, output }, tree),
  );
}

export function deactivate(): void {
  // ConnectionManager 随 context.subscriptions dispose，统一关闭连接池
}
