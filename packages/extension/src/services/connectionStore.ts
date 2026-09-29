import { Emitter, type ConnectionConfig } from '@db-explorer/core';

/**
 * 连接持久化（概要设计 5.2 / 评审 P1-3）：
 * - 配置本体存 globalState（不含密码）
 * - 密码存 SecretStorage，key 统一 `dbExplorer.secrets.<connId>`
 * - 删除连接同步删除密钥（防孤儿）；复制连接经 vault 迁移密钥，明文不出现在剪贴板/日志
 * 存储接口注入，便于单测与未来替换。
 */
export interface KeyValueStore {
  get<T>(key: string, fallback?: T): T | undefined;
  update(key: string, value: unknown): Thenable<void>;
}

export interface SecretVault {
  get(key: string): Thenable<string | undefined>;
  store(key: string, value: string): Thenable<void>;
  delete(key: string): Thenable<void>;
}

const CONNECTIONS_KEY = 'dbExplorer.connections';

export function secretRefOf(connId: string): string {
  return `dbExplorer.secrets.${connId}`;
}

export class ConnectionStore {
  private readonly changeEmitter = new Emitter<void>();

  constructor(
    private readonly globalState: KeyValueStore,
    private readonly secrets: SecretVault,
  ) {}

  onDidChange(fn: () => void): { dispose(): void } {
    return this.changeEmitter.event(fn);
  }

  list(): ConnectionConfig[] {
    return this.globalState.get<ConnectionConfig[]>(CONNECTIONS_KEY) ?? [];
  }

  get(connId: string): ConnectionConfig | undefined {
    return this.list().find((c) => c.id === connId);
  }

  async save(config: ConnectionConfig): Promise<void> {
    const all = this.list().filter((c) => c.id !== config.id);
    all.push(config);
    await this.globalState.update(CONNECTIONS_KEY, all);
    this.changeEmitter.fire();
  }

  async delete(connId: string): Promise<void> {
    await this.globalState.update(
      CONNECTIONS_KEY,
      this.list().filter((c) => c.id !== connId),
    );
    // P1-3：删除连接必须同步清理密钥
    await this.secrets.delete(secretRefOf(connId));
    this.changeEmitter.fire();
  }

  async setPassword(connId: string, secret: string): Promise<void> {
    await this.secrets.store(secretRefOf(connId), secret);
  }

  async getSecret(connId: string): Promise<string | undefined> {
    return this.secrets.get(secretRefOf(connId));
  }

  async hasSecret(connId: string): Promise<boolean> {
    return (await this.getSecret(connId)) !== undefined;
  }

  async copySecret(fromConnId: string, toConnId: string): Promise<void> {
    const secret = await this.getSecret(fromConnId);
    if (secret !== undefined) {
      await this.secrets.store(secretRefOf(toConnId), secret);
    }
  }

  /** 首次运行播种演示连接（M0 Mock），保证树不为空 */
  async ensureSeed(seed: ConnectionConfig): Promise<void> {
    if (this.list().length === 0) {
      await this.save(seed);
    }
  }
}
