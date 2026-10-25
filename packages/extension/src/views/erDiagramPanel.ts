import * as vscode from 'vscode';
import { ErOpenTableParamsSchema, RpcMethods } from '@db-explorer/protocol';
import type { ErGraphScope } from '@db-explorer/core';
import { attachRpcHost } from '../rpc/rpcHost';
import { buildWebviewHtml, webviewDistRoot } from './webviewHtml';
import type { ErService } from '../services/erService';
import { t } from '../services/i18n';
import type { Logger } from '../services/logger';

/**
 * ER 图面板（M8-ER，概要 §5.11 / 交互稿 §13）：
 * 库级单例（erDiagram:<connId>/<db> 去重复用 reveal）。关系收集与布局经 er.* RPC 走
 * ErService（Host 计算，C-13）；节点双击打开表格视图复用 openTablePanel 链路（回调注入，
 * 避免 views 循环依赖）。ER 图无未提交状态，面板关闭无确认（Host 只管生命周期）。
 */

export interface ErDiagramPanelDeps {
  er: ErService;
  logger: Logger;
  /** 节点双击 → 打开表格视图（commands.ts 注入：openTablePanel + store 的 readOnly/env 组装） */
  openTable: (target: { connId: string; db: string; table: string }) => Promise<void>;
}

const panels = new Map<string, vscode.WebviewPanel>();

export function openErDiagramPanel(
  context: vscode.ExtensionContext,
  deps: ErDiagramPanelDeps,
  target: { connId: string; db: string; scope: ErGraphScope },
): void {
  const viewId = `erDiagram:${target.connId}/${target.db}`;
  const existing = panels.get(viewId);
  if (existing) {
    void existing.reveal();
    return;
  }
  const title = t('ER 图 · {0}', [target.db]);
  const panel = vscode.window.createWebviewPanel(
    'dbExplorer.erDiagram',
    title,
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.file(webviewDistRoot(context.extensionUri))],
    },
  );
  panels.set(viewId, panel);
  panel.onDidDispose(
    () => {
      panels.delete(viewId);
    },
    null,
    context.subscriptions,
  );

  panel.webview.html = buildWebviewHtml(panel.webview, context.extensionUri, {
    page: 'erDiagram',
    viewId,
    params: {
      connId: target.connId,
      db: target.db,
      scope: JSON.stringify(target.scope),
    },
  });

  attachRpcHost(panel.webview, {
    viewId,
    params: { connId: target.connId, db: target.db },
    logger: deps.logger,
    handlers: {
      [RpcMethods.erGraph]: (raw) => deps.er.load(raw),
      [RpcMethods.erOpenTable]: async (raw) => {
        const p = ErOpenTableParamsSchema.parse(raw);
        await deps.openTable({ connId: p.connId, db: p.db, table: p.table });
        return {};
      },
    },
  });
}
