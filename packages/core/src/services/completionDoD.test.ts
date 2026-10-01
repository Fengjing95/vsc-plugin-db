import { describe, expect, it } from 'vitest';
import { MetadataCache } from './metadataCache';
import type { CompletionSource } from '../model/rows';

/**
 * M5 DoD：补全 <100ms（metadataCache 缓存命中）。
 * 计时口径：缓存命中路径 = getCompletionSource 的返回耗时 + 描述符组装在
 * completionContext.test.ts 已覆盖（纯同步、微秒级）；此处对缓存层计时。
 */
describe('M5 DoD：补全缓存命中 <100ms', () => {
  const bigSource: CompletionSource = {
    keywords: Array.from({ length: 100 }, (_, i) => `KW_${i}`),
    functions: Array.from({ length: 100 }, (_, i) => `FN_${i}`),
    databases: ['demo'],
    tables: Array.from({ length: 200 }, (_, i) => ({ name: `t${i}` })),
    columns: Array.from({ length: 200 }, (_, i) => ({ table: `t${i}`, name: 'id' })),
  };

  it('缓存命中耗时 <100ms', async () => {
    const cache = new MetadataCache();
    let loads = 0;
    // 预热（Console 打开时后台触发）
    await cache.getCompletionSource('conn1', 'demo', async () => {
      loads++;
      return bigSource;
    });

    const start = performance.now();
    for (let i = 0; i < 100; i++) {
      const src = await cache.getCompletionSource('conn1', 'demo', async () => {
        loads++;
        return bigSource;
      });
      expect(src.tables).toHaveLength(200);
    }
    const elapsed = performance.now() - start;
    expect(loads).toBe(1); // 100 次请求只触达一次加载
    expect(elapsed).toBeLessThan(100);
  });
});
