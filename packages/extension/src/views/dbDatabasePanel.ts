import * as vscode from 'vscode';
import { RpcMethods } from '@db-explorer/protocol';
import { attachRpcHost } from '../rpc/rpcHost';
import { buildWebviewHtml, webviewDistRoot } from './webviewHtml';
import type { DbDdlService } from '../services/dbDdlService';
import type { Logger } from '../services/logger';

/**
 * 库级 DDL 面板（M8-DBDDL，概要 D-19 / 交互稿 §8.3）：
 * 新建库（db 缺省）与编辑库（db 提供预载当前值）共用同一页面；语句生成/执行
 * 经 dbddl.* RPC 走 DbDdlService（预览与执行同源，Host 不信任回传 SQL）。
 * 面板为单例（同 connId/目标复用 reveal）；执行成功自动关闭 + 树已刷新。
 */

export interface DatabaseDesignPanelDeps {
  dbddl: DbDdlService;
  logger: Logger;
}

const panels = new Map<string, vscode.WebviewPanel>();

export function openDatabaseDesignPanel(
  context: vscode.ExtensionContext,
  deps: DatabaseDesignPanelDeps,
  target: { connId: string; db?: string; kind: 'create' | 'alter' },
): void {
  const viewId = `dbDesign:${target.connId}/${target.db ?? ':new'}`;
  const existing = panels.get(viewId);
  if (existing) {
    void existing.reveal();
    return;
  }
  const title = target.kind === 'alter' ? `编辑库 · ${target.db}` : '新建库';
  const panel = vscode.window.createWebviewPanel(
    'dbExplorer.databaseDesign',
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
    page: 'databaseDesign',
    viewId,
    params: {
      connId: target.connId,
      db: target.db ?? '',
      kind: target.kind,
    },
  });

  attachRpcHost(panel.webview, {
    viewId,
    params: { connId: target.connId, db: target.db ?? '', kind: target.kind },
    logger: deps.logger,
    handlers: {
      [RpcMethods.dbddlLoad]: (raw) => deps.dbddl.load(raw),
      [RpcMethods.dbddlPreview]: (raw) => deps.dbddl.preview(raw),
      [RpcMethods.dbddlExecute]: async (raw) => {
        const result = await deps.dbddl.execute(raw);
        // 成功（无 failed）自动关闭（交互稿 §8.3：成功后关面板 + 树已刷新）
        if (!result.failed) {
          panel.dispose();
        }
        return result;
      },
      [RpcMethods.dbddlClose]: () => {
        panel.dispose();
        return Promise.resolve({});
      },
    },
  });
}
