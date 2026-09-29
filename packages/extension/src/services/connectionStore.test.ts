import { describe, expect, it } from 'vitest';
import type { ConnectionConfig } from '@db-explorer/core';
import { ConnectionStore, secretRefOf, type SecretVault } from './connectionStore';

function makeFakes() {
  const kv = new Map<string, unknown>();
  const secrets = new Map<string, string>();
  const globalState = {
    get<T>(key: string): T | undefined {
      return kv.get(key) as T | undefined;
    },
    async update(key: string, value: unknown): Promise<void> {
      kv.set(key, value);
    },
  };
  const vault: SecretVault = {
    async get(key) {
      return secrets.get(key);
    },
    async store(key, value) {
      secrets.set(key, value);
    },
    async delete(key) {
      secrets.delete(key);
    },
  };
  return { globalState, vault, kv, secrets };
}

const config: ConnectionConfig = {
  id: 'conn-1',
  name: '本地 MySQL',
  driverId: 'mock',
  env: 'dev',
  options: { host: '127.0.0.1', port: 3306 },
  secretRef: secretRefOf('conn-1'),
};

describe('ConnectionStore（P1-3 密钥生命周期）', () => {
  it('save upsert + list 持久化', async () => {
    const f = makeFakes();
    const store = new ConnectionStore(f.globalState, f.vault);

    await store.save(config);
    await store.save({ ...config, name: '改名后' });

    expect(store.list()).toHaveLength(1);
    expect(store.get('conn-1')?.name).toBe('改名后');
    // 落盘内容不含密码字段
    expect(JSON.stringify(f.kv.get('dbExplorer.connections'))).not.toContain('password');
  });

  it('delete 同步删除密钥，不留孤儿', async () => {
    const f = makeFakes();
    const store = new ConnectionStore(f.globalState, f.vault);
    await store.save(config);
    await store.setPassword('conn-1', 's3cret');
    expect(await store.hasSecret('conn-1')).toBe(true);

    await store.delete('conn-1');

    expect(store.get('conn-1')).toBeUndefined();
    expect(f.secrets.has(secretRefOf('conn-1'))).toBe(false);
  });

  it('copySecret 迁移密钥（明文只经过 vault）', async () => {
    const f = makeFakes();
    const store = new ConnectionStore(f.globalState, f.vault);
    await store.setPassword('conn-1', 's3cret');

    await store.copySecret('conn-1', 'conn-2');

    expect(await store.getSecret('conn-2')).toBe('s3cret');
  });

  it('变更事件随 save/delete 触发', async () => {
    const f = makeFakes();
    const store = new ConnectionStore(f.globalState, f.vault);
    const events: number[] = [];
    const sub = store.onDidChange(() => events.push(events.length));

    await store.save(config);
    await store.delete('conn-1');
    expect(events).toEqual([0, 1]);

    sub.dispose();
    await store.save({ ...config, id: 'conn-x' });
    expect(events).toEqual([0, 1]);
  });

  it('ensureSeed 仅在空库时播种', async () => {
    const f = makeFakes();
    const store = new ConnectionStore(f.globalState, f.vault);
    const seed: ConnectionConfig = { ...config, id: 'mock-local' };

    await store.ensureSeed(seed);
    await store.save({ ...config, id: 'user-conn' });
    await store.ensureSeed({ ...seed, name: '不该重复播种' });

    expect(store.list().map((c) => c.id).sort()).toEqual(['mock-local', 'user-conn']);
  });
});
