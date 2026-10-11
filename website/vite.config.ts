import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// 部署于腾讯云 EdgeOne（域名根路径，base=/）
export default defineConfig({
  base: '/',
  plugins: [react()],
  build: {
    target: 'es2020',
  },
});
