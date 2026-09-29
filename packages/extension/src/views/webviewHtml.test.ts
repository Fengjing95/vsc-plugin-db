import { describe, expect, it } from 'vitest';
import { injectWebviewHtml } from './webviewHtmlInject';

// 模拟 Vite build（base:'./'）的产物形态
const VITE_HTML = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <title>DB Explorer</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" crossorigin src="./assets/index-B3iSCXfT.js"></script>
    <link rel="stylesheet" crossorigin href="./assets/index-LRi_KQcP.css" />
  </body>
</html>`;

const BOOT = { page: 'table' as const, viewId: 'c1/demo/users', params: { connId: 'c1' } };

describe('injectWebviewHtml', () => {
  it('外部模块脚本必须携带 nonce（否则被 script-src nonce 策略拦截 → 白屏）', () => {
    const out = injectWebviewHtml(VITE_HTML, (rel) => `https://wv/${rel}`, 'https://wv', BOOT);
    const scriptTags = out.match(/<script[^>]*>/g) ?? [];
    expect(scriptTags.length).toBe(2); // 模块脚本 + bootstrap
    for (const tag of scriptTags) {
      expect(tag).toContain('nonce="');
    }
  });

  it('资源引用改写为 webview URI', () => {
    const out = injectWebviewHtml(VITE_HTML, (rel) => `https://wv/${rel}`, 'https://wv', BOOT);
    expect(out).toContain('https://wv/assets/index-B3iSCXfT.js');
    expect(out).toContain('https://wv/assets/index-LRi_KQcP.css');
    expect(out).not.toContain('src="./assets');
  });

  it('注入 CSP 与引导数据', () => {
    const out = injectWebviewHtml(VITE_HTML, (rel) => `https://wv/${rel}`, 'https://wv', BOOT);
    expect(out).toContain('Content-Security-Policy');
    expect(out).toContain("script-src 'nonce-");
    expect(out).toContain('window.__BOOTSTRAP__');
    expect(out).toContain('"connId":"c1"');
  });

  it('已有 nonce 的脚本不会被重复注入', () => {
    const withNonce = VITE_HTML.replace('<script', '<script nonce="abc"');
    const out = injectWebviewHtml(withNonce, (rel) => `https://wv/${rel}`, 'https://wv', BOOT);
    expect(out).toContain('<script nonce="abc"');
    const scriptTags = out.match(/<script[^>]*>/g) ?? [];
    for (const tag of scriptTags) {
      expect(tag.match(/nonce="/g)).toHaveLength(1);
    }
  });
});
