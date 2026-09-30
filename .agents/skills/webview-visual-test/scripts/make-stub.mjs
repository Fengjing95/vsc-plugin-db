#!/usr/bin/env node
/**
 * webview 无宿主可视化预览：构建产物 + stub 页一键起本地服务。
 *
 * 用法（仓库根目录）：
 *   node .agents/skills/webview-visual-test/scripts/make-stub.mjs [handlersFile] [--port 8931] [--dist packages/webview-ui/dist]
 *
 * handlersFile 为浏览器侧 JS（非 node 模块），内容形如：
 *   window.__DBX_STUB__ = {
 *     delayMs: 60,
 *     bootstrap: { page: 'table', viewId: 'v', params: { connId: 'c1', db: 'demo', obj: 'users', env: 'test' } },
 *     handlers: { 'table.fetchRows': (p) => ({ columns: [...], rows: [...], rowCount: 0, executionMs: 1 }) },
 *   };
 * 省略 handlersFile 时使用表格页默认场景（见 handlers.example.js）。
 */
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

// ── 参数 ──────────────────────────────────────────────────────
const args = process.argv.slice(2);
const positional = [];
const opts = { port: 8931, dist: 'packages/webview-ui/dist', out: join(tmpdir(), 'dbx-webview-preview') };
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--port') opts.port = Number(args[++i]);
  else if (args[i] === '--dist') opts.dist = args[++i];
  else positional.push(args[i]);
}
const handlersFile = positional[0];
const repoRoot = process.cwd();
const distDir = resolve(repoRoot, opts.dist);
const outDir = opts.out;

const handlersJs = handlersFile
  ? readFileSync(resolve(repoRoot, handlersFile), 'utf8')
  : readFileSync(new URL('./handlers.example.js', import.meta.url), 'utf8');

// ── 拷贝构建产物 ───────────────────────────────────────────────
rmSync(outDir, { recursive: true, force: true });
mkdirSync(join(outDir, 'assets'), { recursive: true });
for (const f of readdirSync(join(distDir, 'assets'))) {
  copyFileSync(join(distDir, 'assets', f), join(outDir, 'assets', f));
}

// ── 注入主题变量 + RPC 桩 + 场景 ──────────────────────────────
const THEME_VARS = `
:root {
  --vscode-font-family: -apple-system, "Segoe UI", "PingFang SC", sans-serif;
  --vscode-font-size: 13px;
  --vscode-editor-background: #1f1f1f;
  --vscode-editor-foreground: #cccccc;
  --vscode-editorWidget-background: #202020;
  --vscode-editorWidget-foreground: #cccccc;
  --vscode-widget-border: #454545;
  --vscode-panel-border: #2b2b2b;
  --vscode-contrastBorder: transparent;
  --vscode-button-background: #0078d4;
  --vscode-button-foreground: #ffffff;
  --vscode-button-hoverBackground: #026ec1;
  --vscode-button-secondaryBackground: #313131;
  --vscode-button-secondaryForeground: #cccccc;
  --vscode-button-secondaryHoverBackground: #3c3c3c;
  --vscode-input-background: #313131;
  --vscode-input-foreground: #cccccc;
  --vscode-input-border: #3c3c3c;
  --vscode-input-placeholderForeground: #989898;
  --vscode-descriptionForeground: #9d9d9c;
  --vscode-list-hoverBackground: #2a2d2e;
  --vscode-list-activeSelectionBackground: #04395e;
  --vscode-list-activeSelectionForeground: #ffffff;
  --vscode-errorForeground: #f14c4c;
  --vscode-charts-green: #89d185;
  --vscode-charts-yellow: #cca700;
  --vscode-charts-red: #f14c4c;
  --vscode-testing-iconPassed: #73c991;
  --vscode-editorWarning-foreground: #cca700;
  --vscode-focusBorder: #0078d4;
  --vscode-textLink-foreground: #4daafc;
  --vscode-symbolIcon-keywordForeground: #c586c0;
  --vscode-symbolIcon-stringForeground: #ce9178;
  --vscode-symbolIcon-numberForeground: #b5cea8;
  --vscode-symbolIcon-methodForeground: #dcdcaa;
  --vscode-symbolIcon-variableForeground: #9cdcfe;
  --vscode-symbolIcon-operatorForeground: #d4d4d4;
}`;

const GLUE = `
window.__DBX_STUB_READY__ = true;
(function () {
  // 场景脚本先于本 glue 注入（见注入顺序），此处读取即得完整配置
  const cfg = window.__DBX_STUB__ ?? {};
  window.__BOOTSTRAP__ = {
    page: 'table',
    viewId: 'preview-view',
    params: { connId: 'c1', db: 'demo', obj: 'users', env: 'test', rowEstimate: '5000' },
    ...(cfg.bootstrap ?? {}),
  };
  window.acquireVsCodeApi = () => ({
    postMessage(msg) {
      if (!msg || msg.kind !== 'req') return;
      // 惰性再取一次，兼容场景脚本异步/后置定义
      const h = ((window.__DBX_STUB__ ?? {}).handlers ?? {})[msg.method];
      setTimeout(() => {
        let frame;
        if (!h) {
          frame = { kind: 'res', id: msg.id, ok: false, error: { code: 'E_UNKNOWN_METHOD', message: 'stub 未实现 ' + msg.method } };
        } else {
          try {
            frame = { kind: 'res', id: msg.id, ok: true, result: h(msg.params) };
          } catch (err) {
            frame = { kind: 'res', id: msg.id, ok: false, error: { code: 'E_INTERNAL', message: String((err && err.message) || err) } };
          }
        }
        window.dispatchEvent(new MessageEvent('message', { data: frame }));
      }, cfg.delayMs ?? 60);
    },
    getState() { return {}; },
    setState() { return; },
  });
})();`;

const html = readFileSync(join(distDir, 'index.html'), 'utf8');
const moduleScript = /<script type="module"[^>]*>/;
if (!moduleScript.test(html)) {
  console.error('dist/index.html 中未找到 module script（先构建：pnpm --filter @db-explorer/webview-ui build）');
  process.exit(1);
}
const injected = html.replace(
  moduleScript,
  // 注入顺序：主题变量 → 场景（__DBX_STUB__）→ glue（读取场景）→ bundle
  `<style>${THEME_VARS}</style>\n<script>\n${handlersJs}\n</script>\n<script>${GLUE}</script>\n$&`,
);
writeFileSync(join(outDir, 'index.html'), injected);

// ── 静态服务 ──────────────────────────────────────────────────
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  const file = resolve(outDir, rel);
  if (!file.startsWith(outDir)) {
    res.writeHead(403).end();
    return;
  }
  try {
    const body = readFileSync(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
});
server.listen(opts.port, '127.0.0.1', () => {
  console.log(`[webview-visual-test] http://127.0.0.1:${opts.port}/index.html`);
  console.log(`[webview-visual-test] 产物目录 ${outDir}（Ctrl+C 结束）`);
});
