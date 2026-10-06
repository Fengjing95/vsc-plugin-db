import * as vscode from 'vscode';
import { ChangeSetService, DriverRegistry, MetadataCache, type ConnectionConfig } from '@db-explorer/core';
import { createMockDriver } from '@db-explorer/driver-mock';
import { createMysqlDriver } from '@db-explorer/driver-mysql';
import { createPostgresDriver } from '@db-explorer/driver-postgres';
import { createRedisDriver } from '@db-explorer/driver-redis';
import { registerCommands } from './commands';
import { ConnectionManager } from './services/connectionManager';
import { ConnectionStore } from './services/connectionStore';
import { ConsoleHistory } from './services/consoleHistory';
import { ConsoleService } from './services/consoleService';
import { DdlService } from './services/ddlService';
import { registerConsoleCompletion } from './services/consoleCompletion';
import { EditGuard, ViewStateStore } from './services/editGuard';
import { GlobalStateFingerprintStore } from './services/sshTunnel';
import { SessionManager } from './services/sessionManager';
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
  // M8-PG PostgreSQL 驱动：仅注册（可插拔验收），树/取数/Console/DDL 路径零核心改动（D-15）
  registry.register(createPostgresDriver());
  // M6 Redis 驱动：仅注册（可插拔验收），树/取数/命令控制台路径零核心改动
  registry.register(createRedisDriver());

  const output = vscode.window.createOutputChannel('Database Explorer');
  const store = new ConnectionStore(context.globalState, context.secrets);
  // SSH 主机指纹库（TOFU，globalState 持久化）：ConnectionManager 与连接表单共享同一实例
  const sshFingerprints = new GlobalStateFingerprintStore(context.globalState);
  const connections = new ConnectionManager(registry, store, sshFingerprints);
  const cache = new MetadataCache();
  // M4 表格编辑：ChangeSet 权威副本（ADR D-06）+ 视图状态快照 + 编辑护栏（§5.8 / D-03）
  const changesets = new ChangeSetService();
  const viewStates = new ViewStateStore();
  const editGuard = new EditGuard(connections, cache, output);
  // M7 交互式事务（§4.6/D-09）：空闲超时自动回滚（默认 5min，可配置）；树徽标经 onDidChange 联动
  const sessions = new SessionManager(
    connections,
    () => vscode.workspace.getConfiguration('dbExplorer').get('transaction.idleTimeoutMs', 300_000),
    (message) => void vscode.window.showWarningMessage(message),
  );
  const tree = new ConnectionsTreeProvider(connections, cache, sessions);
  const treeView = vscode.window.createTreeView('dbExplorer.connections', {
    treeDataProvider: tree,
    showCollapseAll: true,
  });
  // 断开连接后收起节点（reveal 需要视图句柄与当前元素引用）
  tree.attachView(treeView);
  // M5 SQL Console：绑定/执行链/结果面板/历史（概要设计 §5.5）
  const history = new ConsoleHistory(context.workspaceState, connections);
  const consoleService = new ConsoleService(
    context,
    connections,
    cache,
    editGuard,
    history,
    sessions,
    output,
    () => tree.refresh(),
  );
  // M8-B2 表结构编辑（概要 §5.9）：编辑器 RPC + 删表/清空表树操作；成功后缓存失效联动树刷新
  const ddlService = new DdlService({
    connections,
    cache,
    output,
    refreshTree: () => tree.refresh(),
    timeoutMs: vscode.workspace.getConfiguration('dbExplorer').get('query.timeoutMs', 15_000),
  });

  await store.ensureSeed(MOCK_CONNECTION);

  context.subscriptions.push(
    registry,
    connections,
    output,
    sessions,
    treeView,
    consoleService,
    registerConsoleResultView(context, { connections, output, console: consoleService }),
    registerConsoleCompletion(context, consoleService),
    store.onDidChange(() => tree.refresh()),
    // 连接状态变化（建连/断开）→ 树刷新连接节点徽标（概要 §8.1）
    connections.onDidChangeStatus(() => tree.refresh()),
    // 交互式事务开始/结束 → 树刷新「事务进行中」徽标（§4.6）
    sessions.onDidChange(() => tree.refresh()),
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
        sshFingerprints,
        ddl: ddlService,
      },
      tree,
    ),
  );
}

export function deactivate(): void {
  // ConnectionManager / ConsoleService 随 context.subscriptions dispose，统一关闭连接池
}
