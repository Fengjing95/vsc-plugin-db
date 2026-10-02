import * as vscode from 'vscode';
import { ChangeSetService, DriverRegistry, MetadataCache, type ConnectionConfig } from '@db-explorer/core';
import { createMockDriver } from '@db-explorer/driver-mock';
import { createMysqlDriver } from '@db-explorer/driver-mysql';
import { createRedisDriver } from '@db-explorer/driver-redis';
import { registerCommands } from './commands';
import { ConnectionManager } from './services/connectionManager';
import { ConnectionStore } from './services/connectionStore';
import { ConsoleHistory } from './services/consoleHistory';
import { ConsoleService } from './services/consoleService';
import { registerConsoleCompletion } from './services/consoleCompletion';
import { EditGuard, ViewStateStore } from './services/editGuard';
import { registerConsoleResultView } from './views/consolePanel';
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
  // M6 Redis 驱动：仅注册（可插拔验收），树/取数/命令控制台路径零核心改动
  registry.register(createRedisDriver());

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
  // M5 SQL Console：绑定/执行链/结果面板/历史（概要设计 §5.5）
  const history = new ConsoleHistory(context.workspaceState, connections);
  const consoleService = new ConsoleService(
    context,
    connections,
    cache,
    editGuard,
    history,
    output,
    () => tree.refresh(),
  );

  await store.ensureSeed(MOCK_CONNECTION);

  context.subscriptions.push(
    registry,
    connections,
    output,
    treeView,
    consoleService,
    registerConsoleResultView(context, { connections, output, console: consoleService }),
    registerConsoleCompletion(context, consoleService),
    store.onDidChange(() => tree.refresh()),
    // 连接状态变化（建连/断开）→ 树刷新连接节点徽标（概要 §8.1）
    connections.onDidChangeStatus(() => tree.refresh()),
    ...registerCommands(
      context,
      {
        registry,
        store,
        connections,
        output,
        changesets,
        viewStates,
        editGuard,
        console: consoleService,
        history,
      },
      tree,
    ),
  );
}

export function deactivate(): void {
  // ConnectionManager / ConsoleService 随 context.subscriptions dispose，统一关闭连接池
}
