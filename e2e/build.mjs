import { mkdirSync } from 'node:fs';
import { build } from 'esbuild';

mkdirSync(new URL('./dist/', import.meta.url), { recursive: true });

const common = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  sourcemap: false,
  logLevel: 'info',
};

// 测试进程侧 runner：external 的依赖运行时从本包 node_modules 解析
// （@db-explorer/* 经 driver-sqlite 借道解析 sql.js，与生产同源，见 src/fixture.ts）
await build({
  ...common,
  entryPoints: ['src/runner.ts'],
  outfile: 'dist/runner.cjs',
  target: 'node20',
  external: ['@db-explorer/*', 'playwright-core', '@vscode/test-electron', 'vscode'],
});

// bridge 扩展（随 VSCode 以 --extensionDevelopmentPath 装载的第二个开发扩展）：
// 在 extension host 里起 HTTP 桥，供 runner 侧执行命令 / 读取状态
await build({
  ...common,
  entryPoints: ['src/bridge/extension.ts'],
  outfile: 'test-extension/extension.js',
  target: 'node18',
  external: ['vscode'],
});
