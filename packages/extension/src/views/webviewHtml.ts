import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { injectWebviewHtml } from './webviewHtmlInject';

export type { WebviewBootstrap, WebviewPage } from './webviewHtmlInject';

export function webviewDistRoot(extensionUri: vscode.Uri): string {
  return path.join(extensionUri.fsPath, '..', 'webview-ui', 'dist');
}

/** 读取 webview-ui 构建产物并完成注入；产物缺失时返回可读的错误页 */
export function buildWebviewHtml(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  boot: import('./webviewHtmlInject').WebviewBootstrap,
): string {
  const root = webviewDistRoot(extensionUri);
  const htmlPath = path.join(root, 'index.html');
  if (!fs.existsSync(htmlPath)) {
    return `<!doctype html><html><body style="font-family: sans-serif; padding: 24px">
      <h3>未找到 Webview 构建产物</h3>
      <p>请先在仓库根目录执行 <code>pnpm build</code>（会先构建 webview-ui 再打包扩展）。</p>
    </body></html>`;
  }
  const raw = fs.readFileSync(htmlPath, 'utf8');
  return injectWebviewHtml(
    raw,
    (rel) => String(webview.asWebviewUri(vscode.Uri.file(path.join(root, rel)))),
    webview.cspSource,
    boot,
  );
}
