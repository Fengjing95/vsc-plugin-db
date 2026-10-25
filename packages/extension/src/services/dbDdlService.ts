import * as vscode from 'vscode';
import {
  DriverError,
  type DatabaseMeta,
  type DatabaseSpec,
  type DdlStatement,
  type DriverHost,
  type FormSchema,
  type IConnection,
  type IDatabaseDriver,
  type MetadataCache,
} from '@db-explorer/core';
import {
  DbDdlExecuteParamsSchema,
  DbDdlLoadParamsSchema,
  DbDdlPreviewParamsSchema,
  type DbDdlExecuteResult,
  type DbDdlLoadResult,
  type DbDdlPreviewResult,
} from '@db-explorer/protocol';
import type { ConnectionManager } from './connectionManager';
import { confirmNameMatch } from './ddlText';
import { t } from './i18n';
import { describeError, type Logger } from './logger';

/**
 * 库级 DDL 服务（M8-DBDDL，概要 D-19 / 交互稿 §8.3）：
 * - dbddl.load：create 态 spec=null / alter 态以 listDatabases 当前值预填；schema 来自
 *   驱动 getDatabaseFormSchema（未实现回落最小 name 字段）
 * - dbddl.preview / dbddl.execute **同源**：都经 buildStatements 重新调用驱动 builder，
 *   不信任 Webview 回传 SQL；执行逐条失败即停（DDL 隐式提交）；成功后
 *   invalidateConnection（库列表变更）+ 树刷新（§7.5 联动）
 * - 危险护栏（§5.8 延伸）：只读连接拒绝；alter 或任一 destructive → 确认（prod 输入库名）；
 *   树删库 → 输入库名匹配（prod 追加 Modal 分级）
 * 方法在 driver 层（懒连接树菜单同口径，方法存在性裁剪菜单与执行）。
 */

/** 回落最小表单（驱动未实现 getDatabaseFormSchema 时）；label = dbddl 域键（C-17/D-25 B3，webview formText 解析） */
const FALLBACK_FORM_SCHEMA: FormSchema = {
  fields: [{ key: 'name', label: 'dbddl.name', type: 'string', required: true }],
};

export class DbDdlService {
  private readonly host: DriverHost;

  constructor(
    private readonly deps: {
      connections: ConnectionManager;
      cache: MetadataCache;
      logger: Logger;
      /** 查询统一入口（LoggingDriverHost 拦截日志，extension 组装注入，概要 §5.10） */
      host: DriverHost;
      /** DDL 成功后联动树刷新（概要 §7.5） */
      refreshTree: () => void;
      timeoutMs: number;
    },
  ) {
    this.host = deps.host;
  }

  async load(raw: unknown): Promise<DbDdlLoadResult> {
    const p = DbDdlLoadParamsSchema.parse(raw);
    const { driver, conn } = await this.requireDbDdlConnection(p.connId, 'buildCreateDatabase');
    if (!driver.getDatabaseFormSchema && typeof driver.buildCreateDatabase !== 'function') {
      throw new DriverError('E_UNSUPPORTED', t('当前驱动不支持新建库'));
    }
    let spec: DatabaseSpec | null = null;
    if (p.kind === 'alter') {
      const current = await this.currentMetaOf(conn, p.db);
      spec = { name: current.name, charset: current.charset, collation: current.collation };
    }
    return {
      kind: p.kind,
      schema: driver.getDatabaseFormSchema?.() ?? FALLBACK_FORM_SCHEMA,
      spec,
      alterable: typeof driver.buildAlterDatabase === 'function',
    };
  }

  async preview(raw: unknown): Promise<DbDdlPreviewResult> {
    const p = DbDdlPreviewParamsSchema.parse(raw);
    const { driver, conn } = await this.requireDbDdlConnection(p.connId, 'buildCreateDatabase');
    const statements = await this.buildStatements(driver, conn, p);
    // 预览载荷掩码（C-10 / D-23）：CREATE USER 的 IDENTIFIED BY "…" 在预览中掩码显示——
    // 预览文本可复制/截图，密码原文只随执行路径存在（同源生成，掩码仅作用于展示副本）
    return {
      statements: statements.map((s) => ({
        ...s,
        sql: s.sql.replace(/(IDENTIFIED BY\s+)"[^"]*"/gi, '$1"●●●●●●"'),
      })),
    };
  }

  async execute(raw: unknown): Promise<DbDdlExecuteResult> {
    const p = DbDdlExecuteParamsSchema.parse(raw);
    const cfg = this.deps.connections.getConfig(p.connId);
    if (!cfg) {
      throw new DriverError('E_NOT_FOUND', t('连接不存在或已删除'));
    }
    if (cfg.readOnly) {
      throw new DriverError('E_READONLY', t('只读连接，库级操作被拒绝'));
    }
    const { driver, conn } = await this.requireDbDdlConnection(p.connId, 'buildCreateDatabase');
    const statements = await this.buildStatements(driver, conn, p);
    if (statements.length === 0) {
      return { executed: 0 }; // 无差异（UI 提示「无变更」）
    }
    // 危险确认（交互稿 §8.3）：alter 或任一 destructive → 确认；prod 输入库名
    if (p.kind === 'alter' || statements.some((s) => s.destructive)) {
      const ok = await this.confirmDdl(p.connId, p.spec.name, p.kind, statements);
      if (!ok) {
        throw new DriverError('E_CANCELED', t('已取消执行'));
      }
    }
    let executed = 0;
    const started = Date.now();
    for (let i = 0; i < statements.length; i++) {
      try {
        await this.host.query(
          conn,
          { sql: statements[i].sql, maxRows: 1, timeoutMs: this.deps.timeoutMs },
        );
      } catch (err) {
        const code = DriverError.is(err) ? err.code : 'E_INTERNAL';
        const message = err instanceof Error ? err.message : String(err);
        this.deps.logger.error(
          'dbddl',
          `${p.connId} 库 "${p.spec.name}" 第 ${i + 1}/${statements.length} 条失败：${code} ${message}`,
        );
        return { executed, failed: { index: i + 1, code, message } };
      }
      executed++;
    }
    this.deps.logger.info(
      'dbddl',
      `${p.connId} 库 "${p.spec.name}" ${p.kind} 完成：${executed} 条语句（${Date.now() - started}ms）`,
    );
    // §7.5 失效联动：库列表变更 → 失效连接级缓存 + 树刷新
    this.deps.cache.invalidateConnection(p.connId);
    this.deps.refreshTree();
    return { executed };
  }

  /** 树操作：删除库（交互稿 §8.3：输入库名匹配；prod 追加 Modal 分级；CASCADE 连带明示） */
  async dropDatabase(connId: string, db: string): Promise<boolean> {
    const cfg = this.deps.connections.getConfig(connId);
    if (!cfg) {
      throw new DriverError('E_NOT_FOUND', t('连接不存在或已删除'));
    }
    if (cfg.readOnly) {
      throw new DriverError('E_READONLY', t('只读连接，库级操作被拒绝'));
    }
    const driver = this.deps.connections.getDriver(connId);
    if (!driver || typeof driver.buildDropDatabase !== 'function') {
      throw new DriverError('E_UNSUPPORTED', t('当前驱动不支持删除库'));
    }
    if (!confirmNameMatch(db, await this.promptText(db))) {
      return false;
    }
    if ((cfg.env ?? null) === 'prod') {
      // 按钮回执比较：构造与比较共用同一 const（C-17 迁移规则 3）
      const delLabel = t('删除');
      const pick = await vscode.window.showWarningMessage(
        t('即将删除生产库 "{0}"（可能连带其下全部数据）。此操作不可撤销', [db]),
        { modal: true },
        delLabel,
      );
      if (pick !== delLabel) {
        return false;
      }
    }
    const conn = await this.deps.connections.ensureConnected(connId);
    const statements = await driver.buildDropDatabase(db);
    this.deps.logger.info('dbddl', `${connId} 删除库 "${db}"（${statements.length} 条语句）`);
    const started = Date.now();
    for (const s of statements) {
      try {
        await this.host.query(conn, { sql: s.sql, maxRows: 1, timeoutMs: this.deps.timeoutMs });
      } catch (err) {
        this.deps.logger.error('dbddl', `${connId} 删除库 "${db}" 失败：${describeError(err)}`);
        throw err;
      }
    }
    this.deps.logger.info('dbddl', `${connId} 删除库 "${db}" 完成（${Date.now() - started}ms）`);
    this.deps.cache.invalidateConnection(connId);
    this.deps.refreshTree();
    void vscode.window.showInformationMessage(t('库 "{0}" 已删除', [db]));
    return true;
  }

  // ── 内部 ─────────────────────────────────────────────────

  private async requireDbDdlConnection(
    connId: string,
    probe: 'buildCreateDatabase',
  ): Promise<{ driver: IDatabaseDriver; conn: IConnection }> {
    const driver = this.deps.connections.getDriver(connId);
    if (!driver) {
      throw new DriverError('E_NOT_FOUND', t('驱动未注册'));
    }
    const conn = await this.deps.connections.ensureConnected(connId);
    if (probe === 'buildCreateDatabase' && typeof driver.buildCreateDatabase !== 'function') {
      throw new DriverError('E_UNSUPPORTED', t('当前驱动不支持新建库'));
    }
    return { driver, conn };
  }

  private async currentMetaOf(conn: IConnection, db: string | undefined): Promise<DatabaseMeta> {
    if (!db) {
      throw new DriverError('E_VALIDATION', t('编辑库缺少目标库名'));
    }
    const dbs = await conn.listDatabases();
    const current = dbs.find((d) => d.name === db);
    if (!current) {
      throw new DriverError('E_NOT_FOUND', t('库 "{0}" 不存在（可能已被删除，请刷新后重试）', [db]));
    }
    return current;
  }

  /** 预览/执行同源：都经驱动 builder 现场生成（不信任 Webview 回传 SQL） */
  private async buildStatements(
    driver: IDatabaseDriver,
    _conn: IConnection,
    p: { kind: 'create' | 'alter'; db?: string; spec: DatabaseSpec },
  ): Promise<DdlStatement[]> {
    if (p.kind === 'create') {
      if (typeof driver.buildCreateDatabase !== 'function') {
        throw new DriverError('E_UNSUPPORTED', t('当前驱动不支持新建库'));
      }
      return driver.buildCreateDatabase(p.spec);
    }
    if (typeof driver.buildAlterDatabase !== 'function') {
      throw new DriverError('E_UNSUPPORTED', t('当前驱动不支持编辑库'));
    }
    const current = await this.currentMetaOf(_conn, p.db);
    return driver.buildAlterDatabase(current.name, p.spec, current);
  }

  private async promptText(db: string): Promise<string | undefined> {
    return vscode.window.showInputBox({
      title: t('删除库确认'),
      prompt: t('即将删除库 "{0}"（可能连带其下全部数据）。此操作不可撤销，请输入库名以确认', [db]),
      placeHolder: db,
      ignoreFocusOut: true,
    });
  }

  private async confirmDdl(
    connId: string,
    db: string,
    kind: 'create' | 'alter',
    statements: DdlStatement[],
  ): Promise<boolean> {
    const env = this.deps.connections.getConfig(connId)?.env ?? null;
    const destructive = statements.filter((s) => s.destructive);
    if (env === 'prod') {
      const input = await vscode.window.showInputBox({
        title: t('生产环境库级变更确认'),
        prompt: t('即将对生产库 "{0}" 执行 {1} 条语句（其中 {2} 条可能造成数据丢失）。请输入库名以确认', [
          db,
          statements.length,
          destructive.length,
        ]),
        placeHolder: db,
        ignoreFocusOut: true,
      });
      return input?.trim() === db;
    }
    // 条件拼接句拆完整句键（C-17 迁移规则 4）；按钮回执构造与比较共用同一 const（规则 3）
    const kindLabel = kind === 'create' ? t('新建库') : t('编辑库');
    const message =
      destructive.length > 0
        ? t('{0}：{1}（{2} 条语句，{3} 条可能造成数据丢失）', [kindLabel, db, statements.length, destructive.length])
        : t('{0}：{1}（{2} 条语句）', [kindLabel, db, statements.length]);
    const execLabel = t('执行');
    const pick = await vscode.window.showWarningMessage(
      message,
      { modal: true, detail: statements.map((s) => s.sql).join('\n\n').slice(0, 2000) },
      execLabel,
    );
    return pick === execLabel;
  }
}
