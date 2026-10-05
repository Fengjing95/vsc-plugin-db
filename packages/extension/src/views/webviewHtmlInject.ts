/**
 * Webview HTML 注入（纯函数，零 vscode 依赖，可单测）：
 * 1. 相对资源引用 → webview URI（base:'./' 产物）
 * 2. 为外部 <script> 注入 nonce —— CSP 用 `script-src 'nonce-…'` 时，
 *    外部脚本同样必须携带 nonce，否则被静默拦截（页面全白的根因）
 * 3. 注入 CSP 与引导数据（__BOOTSTRAP__）
 */
export type WebviewPage = 'table' | 'connectionForm' | 'console' | 'tableDesign';

export interface WebviewBootstrap {
  page: WebviewPage;
  viewId: string;
  params: Record<string, string>;
}

function getNonce(): string {
  let text = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}

export function injectWebviewHtml(
  raw: string,
  toUri: (relPath: string) => string,
  cspSource: string,
  boot: WebviewBootstrap,
): string {
  const nonce = getNonce();
  return raw
    .replace(
      /(src|href)="\.?\/(.*?)"/g,
      (_m, attr: string, file: string) => `${attr}="${toUri(file)}"`,
    )
    .replace(
      /<script(?![^>]*\bnonce=)([^>]*?)>/g,
      (_m, attrs: string) => `<script nonce="${nonce}"${attrs}>`,
    )
    .replace(
      '<head>',
      `<head>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; img-src ${cspSource} data:; script-src 'nonce-${nonce}'; font-src ${cspSource};">
<script nonce="${nonce}">window.__BOOTSTRAP__ = ${JSON.stringify(boot)};</script>`,
    );
}
