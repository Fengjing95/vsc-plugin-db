#!/usr/bin/env node
/**
 * 生成数据库品牌图标数据模块（src/components/dbIcons.generated.ts）。
 *
 * 源：src/assets/logos/*.svg（iconfont 导出格式，经核查仅含 svg+path 且 path 均带显式 fill，
 * 深浅主题安全；无 fill-rule/stroke 系等需驼峰转换的属性——未来素材引入此类属性时在此扩展）。
 * 处理：仅提取 viewBox 与各 path 的 d/fill；剔除整幅画布底色 rect（如 SQLite3 白底——
 * 深色主题下渲染为白板）；iconfont 元数据属性（t、p-id、class、xmlns、width、height）不提取即丢弃。
 *
 * 用法：pnpm --filter @db-explorer/webview-ui generate:db-icons
 * 约定：产物提交入库（构建不依赖本脚本）；新增数据库 logo = svg 丢入 logos/ 后重跑本脚本。
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const logosDir = join(pkgRoot, 'src', 'assets', 'logos');
const outFile = join(pkgRoot, 'src', 'components', 'dbIcons.generated.ts');

/** 整幅画布底色 path（d 恰好覆盖 viewBox）——一律视为背景剔除 */
const CANVAS_PATH_RE = /^M0 0h([\d.]+)v([\d.]+)H0z$/i;

const files = readdirSync(logosDir)
  .filter((f) => f.toLowerCase().endsWith('.svg'))
  .sort();

if (files.length === 0) {
  console.error(`[generate-db-icons] ${logosDir} 下没有 svg 素材`);
  process.exit(1);
}

/** @type {Array<[string, { viewBox: string; paths: Array<{ d: string; fill?: string }> }]>} */
const entries = [];
for (const file of files) {
  const raw = readFileSync(join(logosDir, file), 'utf8');
  const viewBox = /viewBox="([^"]+)"/.exec(raw)?.[1];
  if (!viewBox) {
    console.error(`[generate-db-icons] ${file}: 缺少 viewBox，跳过`);
    process.exit(1);
  }
  const [, , vw, vh] = viewBox.trim().split(/\s+/);

  /** @type {Array<{ d: string; fill?: string }>} */
  const paths = [];
  for (const m of raw.matchAll(/<path\b[^>]*>/g)) {
    const tag = m[0];
    const d = /\sd="([^"]+)"/.exec(tag)?.[1];
    if (!d) {
      continue;
    }
    const norm = d.replace(/\s+/g, ' ').trim();
    const canvas = CANVAS_PATH_RE.exec(norm);
    if (canvas && Number(canvas[1]) === Number(vw) && Number(canvas[2]) === Number(vh)) {
      continue; // 整幅底色 rect（如 SQLite3 白底）——深色主题下是白板，剔除
    }
    const fill = /\sfill="([^"]+)"/.exec(tag)?.[1];
    paths.push(fill ? { d, fill } : { d });
  }
  if (paths.length === 0) {
    console.error(`[generate-db-icons] ${file}: 未提取到任何 path，跳过`);
    process.exit(1);
  }
  entries.push([basename(file, '.svg').toLowerCase(), { viewBox, paths }]);
  console.log(`[generate-db-icons] ${file} → ${basename(file, '.svg').toLowerCase()}（${paths.length} path）`);
}

const body = entries
  .map(([key, val]) => `  ${JSON.stringify(key)}: ${JSON.stringify(val, null, 2).replace(/\n/g, '\n  ')},`)
  .join('\n');

const ts = `// 由 scripts/generate-db-icons.mjs 从 src/assets/logos/*.svg 生成——勿手改。
// 新增数据库 logo：svg 丢入 logos/ 后重跑 pnpm --filter @db-explorer/webview-ui generate:db-icons。
// key = 文件名小写（驱动别名归一在 components/ui/dbIcons.tsx 的 DRIVER_LOGO_KEYS）。

export interface DbLogoSvg {
  viewBox: string;
  paths: Array<{ d: string; fill?: string }>;
}

export const DB_LOGO_SVGS: Record<string, DbLogoSvg> = {
${body}
};
`;

writeFileSync(outFile, ts, 'utf8');
console.log(`[generate-db-icons] 已生成 ${outFile}（${entries.length} 个图标）`);
