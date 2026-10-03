import * as vscode from 'vscode';
import {
  DriverError,
  type ConnectionConfig,
  type DriverRegistry,
  type IConnection,
  type IDatabaseDriver,
} from '@db-explorer/core';
import type { ConnectionStore } from './connectionStore';
import { resolveSshTarget, type FingerprintStore, type SshTunnel } from './sshTunnel';

/** 运行时连接管理：懒连接缓存（ADR D-10），持久化归 ConnectionStore */
export class ConnectionManager implements vscode.Disposable {
  private readonly cache = new Map<string, IConnection>();
  /** connId → SSH 隧道（与连接同生命周期：断开/失效/停用即拆） */
  private readonly tunnels = new Map<string, SshTunnel>();
  /** 用户主动断开的时刻：树刷新会重新拉取展开节点的子级，窗口期内禁止自动重连（P-33 竞态） */
  private readonly disconnectedAt = new Map<string, number>();
  /** 连接状态变化（建连/断开）→ 树刷新状态徽标（概要 §8.1 连接 description） */
  private readonly statusEmitter = new vscode.EventEmitter<string>();
  readonly onDidChangeStatus = this.statusEmitter.event;

  constructor(
    private readonly registry: DriverRegistry,
    private readonly store: ConnectionStore,
    private readonly fingerprints: FingerprintStore,
  ) {}

  async listConfigs(): Promise<ConnectionConfig[]> {
    return this.store.list();
  }

  /** 连接配置（不触发建连；密码不出现在此结构） */
  getConfig(connId: string): ConnectionConfig | undefined {
    return this.store.get(connId);
  }

  /** 连接的驱动实例（capabilities 判定用，如 M4 编辑权限） */
  getDriver(connId: string): IDatabaseDriver | undefined {
    const cfg = this.getConfig(connId);
    return cfg ? this.registry.get(cfg.driverId) : undefined;
  }

  /** 当前是否有活跃连接（懒连接语义：false 只代表空闲未连，不代表不可用） */
  isConnected(connId: string): boolean {
    return this.cache.has(connId);
  }

  /** 最近的用户主动断开（窗口期内树刷新不得自动重连，P-33：展开节点刷新会拉子级触发建连） */
  recentlyDisconnected(connId: string, withinMs = 2000): boolean {
    const at = this.disconnectedAt.get(connId);
    return at !== undefined && Date.now() - at < withinMs;
  }

  async ensureConnected(connId: string): Promise<IConnection> {
    const cached = this.cache.get(connId);
    if (cached) {
      return cached;
    }
    const cfg = this.store.get(connId);
    if (!cfg) {
      throw new DriverError('E_NOT_FOUND', `连接 "${connId}" 不存在`);
    }
    const driver = this.registry.require(cfg.driverId);
    const secret = (await this.store.getSecret(connId)) ?? '';
    // SSH 隧道（概要 §6 #14）：需要时先开隧道，驱动拿到的是本地回环地址（驱动不感知 SSH）
    const sshSecret = (await this.store.getSshPassword(connId)) ?? '';
    const timeoutMs = vscode.workspace
      .getConfiguration('dbExplorer')
      .get('connection.connectTimeoutMs', 10_000);
    const resolved = await resolveSshTarget(cfg, sshSecret, this.fingerprints, timeoutMs);
    try {
      const conn = await driver.connect(resolved.cfg, secret);
      this.cache.set(connId, conn);
      this.disconnectedAt.delete(connId); // 重连成功，退出断开保护窗口
      if (resolved.tunnel) {
        this.tunnels.set(connId, resolved.tunnel);
      }
      this.statusEmitter.fire(connId);
      return conn;
    } catch (err) {
      // 建连失败不遗留半开的隧道
      resolved.tunnel?.dispose();
      throw err;
    }
  }

  /**
   * 断开连接（用户主动，树节点快捷操作）：释放连接池/socket 资源与 SSH 隧道。
   * 懒连接语义下下次操作自动重连（D-10），不影响已保存配置与 Console 绑定。
   */
  async disconnect(connId: string): Promise<void> {
    const conn = this.cache.get(connId);
    if (!conn) {
      return; // 幂等：本就未连接
    }
    this.cache.delete(connId);
    this.disconnectedAt.set(connId, Date.now());
    await this.disposeTunnel(connId);
    await Promise.resolve(conn.dispose());
    this.statusEmitter.fire(connId);
  }

  /** 编辑/删除连接后失效缓存，下次操作按新配置重连 */
  invalidate(connId: string): void {
    const conn = this.cache.get(connId);
    this.cache.delete(connId);
    const done = Promise.resolve(this.disposeTunnel(connId)).then(() => {
      if (conn) {
        return Promise.resolve(conn.dispose()).then(() => this.statusEmitter.fire(connId));
      }
      return undefined;
    });
    void done;
  }

  private async disposeTunnel(connId: string): Promise<void> {
    const tunnel = this.tunnels.get(connId);
    if (tunnel) {
      this.tunnels.delete(connId);
      tunnel.dispose();
    }
  }

  dispose(): void {
    for (const conn of this.cache.values()) {
      void Promise.resolve(conn.dispose());
    }
    this.cache.clear();
    for (const tunnel of this.tunnels.values()) {
      tunnel.dispose();
    }
    this.tunnels.clear();
    this.statusEmitter.dispose();
  }
}
