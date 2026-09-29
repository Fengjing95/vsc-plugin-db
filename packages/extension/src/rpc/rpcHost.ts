import * as vscode from 'vscode';
import { DriverError, type InProcessDriverHost } from '@db-explorer/core';
import {
  FetchRowsParamsSchema,
  HandshakeParamsSchema,
  RPC_PROTOCOL_VERSION,
  RpcMethods,
  RpcRequestSchema,
  type RpcError,
} from '@db-explorer/protocol';
import type { ResultExporter } from '../services/resultExporter';
import type { ConnectionManager } from '../services/connectionManager';

export interface RpcHostDeps {
  viewId: string;
  params: Record<string, string>;
  output: vscode.OutputChannel;
  connections?: ConnectionManager;
  host?: InProcessDriverHost;
  /** 表格导出（export.run / export.cancel），仅表格视图注入 */
  exporter?: ResultExporter;
  /** 页面自有方法（conn.* 等），命中后优先于内置分发 */
  handlers?: Record<string, (params: unknown) => Promise<unknown>>;
}

/**
 * Webview ↔ Host RPC（概要设计 7.4）：
 * Host 侧 zod 严格校验请求；失败返回结构化 RpcError，不崩溃、不静默。
 */
export function attachRpcHost(webview: vscode.Webview, deps: RpcHostDeps): vscode.Disposable {
  return webview.onDidReceiveMessage((data: unknown) => {
    void handle(data);
  });

  async function handle(data: unknown): Promise<void> {
    let req;
    try {
      req = RpcRequestSchema.parse(data);
    } catch (err) {
      deps.output.appendLine(`[rpc] 非法请求帧: ${String(err)}`);
      return;
    }

    const respond = (ok: boolean, body: { result?: unknown; error?: RpcError }): void => {
      void webview.postMessage({ kind: 'res', id: req.id, ok, ...body });
    };

    try {
      if (deps.handlers && req.method in deps.handlers) {
        respond(true, { result: await deps.handlers[req.method](req.params) });
        return;
      }

      switch (req.method) {
        case RpcMethods.handshake: {
          HandshakeParamsSchema.parse(req.params ?? {});
          respond(true, {
            result: {
              protocolVersion: RPC_PROTOCOL_VERSION,
              viewId: deps.viewId,
              params: deps.params,
              changeSet: { inserts: [], updates: [], deletes: [] },
            },
          });
          return;
        }

        case RpcMethods.fetchRows: {
          if (!deps.connections || !deps.host) {
            respond(false, {
              error: {
                code: 'E_UNKNOWN_METHOD',
                message: `当前视图不支持 "${req.method}"`,
              },
            });
            return;
          }
          const p = FetchRowsParamsSchema.parse(req.params);
          // core 保证 limit ≤ maxRows 配置（驱动开发规范 §4）
          const maxRows = vscode.workspace
            .getConfiguration('dbExplorer.query')
            .get<number>('maxRows', 1000);
          const conn = await deps.connections.ensureConnected(p.connId);
          const rs = await deps.host.fetchRows(conn, {
            db: p.db,
            obj: p.obj,
            limit: Math.min(p.limit, maxRows),
            offset: p.offset,
            columns: p.columns,
            filters: p.filters,
            sorts: p.sorts,
            search: p.search,
          });
          respond(true, { result: rs });
          return;
        }

        case RpcMethods.exportRun: {
          if (!deps.exporter) {
            respond(false, {
              error: { code: 'E_UNKNOWN_METHOD', message: `当前视图不支持 "${req.method}"` },
            });
            return;
          }
          respond(true, { result: await deps.exporter.run(req.params) });
          return;
        }

        case RpcMethods.exportCancel: {
          if (!deps.exporter) {
            respond(false, {
              error: { code: 'E_UNKNOWN_METHOD', message: `当前视图不支持 "${req.method}"` },
            });
            return;
          }
          deps.exporter.cancel(req.params);
          respond(true, { result: {} });
          return;
        }

        default:
          respond(false, {
            error: { code: 'E_UNKNOWN_METHOD', message: `未知方法 "${req.method}"` },
          });
      }
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
