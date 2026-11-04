import * as vscode from 'vscode';
import { type ChangeSetService, type DriverHost } from '@db-explorer/core';
import { RpcMethods } from '@db-explorer/protocol';
import { attachRpcHost } from '../rpc/rpcHost';
import type { AiAssistService } from '../services/aiAssistService';
import type { ConnectionManager } from '../services/connectionManager';
import type { EditGuard, ViewStateStore } from '../services/editGuard';
import { t } from '../services/i18n';
import type { Logger } from '../services/logger';
import { createResultExporter } from '../services/resultExporter';
import { createImporter } from '../services/resultImporter';
import { buildWebviewHtml, webviewDistRoot } from './webviewHtml';

export interface TableTarget {
  connId: string;
  db: string;
  obj: string;
  viewId: string;
  title: string;
  /** 行估算（元数据可得时），分页栏显示“约 N 行”（交互稿 §4.7） */
  rowEstimate?: number;
  /** 只读连接徽标 */
  readOnly?: boolean;
  /** 环境标识（预览 Modal 环境条 / prod DangerGuard 提示） */
  env?: 'dev' | 'test' | 'prod' | null;
  /** v0.12.0（§5.13 / D-32）：打开即直开导入映射 Dialog 的文件路径（树「导入数据」命令链路，
   *  绕开无法自动化的原生 OpenDialog——e2e/自动化入口，P-82 同款口子） */
  importFile?: string;
}

export interface TablePanelServices {
  connections: ConnectionManager;
  logger: Logger;
  /** 查询统一入口（LoggingDriverHost，extension 组装注入） */
  host: DriverHost;
  /** ChangeSet 权威副本（ADR D-06，进程级单例） */
  changesets: ChangeSetService;
  viewStates: ViewStateStore;
  editGuard: EditGuard;
  /** 列元数据缓存（§7.5，导入映射建议的类型依据） */
  cache: import('@db-explorer/core').MetadataCache;
  /** AI P2A 批次 A1（交互稿 §15.7 转正）：筛选栏「✨ 自然语言筛选」→ ai.generateFilter（片段回填待确认） */
  ai?: Pick<AiAssistService, 'generateFilterWhere' | 'openSettings'>;
}

const panels = new Map<string, vscode.WebviewPanel>();
/** 重新打开视图时复用的激活上下文（openTablePanel 首次调用时记录） */
let panelContext: vscode.ExtensionContext | undefined;

export async function openTablePanel(
  context: vscode.ExtensionContext,
  services: TablePanelServices,
  target: TableTarget,
): Promise<void> {
  panelContext = context;
  const existing = panels.get(target.viewId);
  if (existing) {
    void existing.reveal();
    return;
  }

  const panel = vscode.window.createWebviewPanel(
    'dbExplorer.table',
    target.title,
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.file(webviewDistRoot(context.extensionUri))],
    },
  );
  panels.set(target.viewId, panel);
  panel.onDidDispose(
    () => {
      panels.delete(target.viewId);
      warnUncommittedChanges(services, target);
    },
    null,
    context.subscriptions,
  );

  panel.webview.html = buildWebviewHtml(panel.webview, context.extensionUri, {
    page: 'table',
    viewId: target.viewId,
    params: {
      connId: target.connId,
      db: target.db,
      obj: target.obj,
      rowEstimate: target.rowEstimate !== undefined ? String(target.rowEstimate) : '',
      readOnly: target.readOnly ? 'true' : 'false',
      importFile: target.importFile ?? '',
    },
  });

  const cfg = vscode.workspace.getConfiguration('dbExplorer');
  const ai = services.ai;
  attachRpcHost(panel.webview, {
    viewId: target.viewId,
    params: {
      connId: target.connId,
      db: target.db,
      obj: target.obj,
      env: target.env ?? '',
    },
    connections: services.connections,
    host: services.host,
    logger: services.logger,
    changesets: services.changesets,
    viewStates: services.viewStates,
    editGuard: services.editGuard,
    applyTimeoutMs: Math.max(cfg.get('query.timeoutMs', 15000), 30_000),
    exporter: createResultExporter({
      webview: panel.webview,
      connections: services.connections,
      host: services.host,
      logger: services.logger,
      chunkRows: cfg.get('export.chunkRows', 1000),
      timeoutMs: cfg.get('query.timeoutMs', 15000),
    }),
    importer: createImporter({
      webview: panel.webview,
      connections: services.connections,
      host: services.host,
      cache: services.cache,
      editGuard: services.editGuard,
      logger: services.logger,
      batchRows: 500,
      timeoutMs: Math.max(cfg.get('query.timeoutMs', 15000), 30_000),
      objLabel: target.obj,
    }),
    handlers: ai
      ? {
          // 片段只回填筛选栏（Webview 侧），不直接执行——应用走既有 whereSql 下推链
          [RpcMethods.aiGenerateFilter]: (raw) => ai.generateFilterWhere(raw),
          [RpcMethods.aiOpenSettings]: () => {
            ai.openSettings();
            return Promise.resolve({});
          },
        }
      : undefined,
  });
}

/** 关闭视图且存在未提交变更 → 提醒防误关（概要设计 §5.4.5）；默认保留快照，重开视图可回放 */
function warnUncommittedChanges(services: TablePanelServices, target: TableTarget): void {
  const counts = services.changesets.counts(target.viewId);
  const total = counts.inserts + counts.updates + counts.deletes;
  if (total === 0) {
    services.changesets.disposeView(target.viewId);
    services.viewStates.disposeView(target.viewId);
    return;
  }
  const discardChanges = t('放弃变更');
  const reopen = t('重新打开');
  void vscode.window
    .showWarningMessage(
      t('表 "{0}" 有 {1} 条未提交变更。关闭后修改仍保留，重新打开该表可继续提交。', [target.obj, total]),
      discardChanges,
      reopen,
    )
    .then((action) => {
      if (action === discardChanges) {
        services.changesets.disposeView(target.viewId);
        services.viewStates.disposeView(target.viewId);
      } else if (action === reopen && panelContext) {
        void openTablePanel(panelContext, services, target);
      }
    });
}

/** 连接被删除/编辑后关闭其打开的表格视图 */
export function closeTablePanelsFor(connId: string): void {
  for (const [viewId, panel] of [...panels]) {
    if (viewId.startsWith(`${connId}/`)) {
      panel.dispose();
    }
  }
}

/** 按视图关闭单个表格面板（v0.12.0 / D-32：导入命令对已打开面板重开以生效 importFile 引导参数） */
export function closeTablePanel(viewId: string): void {
  panels.get(viewId)?.dispose();
}
