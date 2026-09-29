import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { InProcessDriverHost } from '@db-explorer/core';
import { attachRpcHost } from '../rpc/rpcHost';
import type { ConnectionManager } from '../services/connectionManager';

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

  panel.webview.html = buildHtml(panel.webview, context.extensionUri, target);

  const output = vscode.window.createOutputChannel('Database Explorer');
  context.subscriptions.push(output);
  attachRpcHost(panel.webview, {
    viewId: target.viewId,
    params: { connId: target.connId, db: target.db, obj: target.obj },
    connections,
    host: new InProcessDriverHost(),
    output,
  });
}

function webviewDistRoot(extensionUri: vscode.Uri): string {
  return path.join(extensionUri.fsPath, '..', 'webview-ui', 'dist');
}

function getNonce(): string {
  let text = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}

function buildHtml(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  target: TableTarget,
): string {
  const root = webviewDistRoot(extensionUri);
  const htmlPath = path.join(root, 'index.html');
  if (!fs.existsSync(htmlPath)) {
    return `<!doctype html><html><body style="font-family: sans-serif; padding: 24px">
      <h3>未找到 Webview 构建产物</h3>
      <p>请先在仓库根目录执行 <code>pnpm build</code>（会先构建 webview-ui 再打包扩展）。</p>
    </body></html>`;
  }

  const nonce = getNonce();
  const csp = webview.cspSource;
  const raw = fs.readFileSync(htmlPath, 'utf8');

  // base:'./' 的产物资源引用改写为 webview 可达 URI，并注入 CSP 与引导数据
  const html = raw
    .replace(
      /(src|href)="\.?\/(.*?)"/g,
      (_m, attr: string, file: string) =>
        `${attr}="${webview.asWebviewUri(vscode.Uri.file(path.join(root, file)))}"`,
    )
    .replace(
      '<head>',
      `<head>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${csp} 'unsafe-inline'; img-src ${csp} data:; script-src 'nonce-${nonce}'; font-src ${csp};">
<script nonce="${nonce}">window.__BOOTSTRAP__ = ${JSON.stringify({
        viewId: target.viewId,
        params: { connId: target.connId, db: target.db, obj: target.obj },
      })};</script>`,
    );

  return html;
}
