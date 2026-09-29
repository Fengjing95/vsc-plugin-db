import * as vscode from 'vscode';
import { DriverRegistry } from '@db-explorer/core';
import { createMockDriver } from '@db-explorer/driver-mock';
import { ConnectionManager } from './services/connectionManager';
import { ConnectionsTreeProvider } from './tree/treeDataProvider';
import { registerCommands } from './commands';

export function activate(context: vscode.ExtensionContext): void {
  const registry = new DriverRegistry();
  registry.register(createMockDriver());

  const connections = new ConnectionManager(registry);
  const tree = new ConnectionsTreeProvider(connections);
  const treeView = vscode.window.createTreeView('dbExplorer.connections', {
    treeDataProvider: tree,
    showCollapseAll: true,
  });

  context.subscriptions.push(
    registry,
    connections,
    treeView,
    ...registerCommands(context, tree, connections),
  );
}

export function deactivate(): void {
  // ConnectionManager 已随 context.subscriptions dispose，统一关闭连接池
}
