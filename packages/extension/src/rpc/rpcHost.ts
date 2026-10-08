import * as vscode from 'vscode';
import { DriverError, type EditOp, type InProcessDriverHost } from '@db-explorer/core';
import {
  ApplyChangesParamsSchema,
  ConsoleCancelParamsSchema,
  ConsoleCloseParamsSchema,
  ConsoleExecuteParamsSchema,
  ConsoleExportParamsSchema,
  ConsoleResolveBannerParamsSchema,
  ConsoleStateParamsSchema,
  CopyTextParamsSchema,  EditChangesParamsSchema,
  FetchRowsParamsSchema,
  GetDdlParamsSchema,
  HandshakeParamsSchema,
  PreviewChangesParamsSchema,
  RevertChangesParamsSchema,
  RPC_PROTOCOL_VERSION,
  RpcEvents,
  RpcMethods,
  RpcRequestSchema,
  type EditPermission,
  type RpcError,
} from '@db-explorer/protocol';
import type { ExportTaskRunner } from '../services/exportTasks';
import type { ConnectionManager } from '../services/connectionManager';
import type { ChangeSetService } from '@db-explorer/core';
import type { EditGuard, ViewStateStore } from '../services/editGuard';
import type { Logger } from '../services/logger';

/** M5 Console 面板方法门面（console.*，rpcHost 完成 zod 校验后调用） */
export interface ConsoleRpcFacade {
  getState(params: unknown): Promise<unknown>;
  execute(params: unknown): Promise<unknown>;
  cancel(params: unknown): Promise<unknown>;
  resolveBanner(params: unknown): Promise<unknown>;
  exportResult(params: unknown): Promise<unknown>;
  close(params: unknown): Promise<unknown>;
}

export interface RpcHostDeps {
  viewId: string;
  params: Record<string, string>;
  logger: Logger;
  connections?: ConnectionManager;
  host?: InProcessDriverHost;
  /** 表格导出（export.run / export.cancel），仅表格视图注入 */
  exporter?: ExportTaskRunner;
  /** 页面自有方法（conn.* 等），命中后优先于内置分发 */
  handlers?: Record<string, (params: unknown) => Promise<unknown>>;
  /** M4 表格编辑：ChangeSet 权威副本（ADR D-06），表格视图注入 */
  changesets?: ChangeSetService;
  /** 视图状态快照（崩溃恢复回放，概要设计 §5.4.5） */
  viewStates?: ViewStateStore;
  /** 编辑权限 + DangerGuard（Host 层 fail-closed，UI 置灰只是第一道防线） */
  editGuard?: EditGuard;
  /** 提交超时（变更集可能含上百条语句，比默认 15s 宽） */
  applyTimeoutMs?: number;
  /** M5 SQL Console 结果面板（console.* 方法） */
  console?: ConsoleRpcFacade;
}

/**
 * Webview ↔ Host RPC（概要设计 7.4）：
 * Host 侧 zod 严格校验请求；失败返回结构化 RpcError，不崩溃、不静默。
 */
export function attachRpcHost(webview: vscode.Webview, deps: RpcHostDeps): vscode.Disposable {
  const listener = webview.onDidReceiveMessage((data: unknown) => {
    void handle(data);
  });

  // ChangeSet 权威副本变化 → 推送计数（提交成功清空、跨端同步的统一信号）
  const unsubscribe = deps.changesets?.subscribe((viewId, _cs, counts) => {
    if (viewId === deps.viewId) {
      void webview.postMessage({ kind: 'evt', event: RpcEvents.changesetUpdated, payload: { counts } });
    }
  });

  return vscode.Disposable.from(listener, { dispose: () => unsubscribe?.() });

  async function handle(data: unknown): Promise<void> {
    let req;
    try {
      req = RpcRequestSchema.parse(data);
    } catch (err) {
      deps.logger.warn('rpc', `非法请求帧: ${String(err)}`);
      return;
    }

    const respond = (ok: boolean, body: { result?: unknown; error?: RpcError }): void => {
      void webview.postMessage({ kind: 'res', id: req.id, ok, ...body });
    };

    const tableDepsReady = (): boolean =>
      Boolean(deps.connections && deps.host && deps.changesets && deps.viewStates && deps.editGuard);

    const requireEditable = async (connId: string, db: string, obj: string): Promise<void> => {
      const permission = await deps.editGuard!.getPermission(connId, db, obj);
      if (!permission.enabled) {
        throw new DriverError('E_READONLY', permission.reason ?? '当前视图不可编辑');
      }
    };

    try {
      if (deps.handlers && req.method in deps.handlers) {
        respond(true, { result: await deps.handlers[req.method](req.params) });
        return;
      }

      switch (req.method) {
        case RpcMethods.handshake: {
          HandshakeParamsSchema.parse(req.params ?? {});
          let edit: EditPermission = { enabled: false, reason: '此视图不支持编辑' };
          if (
            deps.editGuard &&
            deps.changesets &&
            deps.params.connId &&
            deps.params.db &&
            deps.params.obj
          ) {
            try {
              edit = await deps.editGuard.getPermission(
                deps.params.connId,
                deps.params.db,
                deps.params.obj,
              );
            } catch (err) {
              deps.logger.warn('rpc', `编辑权限判定失败（视为只读）: ${String(err)}`);
              edit = { enabled: false, reason: '编辑权限判定失败，请刷新重试' };
            }
          }
          respond(true, {
            result: {
              protocolVersion: RPC_PROTOCOL_VERSION,
              viewId: deps.viewId,
              params: deps.params,
              changeSet: deps.changesets
                ? deps.changesets.snapshot(deps.viewId)
                : { inserts: [], updates: [], deletes: [] },
              uiState: deps.viewStates?.get(deps.viewId),
              edit,
              // 能力下行（registry 声明读取，不建连——懒连接 D-10）；驱动缺失时保守给 SQL 型默认
              capabilities: {
                supportsSQL: deps.connections?.getDriver(deps.params.connId)?.capabilities.supportsSQL ?? true,
                supportsDdl: deps.connections?.getDriver(deps.params.connId)?.capabilities.supportsDdl ?? false,
                pagination: deps.connections?.getDriver(deps.params.connId)?.capabilities.pagination,
              },
            },
          });
          return;
        }

        case RpcMethods.fetchRows: {
          if (tableDepsReady()) {
            try {
              const p = FetchRowsParamsSchema.parse(req.params);
              // core 保证 limit ≤ maxRows 配置（驱动开发规范 §4）
              const maxRows = vscode.workspace
                .getConfiguration('dbExplorer.query')
                .get<number>('maxRows', 1000);
              const conn = await deps.connections!.ensureConnected(p.connId);
              const rs = await deps.host!.fetchRows(conn, {
                db: p.db,
                obj: p.obj,
                limit: Math.min(p.limit, maxRows),
                offset: p.offset,
                // M7 cursor 透传：pagination=cursor 驱动的深页直取（opaque 游标）
                cursor: p.cursor,
                columns: p.columns,
                filters: p.filters,
                sorts: p.sorts,
                search: p.search,
                whereSql: p.whereSql,
                orderBySql: p.orderBySql,
              });
              respond(true, { result: rs });
            } catch (err) {
              // 用户手写 SQL 片段错误：除 webview toast 外，经全局通知呈现
              // （VSCode 通知可点击展开完整详情，满足“看报错详细信息”）
              if (err instanceof DriverError && err.code === 'E_VALIDATION') {
                void vscode.window.showErrorMessage(`筛选条件有误：${err.message}`);
              }
              throw err;
            }
            return;
          }
          break; // 缺依赖按“视图不支持”统一处理（与旧连接表单视图兼容）
        }

        // ── M4 表格编辑（权威副本在 Host，预览/提交不传 ChangeSet）──
        case RpcMethods.editChanges: {
          if (tableDepsReady()) {
            const p = EditChangesParamsSchema.parse(req.params);
            await requireEditable(p.connId, p.db, p.obj);
            for (const op of p.ops) {
              deps.changesets!.applyOp(deps.viewId, op as EditOp);
            }
            if (p.uiState) {
              deps.viewStates!.set(deps.viewId, p.uiState);
            }
            respond(true, { result: { counts: deps.changesets!.counts(deps.viewId) } });
            return;
          }
          break;
        }

        case RpcMethods.previewChanges: {
          if (tableDepsReady()) {
            const p = PreviewChangesParamsSchema.parse(req.params);
            await requireEditable(p.connId, p.db, p.obj);
            const cs = deps.changesets!.snapshot(deps.viewId);
            if (cs.inserts.length + cs.updates.length + cs.deletes.length === 0) {
              throw new DriverError('E_VALIDATION', '没有可提交的变更');
            }
            const conn = await deps.connections!.ensureConnected(p.connId);
            const items = await deps.host!.previewChanges(conn, p.db, p.obj, cs, {
              timeoutMs: deps.applyTimeoutMs ?? 30_000,
            });
            respond(true, { result: { items } });
            return;
          }
          break;
        }

        case RpcMethods.applyChanges: {
          if (tableDepsReady()) {
            const p = ApplyChangesParamsSchema.parse(req.params);
            await requireEditable(p.connId, p.db, p.obj);
            const cs = deps.changesets!.snapshot(deps.viewId);
            if (cs.inserts.length + cs.updates.length + cs.deletes.length === 0) {
              throw new DriverError('E_VALIDATION', '没有可提交的变更');
            }
            // DangerGuard（概要设计 §5.8）：prod 环境强制输入表名确认
            const confirmed = await deps.editGuard!.confirmApply(p.connId, p.obj);
            if (!confirmed) {
              throw new DriverError('E_CANCELED', '已取消提交（表名不匹配或已取消）');
            }
            const conn = await deps.connections!.ensureConnected(p.connId);
            try {
              const result = await deps.host!.applyChanges(conn, p.db, p.obj, cs, {
                timeoutMs: deps.applyTimeoutMs ?? 30_000,
              });
              deps.changesets!.clear(deps.viewId); // 成功清空权威副本（经事件同步 Webview）
              respond(true, { result });
            } catch (err) {
              // 错误行定位（驱动规范 §8-1）→ evt:row.error 高亮
              if (DriverError.is(err) && err.meta) {
                void webview.postMessage({
                  kind: 'evt',
                  event: RpcEvents.rowError,
                  payload: {
                    kind: err.meta.kind,
                    tempId: err.meta.tempId,
                    rowKey: err.meta.rowKey,
                    code: err.code,
                    message: err.message,
                  },
                });
              }
              throw err;
            }
            return;
          }
          break;
        }

        case RpcMethods.revertChanges: {
          if (deps.changesets) {
            const p = RevertChangesParamsSchema.parse(req.params);
            if (p.target.scope === 'all') {
              deps.changesets.clear(deps.viewId);
            } else if (p.target.scope === 'row') {
              deps.changesets.applyOp(deps.viewId, { op: 'revertRow', rowKey: p.target.rowKey });
            } else {
              deps.changesets.applyOp(deps.viewId, { op: 'removeRow', tempId: p.target.tempId });
            }
            respond(true, { result: { counts: deps.changesets.counts(deps.viewId) } });
            return;
          }
          break;
        }

        case RpcMethods.getDdl: {
          if (deps.connections) {
            const p = GetDdlParamsSchema.parse(req.params);
            const conn = await deps.connections.ensureConnected(p.connId);
            if (typeof conn.getDdl !== 'function') {
              throw new DriverError('E_UNSUPPORTED', '当前驱动未实现 DDL 查看');
            }
            respond(true, { result: { ddl: await conn.getDdl(p.db, p.obj) } });
            return;
          }
          break;
        }

        case RpcMethods.exportRun: {
          if (deps.exporter) {
            respond(true, { result: await deps.exporter.run(req.params) });
            return;
          }
          break;
        }

        case RpcMethods.exportCancel: {
          if (deps.exporter) {
            deps.exporter.cancel(req.params);
            respond(true, { result: {} });
            return;
          }
          break;
        }

        // ── M5 SQL Console（结果面板 Webview；执行结果经 evt:console.updated 推送）──
        case RpcMethods.consoleState: {
          if (deps.console) {
            const p = ConsoleStateParamsSchema.parse(req.params ?? {});
            respond(true, { result: await deps.console.getState(p.consoleId) });
            return;
          }
          break;
        }

        case RpcMethods.consoleExecute: {
          if (deps.console) {
            const p = ConsoleExecuteParamsSchema.parse(req.params);
            respond(true, { result: await deps.console.execute(p) });
            return;
          }
          break;
        }

        case RpcMethods.consoleCancel: {
          if (deps.console) {
            const p = ConsoleCancelParamsSchema.parse(req.params);
            respond(true, { result: await deps.console.cancel(p) });
            return;
          }
          break;
        }

        case RpcMethods.consoleResolveBanner: {
          if (deps.console) {
            const p = ConsoleResolveBannerParamsSchema.parse(req.params);
            respond(true, { result: await deps.console.resolveBanner(p) });
            return;
          }
          break;
        }

        case RpcMethods.consoleExport: {
          if (deps.console) {
            const p = ConsoleExportParamsSchema.parse(req.params);
            respond(true, { result: await deps.console.exportResult(p) });
            return;
          }
          break;
        }

        case RpcMethods.consoleClose: {
          if (deps.console) {
            const p = ConsoleCloseParamsSchema.parse(req.params ?? {});
            respond(true, { result: await deps.console.close(p) });
            return;
          }
          break;
        }

        case RpcMethods.copyText: {
          // 任意 webview 通用：剪贴板经 Host 写入（navigator.clipboard 在 webview 环境不可靠）
          const p = CopyTextParamsSchema.parse(req.params);
          await vscode.env.clipboard.writeText(p.text);
          respond(true, { result: { written: Buffer.byteLength(p.text) } });
          return;
        }
      }

      respond(false, {
        error: { code: 'E_UNKNOWN_METHOD', message: `当前视图不支持 "${req.method}"` },
      });
    } catch (err) {
      respond(false, { error: toRpcError(err) });
    }
  }
}

function toRpcError(err: unknown): RpcError {
  if (DriverError.is(err)) {
    return { code: err.code, message: err.message, detail: err.detail };
  }
  return {
    code: 'E_INTERNAL',
    message: '操作失败，详情见输出面板 "Database Explorer"',
    detail: String(err),
  };
}
