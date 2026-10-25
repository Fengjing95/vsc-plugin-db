#!/usr/bin/env node
/**
 * Playground 构建前置（dev / build 均先跑本脚本）：
 * 1. 确保 packages/webview-ui/dist 存在（缺失则自动构建）；
 * 2. 拷贝产物到 website/public/playground/webview/（vite 静态托管，iframe 同源加载）；
 * 3. 向 index.html 注入 Playground glue：Dark Modern 主题变量 + __BOOTSTRAP__（取 URL 参数，
 *    含 lang → webview 词典，词典经父文档 host.ts 暴露的 messagesFor 按语言现取）
 *    + acquireVsCodeApi 桩（请求转发给 window.parent.__DBX_HOST__，见 src/playground/host.ts）。
 *
 * 机制与 .agents/skills/webview-visual-test 的 make-stub.mjs 同源（P-20），
 * 差异：stub 是静态回放，此处是「活 Host」真实驱动执行。
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const webviewDist = join(repoRoot, 'packages/webview-ui/dist');
const outDir = join(repoRoot, 'website/public/playground/webview');

if (!existsSync(join(webviewDist, 'index.html'))) {
  console.warn('[playground] webview dist 缺失，先构建 @db-explorer/webview-ui …');
  const r = spawnSync('pnpm', ['--filter', '@db-explorer/webview-ui', 'build'], { cwd: repoRoot, stdio: 'inherit' });
  if (r.status !== 0) {
    console.error('[playground] webview 构建失败，中止');
    process.exit(1);
  }
}

rmSync(outDir, { recursive: true, force: true });
cpSync(webviewDist, outDir, { recursive: true });

// Dark Modern 主题变量（与 make-stub.mjs THEME_VARS 同源口径：--vscode-* 缺失则整页黑底无样式）
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

// RPC 桩：帧格式与 webview rpc/client.ts 契约一致（req/res/evt），活 Host 在父文档（同源）
const GLUE = `
(function () {
  'use strict';
  var q = new URLSearchParams(location.search);
  var page = q.get('page') || 'table';
  // 站点语言透传（B4）：外壳把当前站点语言拼进 iframe src（?lang=），缺省 zh 与旧行为一致
  var lang = q.get('lang') || 'zh';
  var params = {};
  q.forEach(function (v, k) { if (k !== 'page' && k !== 'lang') params[k] = v; });
  var viewId = q.get('viewId') || page;
  // webview 词典（D-25：嵌入界面随站点语言，extension buildWebviewHtml 注入 lang+messages 的同构）：
  // 词典按 lang 现取现用——来源 = 父文档 host.ts 注入的 __DBX_MESSAGES_FOR__（protocol messagesFor，
  // zh 全量 + en 覆盖）；父页不可用（如脱离外壳独立打开）时缺省，t() 回落 zh 词典。语言切换时
  // 外壳改 iframe src 触发重载，本 glue 以新 lang 重建 bootstrap。
  var toMessages = window.parent && window.parent.__DBX_MESSAGES_FOR__;
  var messages = typeof toMessages === 'function' ? toMessages(lang) : undefined;
  // 与 webviewHtmlInject.ts 同口径：对象字面量（App 与各 store 均按对象读取，不是 JSON 字符串）
  window.__BOOTSTRAP__ = { page: page, viewId: viewId, params: params, lang: lang, messages: messages };
  function dispatch(frame) { window.dispatchEvent(new MessageEvent('message', { data: frame })); }
  window.acquireVsCodeApi = function () {
    return {
      postMessage: function (msg) {
        if (!msg || msg.kind !== 'req') return;
        var host = window.parent && window.parent.__DBX_HOST__;
        if (!host || typeof host.handle !== 'function') {
          // glue 是内联脚本拿不到 site 词典，host 未就绪提示按 lang 内联双语（D-25）
          var notReady = lang === 'en' ? 'Playground host not ready, please reload the page' : 'Playground host 未就绪，请刷新页面';
          dispatch({ kind: 'res', id: msg.id, ok: false, error: { code: 'E_INTERNAL', message: notReady } });
          return;
        }
        host.handle(msg.method, msg.params, {
          viewId: viewId,
          params: params,
          emit: function (event, payload) { dispatch({ kind: 'evt', event: event, payload: payload }); },
        }).then(
          function (result) { dispatch({ kind: 'res', id: msg.id, ok: true, result: result }); },
          function (err) { dispatch({ kind: 'res', id: msg.id, ok: false, error: host.toRpcError(err) }); }
        );
      },
      getState: function () { return {}; },
      setState: function () {},
    };
  };
})();`;

const htmlPath = join(outDir, 'index.html');
const html = readFileSync(htmlPath, 'utf8');
const moduleScript = /<script type="module"[^>]*>/;
if (!moduleScript.test(html)) {
  console.error('[playground] webview dist/index.html 中未找到 module script，中止');
  process.exit(1);
}
// 注入顺序：主题变量 → glue（先于 bundle，client.ts 模块加载即调 acquireVsCodeApi）
const injected = html.replace(moduleScript, `<style>${THEME_VARS}</style>\n<script>${GLUE}</script>\n$&`);
writeFileSync(htmlPath, injected);
console.log('[playground] webview 产物已就绪 → website/public/playground/webview');
