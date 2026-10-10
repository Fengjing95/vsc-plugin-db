import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { injectWebviewHtml } from './webviewHtmlInject';

export type { WebviewBootstrap, WebviewPage } from './webviewHtmlInject';

export function webviewDistRoot(extensionUri: vscode.Uri): string {
  // VSIX 安装形态（发布）：产物随扩展包分发——esbuild 构建期把 webview-ui/dist 拷到
  // dist/webview（兄弟目录 ../webview-ui 在安装机上不存在，直读会全部渲染错误页）
  const bundled = path.join(extensionUri.fsPath, 'dist', 'webview');
  if (fs.existsSync(path.join(bundled, 'index.html'))) {
    return bundled;
  }
  // monorepo 开发形态（F5）兜底：直读兄弟包产物（webview 独立构建后 extension 未重打包也可用）
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
