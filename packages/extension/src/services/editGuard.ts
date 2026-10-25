import * as vscode from 'vscode';
import {
  DriverError,
  assessMongoCommand,
  assessRedisCommand,
  assessStatementDanger,
  isProvablyReadMongoCommand,
  isProvablyReadRedisCommand,
  isReadStatement,
  type DangerAssessment,
} from '@db-explorer/core';
import type { EditPermission, ViewUiState } from '@db-explorer/protocol';
import type { ConnectionManager } from './connectionManager';
import { t } from './i18n';
import type { Logger } from './logger';
import type { MetadataCache } from '@db-explorer/core';

/**
 * M4 表格编辑护栏 + M5 Console 危险判定（概要设计 §5.8 / D-03）：
 * - getPermission：编辑权限判定（Host 层 fail-closed——UI 置灰只是第一道防线）
 * - confirmApply：DangerGuard 检测点「表格变更提交」——prod 环境强制输入表名确认
 * - assessDanger：DangerGuard 检测点「Console 语句」——无 WHERE 的 UPDATE/DELETE、
 *   DROP、TRUNCATE、ALTER…DROP（AST + 正则降级），供 Console 横幅/Modal 使用
 * - assertReadable：只读连接 fail-closed——无法证明语句是读一律拒绝（E_READONLY）
 * - M6（驱动规范 §5.3）：supportsSQL=false 的命令控制台走同构的命令白名单版本
 *   assessCommandDanger / assertCommandsReadable（core redisCommands），复用同一横幅流程
 * 判定与确认集中在本服务，避免各处自建。
 */
export class EditGuard {
  private readonly permissions = new Map<string, EditPermission>();

  constructor(
    private readonly connections: ConnectionManager,
    private readonly cache: MetadataCache,
    private readonly logger: Logger,
  ) {}

  /** 编辑权限（面板生命周期内缓存；改驱动/设置/表结构后重开视图生效） */
  async getPermission(connId: string, db: string, obj: string): Promise<EditPermission> {
    const key = `${connId}/${db}/${obj}`;
    const cached = this.permissions.get(key);
    if (cached) {
      return cached;
    }
    const permission = await this.compute(connId, db, obj);
    this.permissions.set(key, permission);
    return permission;
  }

  /** M5：单条语句危险判定（Console 执行前逐条调用；横幅/Modal 的依据） */
  assessDanger(sql: string, dialectId?: string): DangerAssessment {
    const assessment = assessStatementDanger(sql, dialectId);
    if (assessment.dangerous) {
      this.logger.info(
        'dangerGuard',
        `危险语句判定：${assessment.reasons.join('；')}${assessment.parseFailed ? '（正则降级）' : ''}`,
      );
    }
    return assessment;
  }

  /** M5：只读连接 fail-closed（概要 §5.8）：任一语句无法证明为读 → E_READONLY */
  assertReadable(statements: string[], dialectId?: string): void {
    for (const sql of statements) {
      if (!isReadStatement(sql, dialectId)) {
        this.logger.warn('dangerGuard', '只读连接拒绝非读语句（fail-closed）');
        throw new DriverError('E_READONLY', t('连接已开启只读保护，仅允许查询语句'));
      }
    }
  }

  /** M6：命令危险判定（core 命令白名单，驱动规范 §5.3/§5.5；横幅/Modal 与 SQL 同构）。
   *  M8-Mongo：supportsSQL=false 的命令域按驱动选择白名单（redis / mongo） */
  assessCommandDanger(commandText: string, commandFlavor: 'redis' | 'mongo' = 'redis'): DangerAssessment {
    const a =
      commandFlavor === 'mongo' ? assessMongoCommand(commandText) : assessRedisCommand(commandText);
    const assessment: DangerAssessment = {
      dangerous: a.dangerous,
      reasons: a.reasons,
      parseFailed: a.unparseable,
    };
    if (assessment.dangerous) {
      this.logger.info('dangerGuard', `危险命令判定：${assessment.reasons.join('；')}`);
    }
    return assessment;
  }

  /** M6：只读连接命令白名单 fail-closed（§5.3/§5.5）：不可证明为读 → E_READONLY */
  assertCommandsReadable(commands: string[], commandFlavor: 'redis' | 'mongo' = 'redis'): void {
    for (const command of commands) {
      const readable =
        commandFlavor === 'mongo'
          ? isProvablyReadMongoCommand(command)
          : isProvablyReadRedisCommand(command);
      if (!readable) {
        this.logger.warn('dangerGuard', '只读连接拒绝非读命令（fail-closed）');
        throw new DriverError('E_READONLY', t('连接已开启只读保护，仅允许读命令'));
      }
    }
  }

  private async compute(connId: string, db: string, obj: string): Promise<EditPermission> {
    const cfg = this.connections.getConfig(connId);
    if (!cfg) {
      return { enabled: false, reason: t('连接不存在') };
    }
    if (cfg.readOnly) {
      return { enabled: false, reason: t('连接已开启只读保护') };
    }
    const driver = this.connections.getDriver(connId);
    if (!driver) {
      return { enabled: false, reason: t('驱动未注册') };
    }
    if (!driver.capabilities.editable) {
      return { enabled: false, reason: t('当前驱动不支持表格编辑') };
    }
    const conn = await this.connections.ensureConnected(connId);
    const columns = await this.cache.getColumns(connId, db, obj, () => conn.listColumns(db, obj));
    const pkCols = columns.filter((c) => c.isPrimaryKey);
    if (pkCols.length === 0) {
      // D-03：无主键表默认只读；开启全列匹配模式后仍禁含二进制列的表
      const allow = vscode.workspace
        .getConfiguration('dbExplorer.edit')
        .get<boolean>('allowNoPrimaryKey', false);
      if (!allow) {
        return { enabled: false, reason: t('无主键表默认只读（可在设置开启"全列匹配"后编辑）') };
      }
      if (columns.some((c) => c.normalizedType === 'binary')) {
        return { enabled: false, reason: t('含二进制列的无主键表不可编辑（D-03）') };
      }
      return {
        enabled: true,
        reason: t('无主键表：全列匹配模式（WHERE 含全部列原值，请谨慎编辑）'),
      };
    }
    return { enabled: true };
  }

  /** DangerGuard（概要设计 §5.8）：prod 环境提交前强制输入表名，完全匹配才放行 */
  async confirmApply(connId: string, obj: string): Promise<boolean> {
    const env = this.connections.getConfig(connId)?.env ?? null;
    if (env !== 'prod') {
      return true;
    }
    const input = await vscode.window.showInputBox({
      title: t('生产环境提交确认'),
      prompt: t('即将向生产表 "{0}" 提交变更，此操作将直接修改生产数据。请输入表名以确认', [obj]),
      placeHolder: obj,
      ignoreFocusOut: true,
    });
    const matched = (input ?? '').trim() === obj;
    if (!matched) {
      this.logger.warn('dangerGuard', 'prod 变更提交确认未通过（已拦截）');
    }
    return matched;
  }
}

/** 视图状态快照（概要设计 §5.4.5）：随编辑同步上行，Webview 重载后握手回放 */
export class ViewStateStore {
  private readonly states = new Map<string, ViewUiState>();

  set(viewId: string, state: ViewUiState): void {
    this.states.set(viewId, state);
  }

  get(viewId: string): ViewUiState | undefined {
    return this.states.get(viewId);
  }

  disposeView(viewId: string): void {
    this.states.delete(viewId);
  }
}
