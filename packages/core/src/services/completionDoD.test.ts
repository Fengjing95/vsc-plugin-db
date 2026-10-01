import { describe, expect, it } from 'vitest';
import { MetadataCache } from './metadataCache';
import { buildCompletionDescriptors, resolveCompletionContext } from './completionContext';
import type { CompletionSource } from '../model/rows';

/**
 * M5 DoD：补全 <100ms（metadataCache 缓存命中）。
 * 计时口径：缓存命中 + 上下文解析 + 描述符组装（provider 完整数据路径，
 * vscode CompletionItem 映射为 O(n) 赋值不计）。
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

  it('provider 完整路径（缓存 + 上下文 + 描述符组装）<100ms', async () => {
    const cache = new MetadataCache();
    await cache.getCompletionSource('conn2', 'demo', async () => bigSource);
    const text = 'SELECT u. FROM users u JOIN t0 ON u.id = t0.id WHERE ';
    const start = performance.now();
    for (let i = 0; i < 50; i++) {
      const src = await cache.getCompletionSource('conn2', 'demo', async () => bigSource);
      const ctx = resolveCompletionContext(text, text.length);
      const items = buildCompletionDescriptors(src, ctx);
      expect(items.length).toBeGreaterThan(0);
    }
    expect(performance.now() - start).toBeLessThan(100);
  });
});
