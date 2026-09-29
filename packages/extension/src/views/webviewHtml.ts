import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';

export type WebviewPage = 'table' | 'connectionForm';

export interface WebviewBootstrap {
  page: WebviewPage;
  viewId: string;
  params: Record<string, string>;
}

export function webviewDistRoot(extensionUri: vscode.Uri): string {
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

/** 读取 webview-ui 构建产物，改写资源 URI、注入 CSP 与引导数据（CSP 收紧到 default-src 'none'，D-01） */
export function buildWebviewHtml(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  boot: WebviewBootstrap,
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

  return raw
    .replace(
      /(src|href)="\.?\/(.*?)"/g,
      (_m, attr: string, file: string) =>
        `${attr}="${webview.asWebviewUri(vscode.Uri.file(path.join(root, file)))}"`,
    )
    .replace(
      '<head>',
      `<head>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${csp} 'unsafe-inline'; img-src ${csp} data:; script-src 'nonce-${nonce}'; font-src ${csp};">
<script nonce="${nonce}">window.__BOOTSTRAP__ = ${JSON.stringify(boot)};</script>`,
    );
}
