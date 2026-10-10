import { spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import { homedir } from 'node:os';
import path from 'node:path';

/**
 * 测试环境 Redis 实例「即起即用」（M7 起 launchd 常驻已移除，AGENTS P-28）：
 * - 端口已有服务（本地手起 / CI service）→ 直接复用，不做任何启停
 * - 端口空闲 → spawn 本地二进制（~/tools/redis、TLS 用 ~/tools/redis-tls），结束后停掉
 * 门禁语义不变：契约覆盖始终真实执行，不因缺实例静默跳过（P-19）。
 */

export interface LocalRedisProc {
  /** 是否由本模块 spawn（false = 复用既有服务，stop 为 no-op） */
  spawned: boolean;
  stop(): Promise<void>;
}

function portOpen(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port, timeout: 500 });
    sock.once('connect', () => {
      sock.destroy();
      resolve(true);
    });
    sock.once('error', () => {
      sock.destroy();
      resolve(false);
    });
    sock.once('timeout', () => {
      sock.destroy();
      resolve(false);
    });
  });
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function ensureLocalRedis(opts: {
  port: number;
  requirepass?: string;
  tls?: boolean;
}): Promise<LocalRedisProc> {
  if (await portOpen(opts.port)) {
    return { spawned: false, stop: async () => undefined };
  }
  const bin = opts.tls
    ? process.env.REDIS_TLS_BIN ?? path.join(homedir(), 'tools', 'redis-tls', 'redis-server')
    : process.env.REDIS_BIN ?? path.join(homedir(), 'tools', 'redis', 'redis-server');
  const args = opts.tls
    ? [path.join(homedir(), 'tools', 'redis-tls', 'redis-tls.conf')]
    : [
        '--port', String(opts.port),
        '--save', '',
        '--appendonly', 'no',
        ...(opts.requirepass ? ['--requirepass', opts.requirepass] : []),
      ];
  const child: ChildProcess = spawn(bin, args, { stdio: 'ignore' });
  // 二进制缺失时 spawn 经 'error' 事件异步报错（ENOENT）——不挂监听器会成为 uncaught
  // exception 毒化 vitest 进程（CI 无 ~/tools/redis*，契约 ssl.test TLS 探测实测暴露；
  // P-32 的 ssh2 fixture 同族）。吞掉事件并置失败标记，调用方走「未就绪」跳过路径
  let spawnFailed = false;
  child.on('error', () => {
    spawnFailed = true;
  });

  // 等待端口就绪（源码编译版启动亚秒级；10s 兜底防挂）
  const deadline = Date.now() + 10_000;
  let ready = false;
  while (Date.now() < deadline) {
    if (spawnFailed || child.exitCode !== null) {
      throw new Error(`redis-server 不可用（二进制缺失或启动失败）：${bin}`);
    }
    if (await portOpen(opts.port)) {
      ready = true;
      break;
    }
    await wait(100);
  }
  if (!ready) {
    child.kill('SIGKILL');
    throw new Error(`redis-server 未在 10s 内监听 ${opts.port}：${bin}`);
  }

  let stopped = false;
  return {
    spawned: true,
    stop: () =>
      new Promise<void>((resolve) => {
        if (stopped || child.exitCode !== null) {
          stopped = true;
          resolve();
          return;
        }
        stopped = true;
        child.once('exit', () => resolve());
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 2_000).unref();
      }),
  };
}
