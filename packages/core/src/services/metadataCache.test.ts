import { describe, expect, it } from 'vitest';
import { MetadataCache } from './metadataCache';

function setup() {
  let now = 1_000_000;
  const cache = new MetadataCache(undefined, () => now);
  const tick = (ms: number) => {
    now += ms;
  };
  return { cache, tick };
}

describe('MetadataCache（概要设计 7.5）', () => {
  it('命中缓存：第二次不再触达 load', async () => {
    const { cache } = setup();
    let calls = 0;
    const load = async () => {
      calls += 1;
      return [{ name: 'demo' }];
    };

    await cache.getDatabases('c1', load);
    await cache.getDatabases('c1', load);

    expect(calls).toBe(1);
    expect((await cache.getDatabases('c1', load))[0].name).toBe('demo');
  });

  it('TTL 过期后重新加载（databases 默认 60s）', async () => {
    const { cache, tick } = setup();
    let calls = 0;
    const load = async () => {
      calls += 1;
      return [{ name: `v${calls}` }];
    };

    await cache.getDatabases('c1', load);
    tick(59_000);
    await cache.getDatabases('c1', load);
    expect(calls).toBe(1);

    tick(2_000); // 累计 61s > TTL
    const again = await cache.getDatabases('c1', load);
    expect(calls).toBe(2);
    expect(again[0].name).toBe('v2');
  });

  it('objects 常驻（时钟推进不失效，手动失效才清除）', async () => {
    const { cache, tick } = setup();
    let calls = 0;
    const load = async () => {
      calls += 1;
      return [{ name: 'users', kind: 'table' as const }];
    };

    await cache.getObjects('c1', 'demo', load);
    tick(10 * 60_000);
    await cache.getObjects('c1', 'demo', load);
    expect(calls).toBe(1);

    cache.invalidateDb('c1', 'demo');
    await cache.getObjects('c1', 'demo', load);
    expect(calls).toBe(2);
  });

  it('in-flight 去重：并发同 key 只触达一次', async () => {
    const { cache } = setup();
    let calls = 0;
    const load = async () => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 10));
      return [
        {
          name: 'id',
          dataType: 'bigint',
          normalizedType: 'integer' as const,
          nullable: false,
          isPrimaryKey: true,
          ordinal: 1,
        },
      ];
    };

    const [a, b] = await Promise.all([
      cache.getColumns('c1', 'demo', 'users', load),
      cache.getColumns('c1', 'demo', 'users', load),
    ]);

    expect(calls).toBe(1);
    expect(a).toEqual(b);
  });

  it('失效粒度：invalidateConnection 清空该连接、不影响其他连接', async () => {
    const { cache } = setup();
    const dbLoad = async () => [{ name: 'demo' }];
    await cache.getDatabases('c1', dbLoad);
    await cache.getDatabases('c2', dbLoad);

    cache.invalidateConnection('c1');
    expect(cache.size).toBe(1);
  });

  it('load 失败不缓存，下次重试', async () => {
    const { cache } = setup();
    let calls = 0;
    const load = async () => {
      calls += 1;
      if (calls === 1) throw new Error('boom');
      return [{ name: 'demo' }];
    };

    await expect(cache.getDatabases('c1', load)).rejects.toThrow('boom');
    const out = await cache.getDatabases('c1', load);
    expect(out).toHaveLength(1);
    expect(calls).toBe(2);
  });

  it('peekDatabases（D-33 展示用）：从不触发加载；返回最近一次加载值（TTL 过期仍返回）；连接失效后为空', async () => {
    const { cache, tick } = setup();
    expect(cache.peekDatabases('c1')).toBeUndefined();
    expect(cache.size).toBe(0); // peek 不产生条目、不触达任何 load

    await cache.getDatabases('c1', async () => [{ name: 'a' }, { name: 'b' }]);
    expect(cache.peekDatabases('c1')?.map((d) => d.name)).toEqual(['a', 'b']);

    tick(61_000); // databases TTL 60s 已过：展示层容忍陈旧（重载由 getDatabases 负责）
    expect(cache.peekDatabases('c1')?.map((d) => d.name)).toEqual(['a', 'b']);

    cache.invalidateConnection('c1');
    expect(cache.peekDatabases('c1')).toBeUndefined();
  });
});
