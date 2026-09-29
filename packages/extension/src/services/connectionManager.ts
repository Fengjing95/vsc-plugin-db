import * as vscode from 'vscode';
import { DriverError, type ConnectionConfig, type DriverRegistry, type IConnection } from '@db-explorer/core';
import type { ConnectionStore } from './connectionStore';

/** 运行时连接管理：懒连接缓存（ADR D-10），持久化归 ConnectionStore */
export class ConnectionManager implements vscode.Disposable {
  private readonly cache = new Map<string, IConnection>();

  constructor(
    private readonly registry: DriverRegistry,
    private readonly store: ConnectionStore,
  ) {}

  async listConfigs(): Promise<ConnectionConfig[]> {
    return this.store.list();
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
    const conn = await driver.connect(cfg, secret);
    this.cache.set(connId, conn);
    return conn;
  }

  /** 编辑/删除连接后失效缓存，下次操作按新配置重连 */
  invalidate(connId: string): void {
    const conn = this.cache.get(connId);
    this.cache.delete(connId);
    if (conn) {
      void Promise.resolve(conn.dispose());
    }
  }

  dispose(): void {
    for (const conn of this.cache.values()) {
      void Promise.resolve(conn.dispose());
    }
    this.cache.clear();
  }
}
