import * as vscode from 'vscode';
import { InProcessDriverHost, type ChangeSetService } from '@db-explorer/core';
import { attachRpcHost } from '../rpc/rpcHost';
import type { ConnectionManager } from '../services/connectionManager';
import type { EditGuard, ViewStateStore } from '../services/editGuard';
import { ResultExporter } from '../services/resultExporter';
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
}

export interface TablePanelServices {
  connections: ConnectionManager;
  output: vscode.OutputChannel;
  /** ChangeSet 权威副本（ADR D-06，进程级单例） */
  changesets: ChangeSetService;
  viewStates: ViewStateStore;
  editGuard: EditGuard;
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
    },
  });

  const cfg = vscode.workspace.getConfiguration('dbExplorer');
  attachRpcHost(panel.webview, {
    viewId: target.viewId,
    params: {
      connId: target.connId,
      db: target.db,
      obj: target.obj,
      env: target.env ?? '',
    },
    connections: services.connections,
    host: new InProcessDriverHost(cfg.get('query.timeoutMs', 15000)),
    output: services.output,
    changesets: services.changesets,
    viewStates: services.viewStates,
    editGuard: services.editGuard,
    applyTimeoutMs: Math.max(cfg.get('query.timeoutMs', 15000), 30_000),
    exporter: new ResultExporter({
      webview: panel.webview,
      connections: services.connections,
      host: new InProcessDriverHost(cfg.get('query.timeoutMs', 15000)),
      output: services.output,
      chunkRows: cfg.get('export.chunkRows', 1000),
      timeoutMs: cfg.get('query.timeoutMs', 15000),
    }),
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
  void vscode.window
    .showWarningMessage(
      `表 "${target.obj}" 有 ${total} 条未提交变更。关闭后修改仍保留，重新打开该表可继续提交。`,
      '放弃变更',
      '重新打开',
    )
    .then((action) => {
      if (action === '放弃变更') {
        services.changesets.disposeView(target.viewId);
        services.viewStates.disposeView(target.viewId);
      } else if (action === '重新打开' && panelContext) {
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
