import * as vscode from 'vscode';
import { DriverError, type ConnectionConfig, type DriverRegistry, type IConnection } from '@db-explorer/core';

export interface ManagedConnection {
  readonly config: ConnectionConfig;
  connection?: IConnection;
}

/** M0 内置演示连接；M1 起改为 globalState 持久化 + SecretStorage（概要设计 5.2） */
const MOCK_CONNECTION: ConnectionConfig = {
  id: 'mock-local',
  name: '本地 Mock 数据源',
  driverId: 'mock',
  env: 'dev',
  options: { host: '127.0.0.1', port: 3306 },
  secretRef: 'dbExplorer.secrets.mock-local',
};

export class ConnectionManager implements vscode.Disposable {
  private readonly items = new Map<string, ManagedConnection>();

  constructor(private readonly registry: DriverRegistry) {
    this.items.set(MOCK_CONNECTION.id, { config: MOCK_CONNECTION });
  }

  list(): ManagedConnection[] {
    return [...this.items.values()];
  }

  get(id: string): ManagedConnection | undefined {
    return this.items.get(id);
  }

  /** 懒连接（ADR D-10）：首次访问时建立并缓存 */
  async ensureConnected(connId: string): Promise<IConnection> {
    const item = this.items.get(connId);
    if (!item) {
      throw new DriverError('E_NOT_FOUND', `连接 "${connId}" 不存在`);
    }
    if (item.connection) {
      return item.connection;
    }
    const driver = this.registry.require(item.config.driverId);
    item.connection = await driver.connect(item.config, '');
    return item.connection;
  }

  dispose(): void {
    for (const item of this.items.values()) {
      item.connection?.dispose();
    }
    this.items.clear();
  }
}
