import { copyFileSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const scriptDir = dirname(fileURLToPath(import.meta.url)); // packages/extension

const watch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  // ssh2 / exceljs：external 从 node_modules 运行时加载——ssh2 含可选 native 加速
  // （cpu-features，try/catch 降级），exceljs 体积大且含动态 require，打包无收益。
  // pg 与 mysql2/node-redis 同口径整体打包（纯 JS）；pg-native 是 pg 的可选 native 客户端
  // （未安装），静态打包会被 esbuild 解析报错 → 标 external（运行时仅在 native 路径才 require）
  external: ['vscode', 'ssh2', 'cpu-features', 'exceljs', 'pg-native'],
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  sourcemap: true,
  logLevel: 'info',
};

// 驱动品牌 logo：从 webview-ui 素材源拷贝到 media/logos（树连接节点 iconPath 引用；
// .vscodeignore 不排除 media → 随扩展打包）。素材单一事实源在 webview-ui/src/assets/logos；
// 仅拷 .svg（避开 .DS_Store 等杂物），文件名归一化小写——素材源大小写混合（MySQL.svg 等），
// 而树侧 DRIVER_LOGO_FILES 映射为小写（与 webview DRIVER_LOGO_KEYS 同源），iconPath 在
// Linux 等大小写敏感文件系统上必须与磁盘文件名精确一致；逐文件拷贝可改名，幂等可重复执行
const logosSrc = join(scriptDir, '..', 'webview-ui', 'src', 'assets', 'logos');
const logosDst = join(scriptDir, 'media', 'logos');
mkdirSync(logosDst, { recursive: true });
for (const file of readdirSync(logosSrc)) {
  if (file.endsWith('.svg')) {
    copyFileSync(join(logosSrc, file), join(logosDst, file.toLowerCase()));
  }
}

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log('[watch] extension 构建中…');
} else {
  await esbuild.build(options);
}
