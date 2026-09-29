import * as vscode from 'vscode';
import { InProcessDriverHost } from '@db-explorer/core';
import { attachRpcHost } from '../rpc/rpcHost';
import type { ConnectionManager } from '../services/connectionManager';
import { buildWebviewHtml, webviewDistRoot } from './webviewHtml';

export interface TableTarget {
  connId: string;
  db: string;
  obj: string;
  viewId: string;
  title: string;
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
    params: { connId: target.connId, db: target.db, obj: target.obj },
  });

  attachRpcHost(panel.webview, {
    viewId: target.viewId,
    params: { connId: target.connId, db: target.db, obj: target.obj },
    connections,
    host: new InProcessDriverHost(),
    output,
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
