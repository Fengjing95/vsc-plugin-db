import * as vscode from 'vscode';
import {
  DriverError,
  InProcessDriverHost,
  specFromColumns,
  type DdlStatement,
  type IConnection,
  type MetadataCache,
  type TableSpec,
} from '@db-explorer/core';
import {
  DdlExecuteParamsSchema,
  DdlLoadParamsSchema,
  DdlPreviewParamsSchema,
  type DdlExecuteResult,
  type DdlLoadResult,
  type DdlPreviewResult,
} from '@db-explorer/protocol';
import type { ConnectionManager } from './connectionManager';
import { describeError, type Logger } from './logger';
import { confirmNameMatch, quoteWith } from './ddlText';

/**
 * 表结构编辑服务（M8-B2，概要 §5.9 / 交互稿 §12）：
 * - ddl.load：create 态空白 / alter 态实时派生基线（specFromColumns）
 * - ddl.preview / ddl.execute **同源**：都经 buildStatements 重新调用驱动 builder，
 *   不信任 Webview 回传 SQL；alter 的 current 在每次预览/执行前实时重拉（DDL 无乐观锁）
 * - 执行：逐条、失败即停并定位序号（DDL 隐式提交不回滚，UI 明示）；成功后
 *   invalidateDb + 树刷新（§7.5 DDL 失效联动）
 * - 危险护栏（§5.8 延伸）：alter 或任一 destructive → 确认（prod 输入表名）；
 *   删表/清空表树操作 → 输入名称匹配（§6）
 */

export class DdlService {
  private readonly host: InProcessDriverHost;

  constructor(
    private readonly deps: {
      connections: ConnectionManager;
      cache: MetadataCache;
      logger: Logger;
      /** DDL 成功后联动树刷新（概要 §7.5） */
      refreshTree: () => void;
      timeoutMs: number;
    },
  ) {
    this.host = new InProcessDriverHost(deps.timeoutMs);
  }

  async load(raw: unknown): Promise<DdlLoadResult> {
    const p = DdlLoadParamsSchema.parse(raw);
    const conn = await this.requireDdlConnection(p.connId);
    if (!p.obj) {
      return { kind: 'create', spec: null };
    }
    const metas = await conn.listColumns(p.db, p.obj);
    const comment = await this.tableCommentOf(conn, p.db, p.obj);
    return { kind: 'alter', spec: specFromColumns(p.obj, metas, comment) };
  }

  async preview(raw: unknown): Promise<DdlPreviewResult> {
    const p = DdlPreviewParamsSchema.parse(raw);
    const conn = await this.requireDdlConnection(p.connId);
    return this.buildStatements(conn, p);
  }

  async execute(raw: unknown): Promise<DdlExecuteResult> {
    const p = DdlExecuteParamsSchema.parse(raw);
    const cfg = this.deps.connections.getConfig(p.connId);
    if (!cfg) {
      throw new DriverError('E_NOT_FOUND', '连接不存在或已删除');
    }
    if (cfg.readOnly) {
      throw new DriverError('E_READONLY', '只读连接，表结构执行被拒绝');
    }
    const conn = await this.requireDdlConnection(p.connId);
    const { kind, statements } = await this.buildStatements(conn, p);
    if (statements.length === 0) {
      return { executed: 0 };
    }
    // 危险确认（交互稿 §12.2）：alter 或任一 destructive → 确认；prod 输入表名
    if (kind === 'alter' || statements.some((s) => s.destructive)) {
      const ok = await this.confirmDdl(p.connId, p.obj ?? p.spec.name, kind, statements);
      if (!ok) {
        throw new DriverError('E_CANCELED', '已取消执行');
      }
    }
    let executed = 0;
    const started = Date.now();
    for (let i = 0; i < statements.length; i++) {
      try {
        await this.host.query(
          conn,
          { sql: statements[i].sql, db: p.db, maxRows: 1, timeoutMs: this.deps.timeoutMs },
        );
      } catch (err) {
        // 失败即停：DDL 隐式提交，已执行语句不回滚——返回定位信息由 UI 明示中间态
        const code = DriverError.is(err) ? err.code : 'E_INTERNAL';
        const message = err instanceof Error ? err.message : String(err);
        this.deps.logger.error(
          'ddl',
          `${p.connId}/${p.db}.${p.obj ?? p.spec.name} 第 ${i + 1}/${statements.length} 条失败：${code} ${message}`,
        );
        return { executed, failed: { index: i + 1, code, message } };
      }
      executed++;
    }
    this.deps.logger.info(
      'ddl',
      `${p.connId}/${p.db}.${p.obj ?? p.spec.name} 完成：${executed} 条语句（${Date.now() - started}ms）`,
    );
    // §7.5 DDL 失效联动：失效该库元数据缓存 + 树刷新
    this.deps.cache.invalidateDb(p.connId, p.db);
    this.deps.refreshTree();
    return { executed };
  }

  /** 树操作：删除表（交互稿 §12 入口；§6 输入名称匹配确认） */
  async dropTable(connId: string, db: string, obj: string): Promise<boolean> {
    return this.runTreeDdl(connId, db, obj, '删除表', (q) => `DROP TABLE ${q(db)}.${q(obj)}`);
  }

  /** 树操作：清空表 */
  /** 树操作：删除列（交互稿 §12 修订：确认后直删，不经过表结构编辑器；
   *  语句经驱动 buildAlterTable 同源 diff 生成——自动处理删主键列需先 DROP PRIMARY KEY 的顺序） */
  async dropColumn(connId: string, db: string, obj: string, column: string): Promise<boolean> {
    const cfg = this.deps.connections.getConfig(connId);
    if (!cfg) {
      throw new DriverError('E_NOT_FOUND', '连接不存在或已删除');
    }
    if (cfg.readOnly) {
      throw new DriverError('E_READONLY', '只读连接，写操作被拒绝');
    }
    const conn = await this.requireDdlConnection(connId);
    const current = specFromColumns(obj, await conn.listColumns(db, obj));
    if (!current.columns.some((c) => c.name === column)) {
      throw new DriverError('E_NOT_FOUND', `列 "${column}" 不存在（表结构可能已变更，请刷新后重试）`);
    }
    const target: TableSpec = {
      ...current,
      columns: current.columns.filter((c) => c.name !== column),
    };
    const statements = await conn.buildAlterTable!(db, obj, target, current);
    if (statements.length === 0) {
      return false; // 无可执行语句（防御性：上方已确认列存在）
    }
    if (!confirmNameMatch(column, await this.promptText('删除列', column))) {
      return false;
    }
    this.deps.logger.info('ddl', `${connId}/${db}.${obj} 删除列 ${column}（${statements.length} 条语句）`);
    const started = Date.now();
    for (const s of statements) {
      try {
        await this.host.query(conn, { sql: s.sql, db, maxRows: 1, timeoutMs: this.deps.timeoutMs });
      } catch (err) {
        this.deps.logger.error('ddl', `${connId}/${db}.${obj} 删除列 ${column} 失败：${describeError(err)}`);
        throw err;
      }
    }
    this.deps.logger.info('ddl', `${connId}/${db}.${obj} 删除列 ${column} 完成（${Date.now() - started}ms）`);
    this.deps.cache.invalidateDb(connId, db);
    this.deps.refreshTree();
    void vscode.window.showInformationMessage(`列 "${column}" 已删除`);
    return true;
  }

  private async runTreeDdl(
    connId: string,
    db: string,
    obj: string,
    action: '删除表',
    buildSql: (quote: (n: string) => string) => string,
  ): Promise<boolean> {
    const cfg = this.deps.connections.getConfig(connId);
    if (!cfg) {
      throw new DriverError('E_NOT_FOUND', '连接不存在或已删除');
    }
    if (cfg.readOnly) {
      throw new DriverError('E_READONLY', '只读连接，写操作被拒绝');
    }
    if (!confirmNameMatch(obj, await this.promptText(action, obj))) {
      return false;
    }
    const conn = await this.deps.connections.ensureConnected(connId);
    const sql = buildSql((n) => quoteWith(conn, n));
    this.deps.logger.info('ddl', `${connId}/${db}.${obj} ${action}`);
    const started = Date.now();
    try {
      await this.host.query(conn, { sql, db, maxRows: 1, timeoutMs: this.deps.timeoutMs });
    } catch (err) {
      this.deps.logger.error('ddl', `${connId}/${db}.${obj} ${action}失败：${describeError(err)}`);
      throw err;
    }
    this.deps.logger.info('ddl', `${connId}/${db}.${obj} ${action}完成（${Date.now() - started}ms）`);
    this.deps.cache.invalidateDb(connId, db);
    this.deps.refreshTree();
    void vscode.window.showInformationMessage(`表 "${obj}" 已删除`);
    return true;
  } // ── 确认流（§6 / 交互稿 §12.2）────────────────────────────

  /** 树直操作确认文案（§6）：输入名称完全匹配才放行 */
  private async promptText(action: '删除表' | '删除列', name: string): Promise<string | undefined> {
    return vscode.window.showInputBox({
      title: `${action}确认`,
      prompt: `即将${action === '删除表' ? '删除表及其全部数据' : '删除该列及其数据'}："${name}"。此操作不可撤销，请输入${action === '删除表' ? '表名' : '列名'}以确认`,
      placeHolder: name,
      ignoreFocusOut: true,
    });
  }

  private async confirmDdl(
    connId: string,
    obj: string,
    kind: 'create' | 'alter',
    statements: DdlStatement[],
  ): Promise<boolean> {
    const env = this.deps.connections.getConfig(connId)?.env ?? null;
    const destructive = statements.filter((s) => s.destructive);
    if (env === 'prod') {
      const input = await vscode.window.showInputBox({
        title: '生产环境结构变更确认',
        prompt: `即将对生产表 "${obj}" 执行 ${statements.length} 条结构变更语句（其中 ${destructive.length} 条可能造成数据丢失）。请输入表名以确认`,
        placeHolder: obj,
        ignoreFocusOut: true,
      });
      return input?.trim() === obj;
    }
    const pick = await vscode.window.showWarningMessage(
      `${kind === 'create' ? '创建表' : '修改表结构'}：${obj}（${statements.length} 条语句${destructive.length > 0 ? `，${destructive.length} 条可能造成数据丢失` : ''}）`,
      { modal: true, detail: statements.map((s) => s.sql).join('\n\n').slice(0, 2000) },
      '执行',
    );
    return pick === '执行';
  }

  // ── 内部 ─────────────────────────────────────────────────

  private async requireDdlConnection(connId: string): Promise<IConnection> {
    const conn = await this.deps.connections.ensureConnected(connId);
    if (!conn.buildCreateTable || !conn.buildAlterTable) {
      throw new DriverError('E_UNSUPPORTED', '当前驱动不支持表结构编辑');
    }
    return conn;
  }

  /** 预览/执行同源：alter 的 current 每次实时重拉（不走缓存，防过期基线）；create 直接生成 */
  private async buildStatements(
    conn: IConnection,
    p: { connId: string; db: string; obj?: string; spec: TableSpec },
  ): Promise<DdlPreviewResult> {
    if (!p.obj) {
      return { kind: 'create', statements: await conn.buildCreateTable!(p.db, p.spec) };
    }
    const current = specFromColumns(p.obj, await conn.listColumns(p.db, p.obj));
    const statements = await conn.buildAlterTable!(p.db, p.obj, p.spec, current);
    return { kind: 'alter', statements };
  }

  private async tableCommentOf(conn: IConnection, db: string, obj: string): Promise<string | undefined> {
    try {
      const objs = await conn.listObjects(db);
      return objs.find((o) => o.name === obj)?.comment;
    } catch {
      return undefined; // 表注释仅展示用，取不到不阻塞
    }
  }
}

