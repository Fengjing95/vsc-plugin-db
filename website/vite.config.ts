import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import { siteContent } from './src/content/site';

/**
 * 官网双构建（D-25 P2 落地，chore/website-en-build）：
 * - SITE_LANG=zh（缺省）→ 根路径产物 dist/（zh 静态 SEO，现有行为不变）
 * - SITE_LANG=en → /en/ 前缀产物 dist-en/（base=/en/；html lang/title/meta/og/twitter
 *   落死英文——en 文案单一来源 = site.ts en 词典，无第二份硬编码），构建编排脚本
 *   scripts/build-all.mjs 将其拷入 dist/en/（EdgeOne 静态子目录直接命中，无 SPA 回退需求）
 * - dev 模式（未设 SITE_LANG）= 单构建客户端切换（D-25 B4 行为不变）
 */
const siteLang = process.env.SITE_LANG === 'en' ? 'en' : 'zh';
const isEnBuild = siteLang === 'en';

/** en 构建的 SEO 落死（transformIndexHtml：zh 模板值只作正则锚，en 值全部出自 site.ts en 词典） */
const enSeoPlugin: Plugin = {
  name: 'dbkit-en-seo',
  transformIndexHtml(html) {
    const en = siteContent.en;
    const site = 'https://dbkit.easyremember.cn';
    return html
      .replace('<html lang="zh-CN">', '<html lang="en">')
      .replace(/<title>[\s\S]*?<\/title>/, `<title>${en.meta.title}</title>`)
      .replace(
        /<meta\s+name="description"\s+content="[\s\S]*?"\s*\/>/,
        `<meta name="description" content="${en.meta.description}" />`,
      )
      .replace(/<link rel="canonical" href="[^"]*" \/>/, `<link rel="canonical" href="${site}/en/" />`)
      .replace(/<meta property="og:title" content="[^"]*" \/>/, `<meta property="og:title" content="${en.meta.title}" />`)
      .replace(
        /<meta property="og:description" content="[\s\S]*?" \/>/,
        `<meta property="og:description" content="${en.meta.description}" />`,
      )
      .replace(/<meta property="og:url" content="[^"]*" \/>/, `<meta property="og:url" content="${site}/en/" />`)
      .replace(/<meta property="og:locale" content="[^"]*" \/>/, '<meta property="og:locale" content="en_US" />')
      .replace(/<meta name="twitter:title" content="[^"]*" \/>/, `<meta name="twitter:title" content="${en.meta.title}" />`)
      .replace(
        /<meta name="twitter:description" content="[\s\S]*?" \/>/,
        `<meta name="twitter:description" content="${en.meta.description}" />`,
      );
  },
};

export default defineConfig({
  base: isEnBuild ? '/en/' : '/',
  plugins: [react(), ...(isEnBuild ? [enSeoPlugin] : [])],
  define: {
    // 运行时构建语言（lang.ts：PROD 静态语言 + 跨构建互链重定向；dev 缺省 zh 走客户端切换）
    'import.meta.env.VITE_SITE_LANG': JSON.stringify(siteLang),
  },
  resolve: {
    alias: {
      // Playground 不打包 node-sql-parser（体积 + node 内建依赖面）：
      // core sqlDanger 对 astify 抛错自带正则降级（P-24 fail-closed），判定行为保持正确
      'node-sql-parser': fileURLToPath(new URL('./src/playground/stubs/nodeSqlParserStub.ts', import.meta.url)),
    },
  },
  build: {
    target: 'es2020',
    outDir: isEnBuild ? 'dist-en' : 'dist',
    // 双构建编排（build-all.mjs）：en 产物独立目录再拷入 dist/en；zh 构建保持常规清理
    emptyOutDir: true,
  },
});
