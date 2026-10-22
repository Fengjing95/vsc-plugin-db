import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import type { DriverRegistry } from '@db-explorer/core';
import type { ConnectionManager } from './services/connectionManager';
import type { ConsoleService } from './services/consoleService';
import { pickHistoryItem } from './services/consoleHistory';
import type { EditGuard, ViewStateStore } from './services/editGuard';
import { formatSql } from '@db-explorer/core';
import { pickSavedQuery, saveActiveQuery } from './services/savedQueryActions';
import { newQueryDefaultName, sanitizeQueryFileName } from './services/savedQueries';
import type { QueryFilesService } from './services/queryFiles';
import { CODEGEN_LANGUAGES, codegenLanguageId, generateCode, type CodegenLanguage } from './services/codegen';
import { secretRefOf, type ConnectionStore } from './services/connectionStore';
import type { ConnectionsTreeProvider, DbTreeNode } from './tree/treeDataProvider';
import type { DdlService } from './services/ddlService';
import { openConnectionForm } from './views/connectionFormPanel';
import { openTableDesignPanel } from './views/tableDesignPanel';
import { openDatabaseDesignPanel } from './views/dbDatabasePanel';
import { openErDiagramPanel } from './views/erDiagramPanel';
import { closeTablePanelsFor, openTablePanel } from './views/tablePanel';
import type { Logger } from './services/logger';

export interface AppServices {
  registry: DriverRegistry;
  store: ConnectionStore;
  connections: ConnectionManager;
  /** Host 日志门面（LogOutputChannel 分级打点；dbExplorer.showLog 聚焦面板） */
  logger: Logger;
  /** 查询统一入口（LoggingDriverHost 拦截日志，概要 §5.10） */
  host: import('@db-explorer/core').DriverHost;
  /** M4 表格编辑：变更集权威副本 + 视图状态快照 + 编辑护栏 */
  changesets: import('@db-explorer/core').ChangeSetService;
  viewStates: ViewStateStore;
  editGuard: EditGuard;
  /** M5 SQL Console */
  console: ConsoleService;
  /** M5 执行历史 */
  history: import('./services/consoleHistory').ConsoleHistory;
  /** M8 树查询目录：.vscode/db-queries/<connId>/<db>/*.sql 磁盘层 */
  queries: QueryFilesService;
  /** M7 SSH 隧道：主机指纹库（TOFU），连接表单与 ConnectionManager 共享 */
  sshFingerprints: import('./services/sshTunnel').FingerprintStore;
  /** M8-B2 表结构编辑（DDL）：编辑器 RPC + 删表/清空表树操作 */
  ddl: DdlService;
  /** M8-DBDDL 库级 DDL（D-19）：新建/编辑库面板 RPC + 删库树操作 */
  dbddl: import('./services/dbDdlService').DbDdlService;
  /** M8-ER ER 图（概要 §5.11 / D-22）：关系收集 + 分层布局（er.getGraph）+ 打开引导 */
  er: import('./services/erService').ErService;
  /** M9-AI AI 辅助（概要 §5.12 / D-24）：生成（NL→SQL）/ 解释 / 错误修复三能力 + 设置守卫 */
  ai: import('./services/aiAssistService').AiAssistService;
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

    // 打开日志（M8 优化）：聚焦输出面板 Database Explorer 频道（不自动弹出，仅显式入口）
    vscode.commands.registerCommand('dbExplorer.showLog', () => {
      services.logger.show();
    }),

    // M9-AI（D-24）：设置页 / 生成（CodeLens 传 [uri, position] 语句前插入；快捷键光标处）/
    // 解释（活动编辑器选区或光标语句 → Console「AI 解释」Tab 流式）
    vscode.commands.registerCommand('dbExplorer.ai.settings', () => {
      services.ai.openSettings();
    }),
    vscode.commands.registerCommand('dbExplorer.ai.generateSql', (uri?: vscode.Uri, position?: vscode.Position) => {
      void services.ai.generateSql(uri, position);
    }),
    vscode.commands.registerCommand('dbExplorer.ai.explainSql', () => {
      void services.ai.explainActiveSql();
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

    vscode.commands.registerCommand('dbExplorer.executeQuery', () => {
      void services.console.executeActiveEditor('cursor');
    }),

    // CodeLens「▶ 执行」（sqlCodeLens）：与 Ctrl+Enter 同一执行链，按 CodeLens 传入的位置定位语句
    vscode.commands.registerCommand('dbExplorer.executeQueryAt', (uri?: vscode.Uri, position?: vscode.Position) => {
      if (!uri || !position) {
        return; // 命令面板直接调用无参 → 无操作（入口在 CodeLens）
      }
      void services.console.executeStatementAt(uri, position);
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

    // 保存查询（概要 §5.5.2 P1）：活动 SQL 文档 → 查询目录（默认扩展全局存储）
    vscode.commands.registerCommand('dbExplorer.saveQuery', () => {
      void saveActiveQuery(services.console, services.queries);
    }),

    vscode.commands.registerCommand('dbExplorer.openSavedQuery', () => {
      void pickSavedQuery(services.queries);
    }),

    // 树「查询」目录（M8 优化：树上 Console 入口改为文件化查询管理）。
    // 查询 = <查询根>/<connId>/<db>/*.sql（默认扩展全局存储，不与工作区绑定，dbExplorer.queries.directory 可自定义）；
    // 新建用输入框（默认 query_<13位时间戳>），创建即绑定该连接/库（§7.1），打开后 Ctrl+Enter 直接执行
    vscode.commands.registerCommand('dbExplorer.queries.create', async (node?: DbTreeNode) => {
      const { connId, db } = node?.payload ?? {};
      if (node?.type !== 'queries' || !connId || !db) {
        return;
      }
      const name = await vscode.window.showInputBox({
        title: '新增查询',
        prompt: '查询名称（保存到查询目录 …/<名称>.sql，dbExplorer.queries.directory 可自定义位置）',
        placeHolder: '查询名称',
        value: newQueryDefaultName(),
        validateInput: async (v) => {
          const safe = sanitizeQueryFileName(v.replace(/\.sql$/i, ''));
          if (!safe) {
            return '名称无效';
          }
          try {
            await vscode.workspace.fs.stat(
              vscode.Uri.joinPath(services.queries.dirUri(connId, db), `${safe}.sql`),
            );
            return '同名查询已存在';
          } catch {
            return undefined;
          }
        },
      });
      if (name === undefined) {
        return; // 用户取消
      }
      const safe = sanitizeQueryFileName(name.replace(/\.sql$/i, '')) || newQueryDefaultName();
      const uri = await services.queries.create(connId, db, safe);
      tree.refreshElement(node);
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc, { preview: false });
      await services.console.ensureBinding(doc, { connId, db });
    }),

    // 「打开目录」：系统文件管理器定位查询目录（首次先落地目录）
    vscode.commands.registerCommand('dbExplorer.queries.openDir', async (node?: DbTreeNode) => {
      const { connId, db } = node?.payload ?? {};
      if (node?.type !== 'queries' || !connId || !db) {
        return;
      }
      const dir = await services.queries.ensureDir(connId, db);
      if (dir) {
        await vscode.commands.executeCommand('revealFileInOS', dir);
      }
    }),

    // 删除查询：Modal 确认（破坏性操作），进系统回收站可恢复；删除后根刷新重建列表
    vscode.commands.registerCommand('dbExplorer.queries.delete', async (node?: DbTreeNode) => {
      if (node?.type !== 'query' || !node.payload.file || !node.payload.connId || !node.payload.db) {
        return;
      }
      const uri = vscode.Uri.joinPath(
        services.queries.dirUri(node.payload.connId, node.payload.db),
        node.payload.file,
      );
      const confirmed = await vscode.window.showWarningMessage(
        `删除查询 "${node.label}"？（${uri.fsPath}）`,
        { modal: true },
        '删除',
      );
      if (confirmed !== '删除') {
        return;
      }
      await services.queries.delete(uri);
      tree.refresh();
    }),

    // 单击查询节点 = 打开 .sql 文件并绑定其所属连接/库（交互稿 §8.2 v0.1.15：目录即事实源）：
    // 查询文件位于 <connId>/<db> 目录，绑定以目录为准校正——文件被移动/复制或早期绑定残留时
    // 不再串到旧库执行；一致或未绑定时零交互静默建绑。元数据补全与 Ctrl+Enter 直接可用
    vscode.commands.registerCommand('dbExplorer.queries.open', async (node?: DbTreeNode) => {
      if (node?.type !== 'query' || !node.payload.file || !node.payload.connId || !node.payload.db) {
        return;
      }
      const uri = vscode.Uri.joinPath(
        services.queries.dirUri(node.payload.connId, node.payload.db),
        node.payload.file,
      );
      const doc = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(doc, { preview: true });
      const existing = services.console.bindingForDocument(editor.document);
      if (
        !existing ||
        existing.connId !== node.payload.connId ||
        (existing.db ?? null) !== (node.payload.db ?? null)
      ) {
        await services.console.bindDocument(editor.document, {
          connId: node.payload.connId,
          db: node.payload.db,
        });
      }
    }),

    // 重命名查询：输入框预填当前名并全选（直接输入即替换），重名/非法字符即时校验；
    // 文件经 WorkspaceEdit.renameFile 迁移（打开中的编辑器标签自动跟随，对齐资源管理器语义；
    // applyEdit 失败回落 fs.rename），绑定随 fsPath 迁移——新路径补全/执行立即可用
    vscode.commands.registerCommand('dbExplorer.queries.rename', async (node?: DbTreeNode) => {
      if (node?.type !== 'query' || !node.payload.file || !node.payload.connId || !node.payload.db) {
        return;
      }
      const { connId, db, file } = node.payload;
      const dir = services.queries.dirUri(connId, db);
      const oldUri = vscode.Uri.joinPath(dir, file);
      const current = file.replace(/\.sql$/i, '');
      const name = await vscode.window.showInputBox({
        title: '重命名查询',
        prompt: '新的查询名称（保存到查询目录 …/<名称>.sql，dbExplorer.queries.directory 可自定义位置）',
        value: current,
        valueSelection: [0, current.length],
        validateInput: async (v) => {
          const safe = sanitizeQueryFileName(v.replace(/\.sql$/i, ''));
          if (!safe) {
            return '名称无效';
          }
          if (safe === current) {
            return undefined;
          }
          try {
            await vscode.workspace.fs.stat(vscode.Uri.joinPath(dir, `${safe}.sql`));
            return '同名查询已存在';
          } catch {
            return undefined;
          }
        },
      });
      if (name === undefined) {
        return; // 用户取消
      }
      const safe = sanitizeQueryFileName(name.replace(/\.sql$/i, ''));
      if (!safe || safe === current) {
        return;
      }
      const newUri = vscode.Uri.joinPath(dir, `${safe}.sql`);
      const edit = new vscode.WorkspaceEdit();
      edit.renameFile(oldUri, newUri, { overwrite: false });
      const applied = await vscode.workspace.applyEdit(edit);
      if (!applied) {
        try {
          await vscode.workspace.fs.rename(oldUri, newUri, { overwrite: false });
        } catch (err) {
          void vscode.window.showErrorMessage(
            `重命名失败：${err instanceof Error ? err.message : String(err)}（同名查询已存在？）`,
          );
          return;
        }
      }
      await services.console.renameFileBinding(oldUri.fsPath, newUri.fsPath);
      tree.refresh();
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

    // 由表结构生成代码（概要 §6 #7）：树右键 table/view → 选语言 → 打开只读草稿文档
    vscode.commands.registerCommand('dbExplorer.generateCode', async (node?: DbTreeNode) => {
      const { connId, db, obj } = node?.payload ?? {};
      if (!connId || !db || !obj) {
        return;
      }
      const picked = await vscode.window.showQuickPick(CODEGEN_LANGUAGES, {
        title: `由表结构生成代码：${obj}`,
        placeHolder: '选择目标语言',
      });
      if (!picked) {
        return;
      }
      try {
        const conn = await connections.ensureConnected(connId);
        const columns = await conn.listColumns(db, obj);
        if (columns.length === 0) {
          void vscode.window.showInformationMessage(`表 "${obj}" 没有可用的列元数据。`);
          return;
        }
        const code = generateCode(picked.value as CodegenLanguage, obj, columns);
        const doc = await vscode.workspace.openTextDocument({
          content: `${code}\n`,
          language: codegenLanguageId(picked.value as CodegenLanguage),
        });
        await vscode.window.showTextDocument(doc, { preview: true });
        copy(code, `${picked.label}`);
      } catch (err) {
        void vscode.window.showErrorMessage(
          `生成代码失败：${err instanceof Error ? err.message : String(err)}`,
        );
      }
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

    // ── M8-B2 表结构编辑（概要 §5.9 / 交互稿 §12；入口仅右键菜单，§8.2）──

    vscode.commands.registerCommand('dbExplorer.createTable', (node?: DbTreeNode) => {
      const { connId, db } = node?.payload ?? {};
      if (!connId || !db) {
        void vscode.window.showInformationMessage('请先连接并在具体库上新建表。');
        return;
      }
      openTableDesignPanel(context, services, { connId, db });
    }),

    vscode.commands.registerCommand('dbExplorer.alterTable', (node?: DbTreeNode) => {
      const { connId, db, obj } = node?.payload ?? {};
      if (!connId || !db || !obj) {
        return;
      }
      openTableDesignPanel(context, services, { connId, db, obj });
    }),

    // ── M8-ER ER 图查看（概要 §5.11 / D-22 / 交互稿 §13；入口仅右键菜单，按能力令牌裁剪）──

    vscode.commands.registerCommand('dbExplorer.showErDiagram', async (node?: DbTreeNode) => {
      const { connId, db } = node?.payload ?? {};
      if (!connId || !db) {
        return;
      }
      if (services.connections.getDriver(connId)?.capabilities.supportsErDiagram !== true) {
        void vscode.window.showInformationMessage('当前数据库类型不支持 ER 图。');
        return;
      }
      try {
        const scope = await services.er.prepareOpen(connId, db);
        if (!scope) {
          return; // 用户取消选择（Esc / 空选集），无副作用
        }
        openErDiagramPanel(
          context,
          {
            er: services.er,
            logger: services.logger,
            openTable: async ({ connId: cid, db: d, table }) => {
              await openTablePanel(context, services, {
                connId: cid,
                db: d,
                obj: table,
                viewId: `${cid}/${d}/${table}`,
                title: `${table} @ ${d}`,
                readOnly: store.get(cid)?.readOnly ?? false,
                env: store.get(cid)?.env ?? null,
              });
            },
          },
          { connId, db, scope },
        );
      } catch (err) {
        void vscode.window.showErrorMessage(
          `打开 ER 图失败：${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }),

    // ── M8-DBDDL 库级 DDL（概要 D-19 / 交互稿 §8.3；入口仅右键菜单，按驱动方法存在性裁剪）──

    vscode.commands.registerCommand('dbExplorer.createDatabase', (node?: DbTreeNode) => {
      const { connId } = node?.payload ?? {};
      if (!connId) {
        return;
      }
      const driver = connections.getDriver(connId);
      if (!driver || typeof driver.buildCreateDatabase !== 'function') {
        void vscode.window.showInformationMessage('当前驱动不支持新建库。');
        return;
      }
      openDatabaseDesignPanel(context, services, { connId, kind: 'create' });
    }),

    vscode.commands.registerCommand('dbExplorer.alterDatabase', (node?: DbTreeNode) => {
      const { connId, db } = node?.payload ?? {};
      if (!connId || !db) {
        return;
      }
      const driver = connections.getDriver(connId);
      if (!driver || typeof driver.buildAlterDatabase !== 'function') {
        void vscode.window.showInformationMessage('当前驱动不支持编辑库。');
        return;
      }
      openDatabaseDesignPanel(context, services, { connId, db, kind: 'alter' });
    }),

    vscode.commands.registerCommand('dbExplorer.dropDatabase', async (node?: DbTreeNode) => {
      const { connId, db } = node?.payload ?? {};
      if (!connId || !db) {
        return;
      }
      try {
        await services.dbddl.dropDatabase(connId, db);
      } catch (err) {
        void vscode.window.showErrorMessage(
          `删除库失败：${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }),

    vscode.commands.registerCommand('dbExplorer.dropTable', async (node?: DbTreeNode) => {
      const { connId, db, obj } = node?.payload ?? {};
      if (!connId || !db || !obj) {
        return;
      }
      try {
        await services.ddl.dropTable(connId, db, obj);
      } catch (err) {
        void vscode.window.showErrorMessage(
          `删除表失败：${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }),

    // 列操作（M8-B2 交互稿 §12 修订）：新增/编辑列复用表结构编辑器（focus 到指定列）；删除列确认后直删
    vscode.commands.registerCommand('dbExplorer.addColumn', (node?: DbTreeNode) => {
      const { connId, db, obj } = node?.payload ?? {};
      if (!connId || !db || !obj) {
        void vscode.window.showInformationMessage('请先在具体表上新增列。');
        return;
      }
      // 表目录（obj 为表）或列节点（payload 同时带 obj 与 column）均可：都追加空列
      openTableDesignPanel(context, services, { connId, db, obj, appendColumn: true });
    }),

    vscode.commands.registerCommand('dbExplorer.editColumn', (node?: DbTreeNode) => {
      const { connId, db, obj, column } = node?.payload ?? {};
      if (!connId || !db || !obj || !column) {
        return;
      }
      openTableDesignPanel(context, services, { connId, db, obj, focusColumn: column });
    }),

    vscode.commands.registerCommand('dbExplorer.dropColumn', async (node?: DbTreeNode) => {
      const { connId, db, obj, column } = node?.payload ?? {};
      if (!connId || !db || !obj || !column) {
        return;
      }
      try {
        await services.ddl.dropColumn(connId, db, obj, column);
      } catch (err) {
        void vscode.window.showErrorMessage(
          `删除列失败：${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }),
  ];
}
