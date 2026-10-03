import * as net from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Server, utils } from 'ssh2';
import { DriverError, type ConnectionConfig } from '@db-explorer/core';
import {
  GlobalStateFingerprintStore,
  openSshTunnel,
  sshConfigOf,
  toSshError,
  type FingerprintStore,
} from './sshTunnel';
import type { KeyValueStore } from './connectionStore';

/**
 * SSH 隧道单测（概要 §6 #14 / D-12 选型 ssh2）：
 * 用 ssh2 自带的进程内 Server 做真实转发验证（password 认证 + tcpip 通道），
 * 不依赖外部 sshd；目标端为本地 echo server（无外部依赖）。
 * 主机指纹 TOFU 行为用两个不同主机密钥的 server 验证，指纹值以首连录入的存储值为准。
 */

interface SshServerHandle {
  port: number;
  close(): Promise<void>;
}

/** 进程内 SSH 服务器：password 认证 + tcpip 转发到 targetPort 的 echo */
async function startSshServer(opts: {
  password: string;
  targetPort: number;
  privateKey?: string;
}): Promise<SshServerHandle> {
  const key = opts.privateKey ?? hostKeyA.private;
  const server = new Server({ hostKeys: [key] }, (client) => {
    // fixture 会被粗暴断开（认证拒绝/超时清理），协议层错误吞掉防未捕获异常
    client.on('error', () => undefined);
    client.on('authentication', (ctx) => {
      // ssh2 1.x 运行时认证方法在 ctx.method（@types 1.15 的 ctx.type 已过时）
      const method = (ctx as unknown as { method?: string }).method;
      const password = (ctx as unknown as { password?: string }).password;
      if (method === 'password' && password === opts.password) {
        ctx.accept();
      } else {
        ctx.reject();
      }
    });
    client.on('tcpip', (accept, _reject, info) => {
      const channel = accept();
      const target = net.connect(info.destPort, info.destIP);
      target.on('error', () => channel.close());
      channel.on('close', () => target.destroy());
      target.pipe(channel);
      channel.pipe(target);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const port = (server.address() as net.AddressInfo).port;
  return { port, close: () => new Promise((r) => server.close(() => r())) };
}

const hostKeyA = utils.generateKeyPairSync('ed25519');
const hostKeyB = utils.generateKeyPairSync('ed25519');

async function startEchoServer(): Promise<{ port: number; close(): Promise<void> }> {
  const server = net.createServer((socket) => {
    socket.pipe(socket);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const port = (server.address() as net.AddressInfo).port;
  return { port, close: () => new Promise((r) => server.close(() => r())) };
}

function memStore(): FingerprintStore {
  const map = new Map<string, string>();
  return { get: (k) => map.get(k), set: (k, v) => void map.set(k, v) };
}

const SSH_PASSWORD = 'ssh-test-pass';

describe('sshConfigOf（cfg.ssh 解析）', () => {
  const base: ConnectionConfig = {
    id: 'c1',
    name: 'n',
    driverId: 'mysql',
    options: { host: 'db.internal', port: 3306 },
    secretRef: 'dbExplorer.secrets.c1',
  };

  it('未启用/缺 ssh 槽位 → undefined（直连）', () => {
    expect(sshConfigOf(base)).toBeUndefined();
    expect(sshConfigOf({ ...base, ssh: { enabled: false } })).toBeUndefined();
  });

  it('启用但缺 host → E_VALIDATION（防静默直连）', () => {
    expect(() => sshConfigOf({ ...base, ssh: { enabled: true } })).toThrowError(
      expect.objectContaining({ code: 'E_VALIDATION' } satisfies Partial<DriverError>),
    );
  });

  it('启用且完整 → 解析出端口/用户名等', () => {
    const cfg = sshConfigOf({
      ...base,
      ssh: { enabled: true, host: 'jump', port: 2222, username: 'ops', insecureHostKey: true },
    });
    expect(cfg).toMatchObject({ enabled: true, host: 'jump', port: 2222, username: 'ops', insecureHostKey: true });
  });
});

describe('toSshError（错误映射）', () => {
  it('认证失败 → E_AUTH', () => {
    expect(toSshError(new Error('All configured authentication methods failed')).code).toBe('E_AUTH');
  });
  it('不可达/拒绝 → E_CONN', () => {
    expect(toSshError(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })).code).toBe('E_CONN');
    expect(toSshError(Object.assign(new Error('getaddrinfo ENOTFOUND jump'), { code: 'ENOTFOUND' })).code).toBe('E_CONN');
  });
  it('握手超时 → E_CONN（建连类超时）', () => {
    expect(toSshError(new Error('Timed out while waiting for handshake')).code).toBe('E_CONN');
  });
  it('主机指纹变更 → E_CONN 且文案含「指纹」', () => {
    const err = toSshError(new Error('Host key verification failed'), { stored: 'AAA', actual: 'BBB' });
    expect(err.code).toBe('E_CONN');
    expect(err.message).toContain('指纹');
  });
});

describe('openSshTunnel（进程内 ssh2 Server 真转发）', () => {
  let echo: { port: number; close(): Promise<void> };
  let sshd: SshServerHandle;

  beforeAll(async () => {
    echo = await startEchoServer();
    sshd = await startSshServer({ password: SSH_PASSWORD, targetPort: echo.port });
  });
  afterAll(async () => {
    await sshd.close();
    await echo.close();
  });

  function tunnelOpts(overrides?: Partial<Parameters<typeof openSshTunnel>[0]>) {
    return {
      cfg: {
        enabled: true,
        host: '127.0.0.1',
        port: sshd.port,
        username: 'ops',
        insecureHostKey: true, // 默认跳过；TOFU 行为单独一组用例
      },
      password: SSH_PASSWORD,
      target: { host: '127.0.0.1', port: echo.port },
      fingerprints: memStore(),
      fpKey: 'k1',
      ...overrides,
    } as Parameters<typeof openSshTunnel>[0];
  }

  it('建立隧道后本地端口数据可达（echo 往返）', async () => {
    const tunnel = await openSshTunnel(tunnelOpts());
    try {
      // write + 等回声（end() 的 EOF 会沿管道提前传播，与回声竞态）
      const roundTrip = await new Promise<string>((resolve, reject) => {
        const sock = net.connect(tunnel.localPort, '127.0.0.1');
        const chunks: Buffer[] = [];
        sock.on('data', (d) => {
          chunks.push(d);
          if (Buffer.concat(chunks).toString('utf8').includes('hello-tunnel')) {
            sock.destroy();
            resolve('roundtrip-ok');
          }
        });
        sock.on('error', reject);
        sock.on('close', () => reject(new Error('sock closed before echo')));
        sock.write('hello-tunnel');
      });
      expect(roundTrip).toBe('roundtrip-ok');
    } finally {
      tunnel.dispose();
    }
  });

  it('密码错误 → E_AUTH', async () => {
    await expect(openSshTunnel(tunnelOpts({ password: 'wrong' }))).rejects.toMatchObject({
      code: 'E_AUTH',
    } satisfies Partial<DriverError>);
  });

  it('跳板机不可达 → E_CONN', async () => {
    await expect(
      openSshTunnel(tunnelOpts({ cfg: { enabled: true, host: '127.0.0.1', port: 1 } })),
    ).rejects.toMatchObject({ code: 'E_CONN' } satisfies Partial<DriverError>);
  });

  it('私钥路径不存在 → E_VALIDATION', async () => {
    await expect(
      openSshTunnel(
        tunnelOpts({
          cfg: {
            enabled: true, host: '127.0.0.1', port: sshd.port, username: 'ops',
            privateKeyPath: '/nonexistent/id_key',
          },
        }),
      ),
    ).rejects.toMatchObject({ code: 'E_VALIDATION' } satisfies Partial<DriverError>);
  });

  it('dispose 幂等且可重复调用', async () => {
    const tunnel = await openSshTunnel(tunnelOpts());
    tunnel.dispose();
    tunnel.dispose();
  });
});

describe('主机指纹 TOFU（首连录入 / 变更拒绝 / 跳过开关）', () => {
  let echo: { port: number; close(): Promise<void> };
  let sshdA: SshServerHandle;
  let sshdB: SshServerHandle;
  beforeAll(async () => {
    echo = await startEchoServer();
    sshdA = await startSshServer({ password: SSH_PASSWORD, targetPort: echo.port });
    sshdB = await startSshServer({ password: SSH_PASSWORD, targetPort: echo.port, privateKey: hostKeyB.private });
  });
  afterAll(async () => {
    await sshdA.close();
    await sshdB.close();
    await echo.close();
  });

  const fingerprints = memStore();
  const base = (port: number) => ({
    cfg: { enabled: true, host: '127.0.0.1', port, username: 'ops' },
    password: SSH_PASSWORD,
    target: { host: '127.0.0.1', port: echo.port },
    fingerprints,
    fpKey: 'same-key',
  });

  it('首连录入指纹（TOFU）', async () => {
    const tunnel = await openSshTunnel(base(sshdA.port));
    tunnel.dispose();
    expect(fingerprints.get('same-key')).toBeTruthy();
  });

  it('同键重连到不同主机密钥 → E_CONN 指纹变更', async () => {
    await expect(openSshTunnel(base(sshdB.port))).rejects.toMatchObject({
      code: 'E_CONN',
      message: expect.stringContaining('指纹'),
    } satisfies Partial<DriverError>);
  });

  it('insecureHostKey=true 跳过校验', async () => {
    const b = base(sshdB.port);
    const tunnel = await openSshTunnel({ ...b, cfg: { ...b.cfg, insecureHostKey: true } });
    tunnel.dispose();
  });
});

describe('GlobalStateFingerprintStore', () => {
  function memGlobal(): KeyValueStore & { data: Map<string, unknown> } {
    const data = new Map<string, unknown>();
    return {
      data,
      get: <T>(k: string, fb?: T) => (data.has(k) ? (data.get(k) as T) : fb),
      update: (k, v) => {
        data.set(k, v);
        return Promise.resolve();
      },
    };
  }

  it('持久化到 globalState 并可跨实例回读（模拟重启）', async () => {
    const g = memGlobal();
    const store = new GlobalStateFingerprintStore(g);
    expect(store.get('x')).toBeUndefined();
    store.set('x', 'fp-1');
    const store2 = new GlobalStateFingerprintStore(g);
    expect(store2.get('x')).toBe('fp-1');
  });
});
