import { DriverError, Emitter, type ISession, type QueryRequest, type ResultSet } from '@db-explorer/core';

/**
 * 交互式事务会话管理（概要设计 §4.6 / D-09，M7）：
 * - 单连接同时最多 1 个会话（驱动层也会拒绝，这里先行拦截给出统一文案）
 * - 空闲超时自动 ROLLBACK 并释放（防遗忘，默认 5min：dbExplorer.transaction.idleTimeoutMs）
 * - 会话内语句经 session.execute（连接级事务上下文），并刷新空闲计时
 * - 会话开始/结束经 onDidChange 通知（树上「事务进行中」徽标刷新）
 * 依赖注入（连接访问 / 超时读取 / 通知回调），无 vscode 依赖，可单测。
 */

interface ActiveSession {
  session: ISession;
  timer: ReturnType<typeof setTimeout>;
}

/** 会话宿主最小接口（ConnectionManager 结构兼容；测试用桩实现） */
export interface SessionHost {
  ensureConnected(connId: string): Promise<{ openSession?(): Promise<ISession> }>;
}

export class SessionManager {
  private readonly active = new Map<string, ActiveSession>();
  private readonly changeEmitter = new Emitter<void>();
  /** 箭头包装：裸提取 emitter.event 会丢失 this（core Emitter.event 依赖实例状态） */
  readonly onDidChange = (fn: () => void): { dispose(): void } => this.changeEmitter.event(fn);

  constructor(
    private readonly host: SessionHost,
    /** 空闲超时（每次取值，配置可热更） */
    private readonly idleTimeoutMs: () => number,
    /** 超时/异常的用户通知（extension 侧注入 vscode 通知） */
    private readonly notify: (message: string) => void,
  ) {}

  /** 当前连接是否有进行中的交互式事务（树徽标 / Console 路由判定） */
  hasActive(connId: string): boolean {
    return this.active.has(connId);
  }

  /** 开启事务会话（Console BEGIN）：重复开启/能力缺失给出可读错误 */
  async begin(connId: string): Promise<void> {
    if (this.active.has(connId)) {
      throw new DriverError('E_VALIDATION', '已有进行中的事务（单连接最多 1 个，可 COMMIT/ROLLBACK 结束）');
    }
    const conn = await this.host.ensureConnected(connId);
    if (typeof conn.openSession !== 'function') {
      throw new DriverError('E_UNSUPPORTED', '当前驱动不支持交互式事务（BEGIN/COMMIT/ROLLBACK）');
    }
    const session = await conn.openSession();
    const entry: ActiveSession = { session, timer: setTimeout(() => undefined, 0) };
    this.active.set(connId, entry);
    this.arm(connId, entry);
    this.changeEmitter.fire();
  }

  /** 会话内执行语句（刷新空闲计时） */
  async execute(connId: string, req: QueryRequest): Promise<ResultSet[]> {
    const entry = this.active.get(connId);
    if (!entry) {
      throw new DriverError('E_VALIDATION', '没有进行中的事务');
    }
    this.arm(connId, entry);
    return entry.session.execute(req);
  }

  async commit(connId: string): Promise<void> {
    await this.end(connId, 'commit', '事务已提交');
  }

  async rollback(connId: string): Promise<void> {
    await this.end(connId, 'rollback', '事务已回滚');
  }

  dispose(): void {
    // 插件停用：全部回滚（不提交悬挂事务）
    for (const [connId, entry] of [...this.active]) {
      clearTimeout(entry.timer);
      this.active.delete(connId);
      void entry.session.rollback().catch(() => entry.session.dispose());
    }
    this.changeEmitter.fire();
  }

  private async end(connId: string, op: 'commit' | 'rollback', label: string): Promise<void> {
    const entry = this.active.get(connId);
    if (!entry) {
      throw new DriverError('E_VALIDATION', '没有进行中的事务');
    }
    clearTimeout(entry.timer);
    this.active.delete(connId);
    try {
      await entry.session[op]();
    } finally {
      await Promise.resolve(entry.session.dispose()).catch(() => undefined);
      this.changeEmitter.fire();
    }
    this.notify(`${label}（连接 ${connId.slice(0, 8)}…）`);
  }

  /** 重置空闲定时器：超时自动 ROLLBACK（§4.6 防遗忘底线） */
  private arm(connId: string, entry: ActiveSession): void {
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      if (!this.active.has(connId)) {
        return;
      }
      this.active.delete(connId);
      void entry.session
        .rollback()
        .catch(() => undefined)
        .then(() => Promise.resolve(entry.session.dispose()).catch(() => undefined))
        .then(() => {
          this.changeEmitter.fire();
          this.notify(`事务空闲超过 ${Math.round(this.idleTimeoutMs() / 60_000)} 分钟，已自动回滚`);
        });
    }, this.idleTimeoutMs());
  }
}
