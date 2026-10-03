import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  // ssh2：可选 native 加速 cpu-features（try/catch require，缺省纯 JS 降级）——
  // native .node 无法打包，二者一律 external 从 node_modules 运行时加载
  external: ['vscode', 'ssh2', 'cpu-features'],
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
