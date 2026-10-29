import { defineConfig } from 'vitest/config';

/**
 * perf/ 独立基准跑批（概要设计 §12.4 / 遗留 #9）：
 * - 不进根 vitest include 面（packages 各自 src 下的 glob），四道门禁不感知；独立入口 `pnpm perf`
 * - 基准阈值对 CPU 争抢敏感（P-23 同族）——串行跑文件，不要改回并行
 * - 超设计阈值或超入库基线 20% → 断言失败（退出码非零阻断）
 */
export default defineConfig({
  test: {
    include: ['**/*.perf.test.ts'],
    fileParallelism: false,
    testTimeout: 300_000,
    hookTimeout: 300_000,
  },
});
