import {
  DriverError,
  type ApplyResult,
  type ChangeSet,
  type DriverHost,
  type FetchRowsHostRequest,
  type IConnection,
  type PreviewItem,
  type QueryHostRequest,
  type ResultSet,
} from '@db-explorer/core';
import { describeError, sqlDigest, type Logger } from './logger';

/**
 * 查询统一日志拦截（M8 优化，概要 §5.10）：DriverHost 装饰器——取数/执行/变更提交的
 * 统一收口（ADR D-05「core 调用驱动的统一入口」），一处包装全链路生效，驱动与契约零改动。
 * - 用户口径（v0.2.14）：fetchRows / query / applyChanges 全量 info；previewChanges
 *   高频且非实际执行 → debug；失败 error（DriverError code 可见）；E_CANCELED → info（主动取消非故障）
 * - connId 经 resolveConnId 回查（host 接口只有 conn 实例；懒连接缓存条目极小，线性查无碍）
 * - 事务内语句不经本类（SessionManager.execute 直连驱动 ISession），由 SessionManager 自行打点
 * - Console 的 run 汇总日志与本类粒度不同（批次级 vs 动作级），并存不冲突
 */
export class LoggingDriverHost implements DriverHost {
  constructor(
    private readonly inner: DriverHost,
    private readonly logger: Logger,
    private readonly resolveConnId: (conn: IConnection) => string | undefined,
  ) {}

  async fetchRows(
    conn: IConnection,
    req: FetchRowsHostRequest,
    options?: { signal?: AbortSignal },
  ): Promise<ResultSet> {
    const started = Date.now();
    try {
      const rs = await this.inner.fetchRows(conn, req, options);
      this.logger.info(
        'query',
        `${this.label(conn)}/${req.db}.${req.obj} 取数：offset=${req.offset ?? 0}，${rs.rowCount} 行（${Date.now() - started}ms）`,
      );
      return rs;
    } catch (err) {
      this.fail(`${this.label(conn)}/${req.db}.${req.obj} 取数`, started, err);
      throw err;
    }
  }

  async query(
    conn: IConnection,
    req: QueryHostRequest,
    options?: { signal?: AbortSignal },
  ): Promise<ResultSet[]> {
    const started = Date.now();
    const where = `${this.label(conn)}${req.db ? `/${req.db}` : ''}`;
    try {
      const sets = await this.inner.query(conn, req, options);
      const rows = sets.reduce((n, rs) => n + rs.rowCount, 0);
      this.logger.info(
        'query',
        `${where} 执行完成：${sets.length} 个结果集 / ${rows} 行（${Date.now() - started}ms）· ${sqlDigest(req.sql)}`,
      );
      return sets;
    } catch (err) {
      this.fail(`${where} 执行（${sqlDigest(req.sql)}）`, started, err);
      throw err;
    }
  }

  async previewChanges(
    conn: IConnection,
    db: string,
    obj: string,
    cs: ChangeSet,
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<PreviewItem[]> {
    const started = Date.now();
    try {
      const items = await this.inner.previewChanges(conn, db, obj, cs, options);
      this.logger.debug(
        'query',
        `${this.label(conn)}/${db}.${obj} 预览变更：${items.length} 条语句（${Date.now() - started}ms）`,
      );
      return items;
    } catch (err) {
      this.fail(`${this.label(conn)}/${db}.${obj} 预览变更`, started, err);
      throw err;
    }
  }

  async applyChanges(
    conn: IConnection,
    db: string,
    obj: string,
    cs: ChangeSet,
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<ApplyResult> {
    const started = Date.now();
    const scope = `${this.label(conn)}/${db}.${obj}`;
    try {
      const result = await this.inner.applyChanges(conn, db, obj, cs, options);
      this.logger.info(
        'query',
        `${scope} 提交变更：插${cs.inserts.length}/改${cs.updates.length}/删${cs.deletes.length} · ${result.items.length} 条语句（${Date.now() - started}ms）`,
      );
      return result;
    } catch (err) {
      this.fail(
        `${scope} 提交变更（插${cs.inserts.length}/改${cs.updates.length}/删${cs.deletes.length}）`,
        started,
        err,
      );
      throw err;
    }
  }

  /** 失败打点：E_CANCELED 是用户主动取消（info），其余按 error（DriverError code 可见） */
  private fail(action: string, started: number, err: unknown): void {
    const elapsed = Date.now() - started;
    if (DriverError.is(err) && err.code === 'E_CANCELED') {
      this.logger.info('query', `${action} 已取消（${elapsed}ms）`);
      return;
    }
    this.logger.error('query', `${action} 失败：${describeError(err)}（${elapsed}ms）`);
  }

  private label(conn: IConnection): string {
    return this.resolveConnId(conn) ?? 'unknown';
  }
}
