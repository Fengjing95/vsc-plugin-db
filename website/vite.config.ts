import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// GitHub Pages 项目站点：https://fengjing95.github.io/vsc-plugin-db/
export default defineConfig({
  base: '/',
  plugins: [react()],
  build: {
    target: 'es2020',
  },
});
