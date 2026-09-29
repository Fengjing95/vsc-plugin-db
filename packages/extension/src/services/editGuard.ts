import * as vscode from 'vscode';
import type { EditPermission, ViewUiState } from '@db-explorer/protocol';
import type { ConnectionManager } from './connectionManager';
import type { MetadataCache } from '@db-explorer/core';

/**
 * M4 表格编辑护栏（概要设计 §5.8 / D-03）：
 * - getPermission：编辑权限判定（Host 层 fail-closed——UI 置灰只是第一道防线）
 * - confirmApply：DangerGuard 检测点「表格变更提交」——prod 环境强制输入表名确认，
 *   判定与确认集中在本服务，避免各处自建
 */
export class EditGuard {
  private readonly permissions = new Map<string, EditPermission>();

  constructor(
    private readonly connections: ConnectionManager,
    private readonly cache: MetadataCache,
    private readonly output: vscode.OutputChannel,
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

  private async compute(connId: string, db: string, obj: string): Promise<EditPermission> {
    const cfg = this.connections.getConfig(connId);
    if (!cfg) {
      return { enabled: false, reason: '连接不存在' };
    }
    if (cfg.readOnly) {
      return { enabled: false, reason: '连接已开启只读保护' };
    }
    const driver = this.connections.getDriver(connId);
    if (!driver) {
      return { enabled: false, reason: '驱动未注册' };
    }
    if (!driver.capabilities.editable) {
      return { enabled: false, reason: '当前驱动不支持表格编辑' };
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
        return { enabled: false, reason: '无主键表默认只读（可在设置开启"全列匹配"后编辑）' };
      }
      if (columns.some((c) => c.normalizedType === 'binary')) {
        return { enabled: false, reason: '含二进制列的无主键表不可编辑（D-03）' };
      }
      return {
        enabled: true,
        reason: '无主键表：全列匹配模式（WHERE 含全部列原值，请谨慎编辑）',
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
      title: '生产环境提交确认',
      prompt: `即将向生产表 "${obj}" 提交变更，此操作将直接修改生产数据。请输入表名以确认`,
      placeHolder: obj,
      ignoreFocusOut: true,
    });
    const matched = (input ?? '').trim() === obj;
    if (!matched) {
      this.output.appendLine(`[dangerGuard] prod 变更提交确认未通过（已拦截）`);
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
