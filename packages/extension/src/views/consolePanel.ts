import * as vscode from 'vscode';
import { InProcessDriverHost } from '@db-explorer/core';
import { attachRpcHost } from '../rpc/rpcHost';
import { buildWebviewHtml, webviewDistRoot } from './webviewHtml';
import type { ConnectionManager } from '../services/connectionManager';
import type { ConsoleService } from '../services/consoleService';

/**
 * Console 结果面板（D-02：原生编辑器 + 独立结果 Webview）：
 * 每个 Console（consoleId）一个面板，未打开时在当前编辑组右侧打开，已打开则复用（§7.2）。
 * 面板 RPC：console.*（取态/执行/取消/横幅确认/导出/关闭），执行结果经 evt 推送。
 */

const panels = new Map<string, vscode.WebviewPanel>();

export interface ConsolePanelDeps {
  connections: ConnectionManager;
  output: vscode.OutputChannel;
  console: ConsoleService;
}

export function ensureConsolePanel(
  context: vscode.ExtensionContext,
  deps: ConsolePanelDeps,
  state: { consoleId: string; connId: string; db: string | null },
): vscode.WebviewPanel {
  const existing = panels.get(state.consoleId);
  if (existing) {
    void existing.reveal();
    return existing;
  }

  const cfgOf = deps.connections.getConfig(state.connId);
  const title = `${cfgOf?.name ?? state.connId}${state.db ? ` · ${state.db}` : ''}`;
  const panel = vscode.window.createWebviewPanel('dbExplorer.consoleResult', `SQL 结果 · ${title}`, vscode.ViewColumn.Beside, {
    enableScripts: true,
    retainContextWhenHidden: true,
    localResourceRoots: [vscode.Uri.file(webviewDistRoot(context.extensionUri))],
  });
  panels.set(state.consoleId, panel);
  panel.onDidDispose(
    () => {
      panels.delete(state.consoleId);
    },
    null,
    context.subscriptions,
  );

  panel.webview.html = buildWebviewHtml(panel.webview, context.extensionUri, {
    page: 'console',
    viewId: state.consoleId,
    params: { consoleId: state.consoleId },
  });

  const cfg = vscode.workspace.getConfiguration('dbExplorer');
  const consoleId = state.consoleId;
  attachRpcHost(panel.webview, {
    viewId: consoleId,
    params: { consoleId },
    connections: deps.connections,
    host: new InProcessDriverHost(cfg.get('query.timeoutMs', 15_000)),
    output: deps.output,
    console: {
      getState: (params: unknown) =>
        deps.console.getState(consoleIdOf(params, consoleId)),
      execute: (params: unknown) => {
        const p = params as { sql?: string };
        return deps.console.executeSql(consoleIdOf(params, consoleId), String(p.sql ?? ''));
      },
      cancel: (params: unknown) => {
        deps.console.cancel(consoleIdOf(params, consoleId));
        return Promise.resolve({});
      },
      resolveBanner: (params: unknown) => {
        const p = params as { bannerId?: string; action?: 'proceed' | 'cancel' };
        return deps.console
          .resolveBanner(
            consoleIdOf(params, consoleId),
            String(p.bannerId ?? ''),
            p.action === 'proceed' ? 'proceed' : 'cancel',
          )
          .then(() => ({}));
      },
      exportResult: (params: unknown) => {
        const p = params as { itemSeq?: number; format?: 'csv' | 'json' };
        return deps.console.exportResult(
          consoleIdOf(params, consoleId),
          Number(p.itemSeq ?? 0),
          p.format === 'json' ? 'json' : 'csv',
        );
      },
      close: (params: unknown) => {
        panels.get(consoleIdOf(params, consoleId))?.dispose();
        return Promise.resolve({});
      },
    },
  });
  return panel;
}

function consoleIdOf(params: unknown, fallback: string): string {
  const id = (params as { consoleId?: unknown } | undefined)?.consoleId;
  return typeof id === 'string' && id ? id : fallback;
}

/** 执行结果推送（Host → Webview evt 帧） */
export function pushToConsolePanel(consoleId: string, frame: { event: string; payload: unknown }): void {
  const panel = panels.get(consoleId);
  if (panel) {
    void panel.webview.postMessage({ kind: 'evt', ...frame });
  }
}

/** 关闭指定 Console 面板；无参时关闭全部（服务 dispose 用） */
export function disposeConsolePanelsFor(consoleId?: string): void {
  for (const [id, panel] of [...panels]) {
    if (!consoleId || id === consoleId) {
      panels.delete(id);
      panel.dispose();
    }
  }
}
