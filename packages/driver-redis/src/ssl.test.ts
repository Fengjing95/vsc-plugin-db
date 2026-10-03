import * as tls from 'node:tls';
import { afterAll, describe, expect, it } from 'vitest';
import { DriverError } from '@db-explorer/core';
import { connectWithTimeout, createRedisDriver, type RedisClient, type RedisConnection } from './index';
import { toRedisError } from './errors';
import { ensureLocalRedis } from './testEnv';

/**
 * SSL/TLS 契约（驱动规范 §10：默认校验证书；跳过校验须标注风险）。
 * - FormSchema 断言常驻（字段是驱动公共 API，§3.1 只增不减）
 * - TLS 集成用例需要 BUILD_TLS=yes 的 Redis 实例：默认探测 127.0.0.1:6392（AGENTS P-28
 *   即起即用：~/tools/redis-tls 空闲自起自停；端口避开 6391——契约组把「不可达端口」固定用
 *   6391，TLS 实例不得占用），探测不通自动跳过；REDIS_TLS_PORT=0 强制跳过
 */

const driver = createRedisDriver();

describe('redis formSchema ssl 字段（公共 API）', () => {
  const fields = driver.getConnectionFormSchema().fields;

  it('提供 ssl 开关（基础区，默认关闭）', () => {
    const f = fields.find((x) => x.key === 'ssl');
    expect(f).toBeDefined();
    expect(f!.type).toBe('boolean');
    expect(f!.group).toBeUndefined();
    expect(f!.default).toBe(false);
  });

  it('提供 sslInsecure（高级分组）并标注风险提示（§10）', () => {
    const f = fields.find((x) => x.key === 'sslInsecure');
    expect(f).toBeDefined();
    expect(f!.type).toBe('boolean');
    expect(f!.group).toBe('高级');
    expect(f!.hint).toContain('风险');
  });
});

// ── TLS 错误映射（无需真实实例）─────────────────────────────────────────────

describe('TLS 错误映射', () => {
  it('证书校验类错误 → E_CONN + 可操作文案', () => {
    const err = toRedisError(
      Object.assign(new Error('self signed certificate in certificate chain'), {
        code: 'SELF_SIGNED_CERT_IN_CHAIN',
      }),
    );
    expect(err.code).toBe('E_CONN');
    expect(err.message).toContain('跳过证书校验');
  });

  it('明文连 TLS 端口（wrong version number）→ E_CONN', () => {
    const err = toRedisError(Object.assign(new Error('wrong version number'), { code: 'EPROTO' }));
    expect(err.code).toBe('E_CONN');
  });

  it('重连耗尽包装（ReconnectStrategyError.socketError）解包后按真实原因映射', () => {
    const err = toRedisError(
      Object.assign(new Error('重连次数已达上限'), {
        originalError: new Error('重连次数已达上限'),
        socketError: Object.assign(new Error('self-signed certificate in certificate chain'), {
          code: 'DEPTH_ZERO_SELF_SIGNED_CERT',
        }),
      }),
    );
    expect(err.code).toBe('E_CONN');
  });
});

describe('建连死线（connectWithTimeout，P-30）', () => {
  it('connect() 永不 resolve 时按超时抛 E_CONN', async () => {
    const fake = { connect: () => new Promise<void>(() => undefined), destroy: () => undefined };
    await expect(connectWithTimeout(fake as unknown as RedisClient, 30)).rejects.toMatchObject({
      code: 'E_CONN',
    } satisfies Partial<DriverError>);
  });

  it('connect() 正常返回时不受死线影响', async () => {
    const destroyed: string[] = [];
    const fake = { connect: () => Promise.resolve(), destroy: () => destroyed.push('x') };
    await expect(connectWithTimeout(fake as unknown as RedisClient, 5_000)).resolves.toBeUndefined();
    expect(destroyed).toHaveLength(0);
  });
});

// ── TLS 集成（探测门控：本地常驻实例 / REDIS_TLS_PORT 覆盖 / =0 跳过）────────

const TLS_HOST = process.env.REDIS_TLS_HOST ?? '127.0.0.1';
const TLS_PORT = process.env.REDIS_TLS_PORT !== undefined ? Number(process.env.REDIS_TLS_PORT) : 6392;

async function tlsProbeOpen(): Promise<boolean> {
  if (!TLS_PORT) {
    return false;
  }
  return new Promise((resolve) => {
    const sock = tls.connect(
      { host: TLS_HOST, port: TLS_PORT, rejectUnauthorized: false, timeout: 800 },
      () => {
        sock.destroy();
        resolve(true);
      },
    );
    sock.on('error', () => {
      sock.destroy();
      resolve(false);
    });
    sock.on('timeout', () => {
      sock.destroy();
      resolve(false);
    });
  });
}

const tlsOpen = await (async () => {
  // 即起即用（P-28）：6392 空闲且本地有 TLS 二进制则自起自停；缺实例/缺二进制 → 集成组跳过
  const proc = await ensureLocalRedis({ port: TLS_PORT, tls: true }).catch(() => undefined);
  const open = await tlsProbeOpen();
  if (proc?.spawned) {
    afterAll(() => proc.stop());
  }
  return open;
})();

function makeConn(options: Record<string, unknown>): Promise<RedisConnection> {
  return driver.connect(
    {
      id: 'conformance-redis-tls',
      name: 'Redis TLS 契约',
      driverId: 'redis',
      options: { host: TLS_HOST, port: TLS_PORT, database: 0, ...options },
      secretRef: 'dbExplorer.secrets.conformance-redis-tls',
    },
    '',
  ) as Promise<RedisConnection>;
}

describe.skipIf(!tlsOpen)('redis TLS 集成（自签证书实例）', () => {
  it('ssl + 跳过校验 → 可建连并执行命令', async () => {
    const conn = await makeConn({ ssl: true, sslInsecure: true });
    try {
      await conn.ping();
      const dbs = await conn.listDatabases();
      expect(dbs.length).toBeGreaterThan(0);
    } finally {
      await conn.dispose();
    }
  });

  it('ssl 严格校验 → 自签证书报 E_CONN（默认拒绝，不静默降级）', async () => {
    const conn = await makeConn({ ssl: true });
    try {
      await expect(conn.ping()).rejects.toMatchObject({ code: 'E_CONN' } satisfies Partial<DriverError>);
    } finally {
      await conn.dispose().catch(() => undefined);
    }
  });

  // 「未开 ssl 连 TLS 端口」不做真机集成用例：node-redis v5 在该场景 connect() 永久挂起
  // 且 ECONNRESET 以未捕获异常逃逸（P-30），会毒化测试进程；建连死线行为以下方单测覆盖。

  it('testConnection（ssl 同源构建）→ ok 且返回 serverVersion', async () => {
    const result = await driver.testConnection(
      {
        id: 'tls-probe',
        name: 'tls-probe',
        driverId: 'redis',
        options: { host: TLS_HOST, port: TLS_PORT, ssl: true, sslInsecure: true },
        secretRef: 'dbExplorer.secrets.tls-probe',
      },
      '',
    );
    expect(result.ok).toBe(true);
    expect(result.serverVersion).toBeTruthy();
  });
});
