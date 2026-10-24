import * as vscode from 'vscode';
import { isAbsolute, join } from 'node:path';
import { ChangeSetService, DriverRegistry, InProcessDriverHost, MetadataCache } from '@db-explorer/core';
import { createMockDriver } from '@db-explorer/driver-mock';
import { createMongoDriver } from '@db-explorer/driver-mongo';
import { createMssqlDriver } from '@db-explorer/driver-mssql';
import { createMysqlDriver } from '@db-explorer/driver-mysql';
import { createOracleDriver } from '@db-explorer/driver-oracle';
import { createPostgresDriver } from '@db-explorer/driver-postgres';
import { createRedisDriver } from '@db-explorer/driver-redis';
import { createSqliteDriver } from '@db-explorer/driver-sqlite';
import { registerCommands } from './commands';
import { ConnectionManager } from './services/connectionManager';
import { ConnectionStore } from './services/connectionStore';
import { ConsoleHistory } from './services/consoleHistory';
import { ConsoleService } from './services/consoleService';
import { DdlService } from './services/ddlService';
import { DbDdlService } from './services/dbDdlService';
import { ErService } from './services/erService';
import { registerConsoleCompletion } from './services/consoleCompletion';
import { registerSqlCodeLens } from './services/sqlCodeLens';
import { createExecutionAnnotations } from './services/sqlExecutionDecorations';
import { EditGuard, ViewStateStore } from './services/editGuard';
import { Logger } from './services/logger';
import { LoggingDriverHost } from './services/loggingDriverHost';
import { QueryFilesService } from './services/queryFiles';
import { GlobalStateFingerprintStore } from './services/sshTunnel';
import { SessionManager } from './services/sessionManager';
import { registerConsoleResultView } from './views/consolePanel';
import { openAiSettingsPanel } from './views/aiSettingsPanel';
import { AiSettingsStore } from './services/aiSettings';
import { AiAssistService } from './services/aiAssistService';
import { ConnectionsTreeProvider } from './tree/treeDataProvider';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const registry = new DriverRegistry();
  // mock：契约测试/DoD 基准驱动（capabilities.internal=true）——不暴露类型选择、不再种子示例连接；
  // 保留注册使历史 mock 连接（globalState 已存）仍可打开
  registry.register(createMockDriver());
  registry.register(createMysqlDriver());
  // M8-PG PostgreSQL 驱动：仅注册（可插拔验收），树/取数/Console/DDL 路径零核心改动（D-15）
  registry.register(createPostgresDriver());
  // M6 Redis 驱动：仅注册（可插拔验收），树/取数/命令控制台路径零核心改动
  registry.register(createRedisDriver());
  // M8-SQLite SQLite 驱动：仅注册（可插拔验收），树/取数/Console/DDL 路径零核心改动（D-16）。
  // sql.js wasm 构建期拷至 media/（esbuild.mjs），运行时经 locateFile 定位；
  // 相对路径解析到首个工作区根（~/ 展开由驱动侧完成）
  const firstWorkspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  registry.register(
    createSqliteDriver({
      wasmPath: join(context.extensionPath, 'media', 'sql-wasm.wasm'),
      resolvePath: (p) => (isAbsolute(p) || !firstWorkspaceRoot ? p : join(firstWorkspaceRoot, p)),
    }),
  );
  // M8-Mongo MongoDB 驱动：仅注册（可插拔验收），树/取数/命令控制台路径零核心改动（D-17，
  // 只读浏览 + mongosh 命令控制台；collection 字段目录经 hierarchy 含 column 声明展开）
  registry.register(createMongoDriver());
  // M8-MSSQL SQL Server 驱动：仅注册（可插拔验收），树/取数/Console/DDL 路径零核心改动
  // （ADR D-21：D-15 同构——树上「库」= schema，db 参数 = schema 名；mssql/tedious 纯 JS）
  registry.register(createMssqlDriver());
  // M8-Oracle Oracle 驱动：仅注册（可插拔验收），树/取数/Console/DDL 路径零核心改动
  // （ADR D-23：D-15/D-21 同构——连接绑定 PDB（service 寻址），树上「库」= schema；
  // node-oracledb thin 纯 JS；esbuild external + 构建期闭包物化（P-32/35 同族））
  registry.register(createOracleDriver());

  // M8 优化：LogOutputChannel（原生 info/warn/error/debug 分级 + 自动时间戳 + 面板级别过滤），
  // 各服务经 logger 门面打点（不直接持有 channel）；dbExplorer.showLog 聚焦面板
  const output = vscode.window.createOutputChannel('Database Explorer', { log: true });
  const logger = new Logger(output);
  const store = new ConnectionStore(context.globalState, context.secrets);
  // SSH 主机指纹库（TOFU，globalState 持久化）：ConnectionManager 与连接表单共享同一实例
  const sshFingerprints = new GlobalStateFingerprintStore(context.globalState);
  const connections = new ConnectionManager(registry, store, sshFingerprints, logger);
  // 查询统一入口（§5.10 拦截）：DriverHost 装饰器——fetchRows/query/applyChanges 全量 info、
  // previewChanges debug；connId 由懒连接缓存回查。表格取数/编辑提交/导出/Console/DDL 全走此实例
  const queryHost = new LoggingDriverHost(
    new InProcessDriverHost(
      vscode.workspace.getConfiguration('dbExplorer').get('query.timeoutMs', 15_000),
    ),
    logger,
    (conn) => connections.connIdOf(conn),
  );
  const cache = new MetadataCache();
  // M4 表格编辑：ChangeSet 权威副本（ADR D-06）+ 视图状态快照 + 编辑护栏（§5.8 / D-03）
  const changesets = new ChangeSetService();
  const viewStates = new ViewStateStore();
  const editGuard = new EditGuard(connections, cache, logger);
  // M7 交互式事务（§4.6/D-09）：空闲超时自动回滚（默认 5min，可配置）；树徽标经 onDidChange 联动
  const sessions = new SessionManager(
    connections,
    () => vscode.workspace.getConfiguration('dbExplorer').get('transaction.idleTimeoutMs', 300_000),
    (message) => void vscode.window.showWarningMessage(message),
    logger,
  );
  // 树查询目录磁盘层（M8 优化）：数据库下级「查询」目录管理 <查询根>/<connId>/<db>/*.sql；
  // 查询根默认扩展全局存储（不与工作区绑定），dbExplorer.queries.directory 可指向任意磁盘目录
  const queryFiles = new QueryFilesService(context.globalStorageUri);
  const tree = new ConnectionsTreeProvider(connections, cache, sessions, context.extensionUri, queryFiles);
  const treeView = vscode.window.createTreeView('dbExplorer.connections', {
    treeDataProvider: tree,
    showCollapseAll: true,
  });
  // 断开连接后收起节点（reveal 需要视图句柄与当前元素引用）
  tree.attachView(treeView);
  // M5 SQL Console：绑定/执行链/结果面板/历史（概要设计 §5.5）
  const history = new ConsoleHistory(context.workspaceState, connections);
  // 行内执行结果注记（语句行尾耗时/错误 + gutter 图标，装饰器渲染不入文件）
  const executionAnnotations = createExecutionAnnotations();
  const consoleService = new ConsoleService(
    context,
    connections,
    cache,
    editGuard,
    history,
    sessions,
    queryHost,
    logger,
    () => tree.refresh(),
    executionAnnotations,
  );
  // M8-B2 表结构编辑（概要 §5.9）：编辑器 RPC + 删表/清空表树操作；成功后缓存失效联动树刷新
  const ddlService = new DdlService({
    connections,
    cache,
    logger,
    host: queryHost,
    refreshTree: () => tree.refresh(),
    timeoutMs: vscode.workspace.getConfiguration('dbExplorer').get('query.timeoutMs', 15_000),
  });
  // M8-DBDDL 库级 DDL（概要 D-19 / 交互稿 §8.3）：新建/编辑库面板 RPC + 删库树操作；
  // 成功后 invalidateConnection（库列表变更）+ 树刷新
  const dbDdlService = new DbDdlService({
    connections,
    cache,
    logger,
    host: queryHost,
    refreshTree: () => tree.refresh(),
    timeoutMs: vscode.workspace.getConfiguration('dbExplorer').get('query.timeoutMs', 15_000),
  });
  // M8-ER ER 图（概要 §5.11 / D-22）：关系收集 + 分层布局（Host 计算）+ 打开引导；
  // 元数据自省经缓存（§7.5），不经 DriverHost（无查询语句）
  const erService = new ErService({ connections, cache, logger });
  // M9-AI AI 辅助（概要 §5.12 / D-24）：BYOK 设置（endpoint/model 落 settings、key 进
  // SecretStorage）+ 三能力（生成直插 / 解释流式 Tab / 错误修复 diff 确认）；护栏零改动
  const aiSettings = new AiSettingsStore(context.secrets, logger);
  const aiAssist = new AiAssistService(connections, consoleService, aiSettings, logger, () =>
    openAiSettingsPanel(context, { settings: aiSettings, logger }),
  );

  context.subscriptions.push(
    registry,
    connections,
    output,
    sessions,
    treeView,
    consoleService,
    executionAnnotations,
    registerConsoleResultView(context, {
      connections,
      logger,
      host: queryHost,
      console: consoleService,
      ai: aiAssist,
    }),
    registerConsoleCompletion(consoleService),
    // SQL CodeLens「▶ 执行」+「✨ 生成 SQL」（光标跟随）+「✨ 修复建议」（失败语句）+「保留/放弃」（内联预览）
    registerSqlCodeLens(executionAnnotations, aiAssist),
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
        logger,
        host: queryHost,
        changesets,
        viewStates,
        editGuard,
        console: consoleService,
        history,
        queries: queryFiles,
        sshFingerprints,
        ddl: ddlService,
        dbddl: dbDdlService,
        er: erService,
        ai: aiAssist,
      },
      tree,
    ),
  );
}

export function deactivate(): void {
  // ConnectionManager / ConsoleService 随 context.subscriptions dispose，统一关闭连接池
}
