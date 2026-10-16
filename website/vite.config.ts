import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// 部署于腾讯云 EdgeOne（域名根路径，base=/）
export default defineConfig({
  base: '/',
  plugins: [react()],
  resolve: {
    alias: {
      // Playground 不打包 node-sql-parser（体积 + node 内建依赖面）：
      // core sqlDanger 对 astify 抛错自带正则降级（P-24 fail-closed），判定行为保持正确
      'node-sql-parser': fileURLToPath(new URL('./src/playground/stubs/nodeSqlParserStub.ts', import.meta.url)),
    },
  },
  build: {
    target: 'es2020',
  },
});
