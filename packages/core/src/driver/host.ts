import { DriverError } from './errors';
import type { Disposable, IConnection } from './types';
import type { ApplyResult, ChangeSet, FetchRowsRequest, QueryRequest, ResultSet } from '../model/rows';

export interface FetchRowsHostRequest extends Omit<FetchRowsRequest, 'timeoutMs' | 'signal'> {
  timeoutMs?: number;
}

export interface QueryHostRequest extends Omit<QueryRequest, 'timeoutMs' | 'signal'> {
  timeoutMs?: number;
}

/**
 * core 调用驱动的统一入口（ADR D-05）：MVP 为进程内实现；
 * 未来切换 vscode.UtilityProcess 隔离时仅替换实现，驱动代码零改动。
 */
export interface DriverHost {
  fetchRows(conn: IConnection, req: FetchRowsHostRequest): Promise<ResultSet>;
  query(conn: IConnection, req: QueryHostRequest): Promise<ResultSet[]>;
  applyChanges(conn: IConnection, db: string, obj: string, cs: ChangeSet): Promise<ApplyResult>;
}

export class InProcessDriverHost implements DriverHost {
  constructor(private readonly defaultTimeoutMs = 15_000) {}

  fetchRows(conn: IConnection, req: FetchRowsHostRequest): Promise<ResultSet> {
    const { timeoutMs = this.defaultTimeoutMs, ...rest } = req;
    return runWithTimeout((signal) => conn.fetchRows({ ...rest, timeoutMs, signal }), timeoutMs);
  }

  query(conn: IConnection, req: QueryHostRequest): Promise<ResultSet[]> {
    const { timeoutMs = this.defaultTimeoutMs, ...rest } = req;
    return runWithTimeout((signal) => conn.query({ ...rest, timeoutMs, signal }), timeoutMs);
  }

  applyChanges(
    conn: IConnection,
    db: string,
    obj: string,
    cs: ChangeSet,
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<ApplyResult> {
    const timeoutMs = options?.timeoutMs ?? this.defaultTimeoutMs;
    // 契约上 applyChanges 不接收 signal；取消经 runWithTimeout 的同步短路 + race 实现
    return runWithTimeout((_signal) => conn.applyChanges(db, obj, cs), timeoutMs, options?.signal);
  }
}

/**
 * 所有驱动调用的强制护栏（概要设计 7.3/7.6）：超时（E_TIMEOUT）+ 外部取消（E_CANCELED）。
 * 超时/取消后 abort 内部 signal，通知底层实现尽早中止。
 */
export function runWithTimeout<T>(
  start: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  external?: AbortSignal,
): Promise<T> {
  // 预先取消：同步短路，不触达驱动（Promise.race 对“都已结算”的 promise
  // 按数组顺序取胜出，而非结算时间，不能依赖 race 处理这种场景）
  if (external?.aborted) {
    return Promise.reject(new DriverError('E_CANCELED', '已取消'));
  }

  const controller = new AbortController();

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timerPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new DriverError('E_TIMEOUT', `操作超时（${timeoutMs}ms），可在设置中调整`));
    }, timeoutMs);
  });

  const externalPromise = new Promise<never>((_, reject) => {
    external?.addEventListener(
      'abort',
      () => reject(new DriverError('E_CANCELED', '已取消')),
      { once: true },
    );
  });

  return Promise.race([externalPromise, start(controller.signal), timerPromise]).finally(() => {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    controller.abort();
  });
}

export type { Disposable };
