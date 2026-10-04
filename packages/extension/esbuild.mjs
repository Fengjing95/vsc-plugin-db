import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  // ssh2 / exceljs：external 从 node_modules 运行时加载——ssh2 含可选 native 加速
  // （cpu-features，try/catch 降级），exceljs 体积大且含动态 require，打包无收益
  external: ['vscode', 'ssh2', 'cpu-features', 'exceljs'],
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
