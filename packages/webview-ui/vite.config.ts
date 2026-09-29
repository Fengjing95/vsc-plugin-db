import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

// Webview 内资源必须相对路径引用（base:'./'），由 extension 改写为 webview URI
export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: './',
  build: {
    outDir: 'dist',
    target: 'es2022',
  },
});
