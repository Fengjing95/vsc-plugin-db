import * as vscode from 'vscode';
import { InProcessDriverHost } from '@db-explorer/core';
import { attachRpcHost } from '../rpc/rpcHost';
import type { ConnectionManager } from '../services/connectionManager';
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
}

const panels = new Map<string, vscode.WebviewPanel>();

export async function openTablePanel(
  context: vscode.ExtensionContext,
  connections: ConnectionManager,
  output: vscode.OutputChannel,
  target: TableTarget,
): Promise<void> {
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
    params: { connId: target.connId, db: target.db, obj: target.obj },
    connections,
    host: new InProcessDriverHost(cfg.get('query.timeoutMs', 15000)),
    output,
    exporter: new ResultExporter({
      webview: panel.webview,
      connections,
      host: new InProcessDriverHost(cfg.get('query.timeoutMs', 15000)),
      output,
      chunkRows: cfg.get('export.chunkRows', 1000),
      timeoutMs: cfg.get('query.timeoutMs', 15000),
    }),
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
