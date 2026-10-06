import * as esbuild from 'esbuild';

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

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log('[watch] extension 构建中…');
} else {
  await esbuild.build(options);
}
