import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Webview 内资源必须相对路径引用（base:'./'），由 extension 改写为 webview URI
export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    outDir: 'dist',
    target: 'es2022',
  },
});
