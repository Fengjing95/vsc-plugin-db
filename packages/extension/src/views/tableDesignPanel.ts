import * as vscode from 'vscode';
import { RpcMethods } from '@db-explorer/protocol';
import { attachRpcHost } from '../rpc/rpcHost';
import { buildWebviewHtml, webviewDistRoot } from './webviewHtml';
import type { DdlService } from '../services/ddlService';
import type { Logger } from '../services/logger';

/**
 * 表结构编辑器面板（M8-B2，概要 §5.9 / 交互稿 §12）：
 * 新建表（obj 缺省）与修改表结构（obj 提供预载基线）共用同一页面；语句生成/执行
 * 经 ddl.* RPC 走 DdlService（预览与执行同源，Host 不信任回传 SQL）。
 * 未保存关闭确认在 Webview 侧（§12.2），Host 只负责面板生命周期。
 */

export interface TableDesignPanelDeps {
  ddl: DdlService;
  logger: Logger;
}

const panels = new Map<string, vscode.WebviewPanel>();

export function openTableDesignPanel(
  context: vscode.ExtensionContext,
  deps: TableDesignPanelDeps,
  target: { connId: string; db: string; obj?: string; focusColumn?: string; appendColumn?: boolean },
): void {
  const viewId = `tableDesign:${target.connId}/${target.db}/${target.obj ?? ':new'}`;
  const existing = panels.get(viewId);
  if (existing) {
    void existing.reveal();
    return;
  }
  const title = target.obj ? `设计表 · ${target.obj} @ ${target.db}` : `新建表 @ ${target.db}`;
  const panel = vscode.window.createWebviewPanel(
    'dbExplorer.tableDesign',
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
    page: 'tableDesign',
    viewId,
    params: {
      connId: target.connId,
      db: target.db,
      obj: target.obj ?? '',
      focusColumn: target.focusColumn ?? '',
      appendColumn: target.appendColumn ? 'true' : '',
    },
  });

  attachRpcHost(panel.webview, {
    viewId,
    params: { connId: target.connId, db: target.db, obj: target.obj ?? '' },
    logger: deps.logger,
    handlers: {
      [RpcMethods.ddlLoad]: (raw) => deps.ddl.load(raw),
      [RpcMethods.ddlRefTables]: (raw) => deps.ddl.refTables(raw),
      [RpcMethods.ddlRefColumns]: (raw) => deps.ddl.refColumns(raw),
      [RpcMethods.ddlPreview]: (raw) => deps.ddl.preview(raw),
      [RpcMethods.ddlExecute]: async (raw) => {
        const result = await deps.ddl.execute(raw);
        // 成功（无 failed）自动关闭编辑器（交互稿 §12.2：成功后关面板 + 树已刷新）
        if (!result.failed) {
          panel.dispose();
        }
        return result;
      },
      [RpcMethods.ddlClose]: () => {
        panel.dispose();
        return Promise.resolve({});
      },
    },
  });
}
