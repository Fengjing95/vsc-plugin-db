import * as crypto from 'node:crypto';
import * as net from 'node:net';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { Client } from 'ssh2';
import { DriverError, type ConnectionConfig } from '@db-explorer/core';
import type { FormFieldPayload } from '@db-explorer/protocol';
import type { KeyValueStore } from './connectionStore';

/**
 * SSH 隧道（概要设计 §6 #14「SSH 隧道 / SSL / 代理」P1；选型 ssh2，D-12）：
 * - 配置在 cfg.ssh（core ConnectionConfig 预留槽位），表单字段由扩展层统一注入（驱动不感知）
 * - 建连链路接入：ensureConnected / conn.test 先开隧道，再把 127.0.0.1:localPort 重写进
 *   传给驱动的 options——驱动、契约、协议零改动
 * - 主机指纹 TOFU（首连录入、变更拒绝）；「跳过校验」开关在表单标注风险（规范 §10 同 SSL 口径）
 * - SSH 密码走 SecretStorage（C-10，vault key 见 connectionStore.sshSecretRefOf）
 */

/** cfg.ssh 的形状（core 侧为宽松 Record，这里做守护） */
export interface SshTunnelConfig {
  enabled: boolean;
  host: string;
  port: number;
  username?: string;
  privateKeyPath?: string;
  insecureHostKey?: boolean;
}

/** 连接表单的 SSH 字段组（驱动 FormSchema 合并进「高级」分组；sshPassword 不入 options → SecretStorage） */
export const SSH_FORM_FIELDS: FormFieldPayload[] = [
  // section/toggle（M8 表单方案 A）：SSH 隧道小节——开关在标题行，开启后才显示以下配置
  { key: 'sshEnabled', label: 'SSH 隧道', type: 'boolean', default: false, group: '高级', section: 'SSH 隧道' },
  { key: 'sshHost', label: 'SSH 主机', type: 'string', placeholder: '跳板机地址', group: '高级', section: 'SSH 隧道', toggle: 'sshEnabled' },
  { key: 'sshPort', label: 'SSH 端口', type: 'number', default: 22, validator: 'port', group: '高级', section: 'SSH 隧道', toggle: 'sshEnabled' },
  { key: 'sshUsername', label: 'SSH 用户名', type: 'string', group: '高级', section: 'SSH 隧道', toggle: 'sshEnabled' },
  { key: 'sshPassword', label: 'SSH 密码', type: 'password', group: '高级', section: 'SSH 隧道', toggle: 'sshEnabled' },
  {
    key: 'sshPrivateKeyPath',
    label: 'SSH 私钥路径（可选）',
    type: 'string',
    placeholder: '~/.ssh/id_rsa',
    group: '高级',
    section: 'SSH 隧道',
    toggle: 'sshEnabled',
    hint: '本机私钥文件路径；暂不支持带口令的私钥',
  },
  {
    key: 'sshInsecureHostKey',
    label: '跳过主机指纹校验',
    type: 'boolean',
    default: false,
    group: '高级',
    section: 'SSH 隧道',
    toggle: 'sshEnabled',
    hint: '⚠ 风险：不校验跳板机主机指纹，连接可被中间人劫持。默认首连录入指纹（TOFU），变更将拒绝',
  },
];

/** 表单 options → cfg.ssh 槽位（connSave 用；sshPassword 已由 secretKeys 拦截不入 options） */
export function sshConfigFromOptions(options: Record<string, unknown>): Record<string, unknown> | undefined {
  if (options.sshEnabled !== true) {
    return undefined;
  }
  return {
    enabled: true,
    host: String(options.sshHost ?? '').trim(),
    port: Number(options.sshPort ?? 22),
    username: options.sshUsername ? String(options.sshUsername) : undefined,
    privateKeyPath: options.sshPrivateKeyPath ? String(options.sshPrivateKeyPath) : undefined,
    insecureHostKey: options.sshInsecureHostKey === true,
  };
}

/** cfg.ssh → 表单 options 回填（conn.getMeta 编辑态用） */
export function optionsFromSshConfig(ssh: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!ssh) {
    return {};
  }
  return {
    sshEnabled: ssh.enabled === true,
    sshHost: ssh.host ?? '',
    sshPort: Number(ssh.port ?? 22),
    sshUsername: ssh.username ?? '',
    sshPrivateKeyPath: ssh.privateKeyPath ?? '',
    sshInsecureHostKey: ssh.insecureHostKey === true,
  };
}

/**
 * cfg.ssh → 隧道配置。enabled=false/未配置 → undefined（直连）；
 * enabled=true 但缺 host → E_VALIDATION（防静默直连目标库）。
 */
export function sshConfigOf(cfg: ConnectionConfig): SshTunnelConfig | undefined {
  const raw = cfg.ssh;
  if (!raw || raw.enabled !== true) {
    return undefined;
  }
  const host = typeof raw.host === 'string' ? raw.host.trim() : '';
  if (!host) {
    throw new DriverError('E_VALIDATION', 'SSH 隧道已启用但未填写 SSH 主机');
  }
  const port = Number(raw.port ?? 22);
  return {
    enabled: true,
    host,
    port: Number.isInteger(port) && port > 0 ? port : 22,
    username: typeof raw.username === 'string' && raw.username ? raw.username : undefined,
    privateKeyPath: typeof raw.privateKeyPath === 'string' && raw.privateKeyPath ? raw.privateKeyPath : undefined,
    insecureHostKey: raw.insecureHostKey === true,
  };
}

export interface FingerprintStore {
  get(key: string): string | undefined;
  set(key: string, fingerprint: string): void;
}

const FINGERPRINTS_KEY = 'dbExplorer.ssh.fingerprints';

/** 主机指纹库（globalState 持久化，键 = connId:sshHost:sshPort） */
export class GlobalStateFingerprintStore implements FingerprintStore {
  constructor(private readonly globalState: KeyValueStore) {}

  private load(): Record<string, string> {
    return this.globalState.get<Record<string, string>>(FINGERPRINTS_KEY) ?? {};
  }

  get(key: string): string | undefined {
    return this.load()[key];
  }

  set(key: string, fingerprint: string): void {
    const all = this.load();
    all[key] = fingerprint;
    void this.globalState.update(FINGERPRINTS_KEY, all);
  }
}

export interface SshTunnel {
  /** 本地回环监听端口（驱动连 127.0.0.1:<localPort> 即达目标） */
  localPort: number;
  /** 幂等：关监听 + 结束 SSH 会话 */
  dispose(): void;
}

/** 原始 host key → sha256 base64 指纹 */
function fingerprintOfHostKey(key: Buffer): string {
  return crypto.createHash('sha256').update(key).digest('base64');
}

/** ssh2 原生错误 → DriverError（mismatch = hostVerifier 捕获的指纹变更详情） */
export function toSshError(err: unknown, mismatch?: { stored: string; actual: string }): DriverError {
  if (DriverError.is(err)) {
    return err;
  }
  const e = (err ?? {}) as { code?: string; level?: string; message?: string };
  const raw = e.message ?? String(err);
  const detail = [e.code, e.level, raw].filter(Boolean).join(' ');
  if (mismatch) {
    return new DriverError(
      'E_CONN',
      `SSH 主机指纹已变更（可能为中间人攻击或跳板机重装）：期望 ${mismatch.stored.slice(0, 12)}…，实际 ${mismatch.actual.slice(0, 12)}…。确认无误后可在连接的高级选项开启「跳过主机指纹校验」`,
      { detail },
    );
  }
  if (/authentication/i.test(raw) || e.level === 'client-authentication') {
    return new DriverError('E_AUTH', 'SSH 认证失败：请检查 SSH 用户名/密码或私钥', { detail });
  }
  if (/verification failed|host key/i.test(raw)) {
    return new DriverError('E_CONN', 'SSH 主机指纹校验失败', { detail });
  }
  if (/private key|encoding|encrypted/i.test(raw)) {
    return new DriverError('E_VALIDATION', 'SSH 私钥无法使用：检查路径与格式（暂不支持带口令私钥）', { detail });
  }
  if (/timed out/i.test(raw)) {
    return new DriverError('E_CONN', 'SSH 连接超时：无法在限定时间内连上跳板机', { detail });
  }
  if (
    (e.code !== undefined && ['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'ECONNRESET', 'EHOSTUNREACH', 'EAI_AGAIN'].includes(e.code)) ||
    /ECONNREFUSED|ENOTFOUND|EHOSTUNREACH/.test(raw)
  ) {
    return new DriverError('E_CONN', '无法连接 SSH 跳板机（网络不可达或拒绝连接）', { detail });
  }
  return new DriverError('E_INTERNAL', raw, { detail });
}

export interface OpenSshTunnelOptions {
  cfg: SshTunnelConfig;
  /** SSH 认证密码（vault 或表单明文）；与 privateKeyPath 二选一 */
  password?: string;
  target: { host: string; port: number };
  fingerprints: FingerprintStore;
  /** 指纹存储键（connId:sshHost:sshPort；测试连接用 draft: 前缀） */
  fpKey: string;
  connectTimeoutMs?: number;
}

/**
 * 打开一条 SSH 隧道：SSH 连接 → 本地回环监听 → forwardOut 到 target。
 * 驱动拿到的是 127.0.0.1:<localPort>，对 SSH 一无所知。
 */
export async function openSshTunnel(opts: OpenSshTunnelOptions): Promise<SshTunnel> {
  const { cfg } = opts;
  const timeoutMs = opts.connectTimeoutMs ?? 10_000;

  let privateKey: Buffer | undefined;
  if (cfg.privateKeyPath) {
    try {
      privateKey = await fs.promises.readFile(cfg.privateKeyPath);
    } catch {
      throw new DriverError('E_VALIDATION', `SSH 私钥无法读取：${cfg.privateKeyPath}`);
    }
  }

  // ssh2 要求非空用户名：缺省取当前系统用户（OpenSSH 惯例），再退 root
  let defaultUser = 'root';
  try {
    defaultUser = os.userInfo().username || 'root';
  } catch {
    // 非常规环境退 root
  }

  let mismatch: { stored: string; actual: string } | undefined;
  const client = new Client();
  // 运行期错误兜底（ready 之后 client 'error' 若无监听器会成为未捕获异常）
  client.on('error', () => undefined);

  const config = {
    host: cfg.host,
    port: cfg.port,
    username: cfg.username ?? defaultUser,
    password: opts.password || undefined,
    privateKey,
    readyTimeout: timeoutMs,
    keepaliveInterval: 30_000,
    hostVerifier: (key: Buffer) => {
      if (cfg.insecureHostKey) {
        return true;
      }
      const fp = fingerprintOfHostKey(key);
      const stored = opts.fingerprints.get(opts.fpKey);
      if (stored === undefined) {
        opts.fingerprints.set(opts.fpKey, fp); // TOFU：首连录入
        return true;
      }
      if (stored === fp) {
        return true;
      }
      mismatch = { stored, actual: fp };
      return false;
    },
  };

  try {
    await new Promise<void>((resolve, reject) => {
      client.once('ready', () => resolve());
      client.once('error', (err: Error) => reject(toSshError(err, mismatch)));
      client.once('close', () => reject(new DriverError('E_CONN', 'SSH 连接在就绪前关闭')));
      // connect 可同步抛（如用户名缺失 'Invalid username'），需映射为 DriverError
      try {
        client.connect(config);
      } catch (err) {
        reject(toSshError(err));
      }
    });

    // forwardOut 正确签名：(srcIP, srcPort, dstIP, dstPort, cb(err, stream))，stream 与 socket 手动 pipe
    const server = net.createServer((socket) => {
      client.forwardOut(
        '127.0.0.1',
        socket.remotePort ?? 0,
        opts.target.host,
        opts.target.port,
        (err, stream) => {
          if (err || !stream) {
            socket.destroy();
            return;
          }
          stream.pipe(socket);
          socket.pipe(stream);
        },
      );
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => resolve());
    });
    const localPort = (server.address() as net.AddressInfo).port;
    let disposed = false;
    return {
      localPort,
      dispose: () => {
        if (disposed) {
          return; // 幂等
        }
        disposed = true;
        server.close();
        client.end();
      },
    };
  } catch (err) {
    client.end();
    throw err;
  }
}

export interface SshResolvedTarget {
  /** 可直接交给驱动的配置（隧道开启时 host/port 已重写为本地回环） */
  cfg: ConnectionConfig;
  /** 隧道句柄（调用方负责在连接关闭/失败时 dispose；直连时为 undefined） */
  tunnel?: SshTunnel;
}

/**
 * 建连链路的统一入口：需要隧道则先开隧道并重写 cfg，否则原样返回。
 * ConnectionManager.ensureConnected 与连接表单 conn.test 共用（同源，§8-6 精神）。
 */
export async function resolveSshTarget(
  cfg: ConnectionConfig,
  sshSecret: string,
  fingerprints: FingerprintStore,
  connectTimeoutMs?: number,
): Promise<SshResolvedTarget> {
  const ssh = sshConfigOf(cfg);
  if (!ssh) {
    return { cfg };
  }
  const target = {
    host: String(cfg.options.host ?? '127.0.0.1'),
    port: Number(cfg.options.port ?? 0),
  };
  const tunnel = await openSshTunnel({
    cfg: ssh,
    password: sshSecret,
    target,
    fingerprints,
    fpKey: `${cfg.id}:${ssh.host}:${ssh.port}`,
    connectTimeoutMs,
  });
  return {
    cfg: { ...cfg, options: { ...cfg.options, host: '127.0.0.1', port: tunnel.localPort } },
    tunnel,
  };
}
