import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.ts', 'packages/*/src/**/*.test.tsx'],
    environment: 'node',
    // dod.perf.test.ts 的阈值对 CPU 争抢敏感（P-11）：串行跑文件保证门禁确定性
    fileParallelism: false,
  },
});
