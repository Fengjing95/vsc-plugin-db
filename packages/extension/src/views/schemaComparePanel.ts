import * as vscode from 'vscode';
import { RpcMethods } from '@db-explorer/protocol';
import { attachRpcHost } from '../rpc/rpcHost';
import { buildWebviewHtml, webviewDistRoot } from './webviewHtml';
import type { SchemaCompareService } from '../services/schemaCompareService';
import { t } from '../services/i18n';
import type { Logger } from '../services/logger';

/**
 * 表结构对比面板（ADR D-29 / 交互稿 §17）：同连接两库结构 diff 的只读展示。
 * 单例 per connId（同连接换库对比 → dispose 重开，§13.6 无未提交状态同口径）；
 * 数据经 compare.* RPC 走 SchemaCompareService（自省三件套 + core schemaDiff）。
 */

export interface SchemaComparePanelDeps {
  compare: SchemaCompareService;
  logger: Logger;
}

const panels = new Map<string, { panel: vscode.WebviewPanel; key: string }>();

export function openSchemaComparePanel(
  context: vscode.ExtensionContext,
  deps: SchemaComparePanelDeps,
  target: { connId: string; dbA: string; dbB: string },
): void {
  const viewId = `schemaCompare:${target.connId}`;
  const key = `${target.dbA}\u0000${target.dbB}`;
  const existing = panels.get(viewId);
  if (existing) {
    if (existing.key === key) {
      void existing.panel.reveal();
      return;
    }
    existing.panel.dispose();
  }
  const title = t('结构对比 · {0} ↔ {1}', [target.dbA, target.dbB]);
  const panel = vscode.window.createWebviewPanel(
    'dbExplorer.schemaCompare',
    title,
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.file(webviewDistRoot(context.extensionUri))],
    },
  );
  panels.set(viewId, { panel, key });
  panel.onDidDispose(
    () => {
      panels.delete(viewId);
    },
    null,
    context.subscriptions,
  );

  panel.webview.html = buildWebviewHtml(panel.webview, context.extensionUri, {
    page: 'schemaCompare',
    viewId,
    params: {
      connId: target.connId,
      dbA: target.dbA,
      dbB: target.dbB,
    },
  });

  attachRpcHost(panel.webview, {
    viewId,
    params: { connId: target.connId, dbA: target.dbA, dbB: target.dbB },
    logger: deps.logger,
    handlers: {
      [RpcMethods.compareList]: (raw) => deps.compare.list(raw),
      [RpcMethods.compareTable]: (raw) => deps.compare.table(raw),
    },
  });
}
