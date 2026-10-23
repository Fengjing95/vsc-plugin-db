import * as vscode from 'vscode';
import { type DriverHost } from '@db-explorer/core';
import { RpcMethods } from '@db-explorer/protocol';
import { attachRpcHost } from '../rpc/rpcHost';
import { buildWebviewHtml, webviewDistRoot } from './webviewHtml';
import type { ConnectionManager } from '../services/connectionManager';
import type { ConsoleService } from '../services/consoleService';
import type { AiAssistService } from '../services/aiAssistService';
import { describeError, type Logger } from '../services/logger';

/**
 * Console 结果视图（M5 试点：底部面板形态，D-02 备选位置）：
 * `contributes.views["panel"]` 单例 WebviewView，与终端/输出并列；
 * 所有 Console 共享，跟随最近执行的 Console（evt:console.activated 切换）。
 * 执行后经 `<viewId>.focus` 激活显示（交互反馈同编辑器面板版）。
 */

export const CONSOLE_RESULT_VIEW_ID = 'dbExplorer.consoleResult';

export interface ConsolePanelDeps {
  connections: ConnectionManager;
  logger: Logger;
  /** 查询统一入口（LoggingDriverHost，extension 组装注入） */
  host: DriverHost;
  console: ConsoleService;
  /** M9-AI（D-24）：错误修复建议（ai.fixError / ai.applyFix）与「去配置」引导 */
  ai?: AiAssistService;
}

let resultView: vscode.WebviewView | undefined;

/** 注册底部面板结果视图（extension 激活时调用一次） */
export function registerConsoleResultView(context: vscode.ExtensionContext, deps: ConsolePanelDeps): vscode.Disposable {
  const provider: vscode.WebviewViewProvider = {
    resolveWebviewView(view: vscode.WebviewView): void {
      resultView = view;
      view.webview.options = {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.file(webviewDistRoot(context.extensionUri))],
      };
      // consoleId 留空：Host 解析为「最近执行的 Console」（单例视图引导路径）
      view.webview.html = buildWebviewHtml(view.webview, context.extensionUri, {
        page: 'console',
        viewId: CONSOLE_RESULT_VIEW_ID,
        params: { consoleId: '' },
      });

      const consoleIdOf = (params: unknown): string => {
        const id = (params as { consoleId?: unknown } | undefined)?.consoleId;
        return typeof id === 'string' && id ? id : '';
      };
      const ai = deps.ai;
      attachRpcHost(view.webview, {
        viewId: CONSOLE_RESULT_VIEW_ID,
        params: {},
        connections: deps.connections,
        host: deps.host,
        logger: deps.logger,
        console: {
          getState: (params: unknown) => deps.console.getState(consoleIdOf(params)),
          execute: (params: unknown) => {
            const p = params as { consoleId?: string; sql?: string };
            return deps.console.executeSql(consoleIdOf(p) || '', String(p.sql ?? ''));
          },
          cancel: (params: unknown) => {
            deps.console.cancel(consoleIdOf(params));
            return Promise.resolve({});
          },
          resolveBanner: (params: unknown) => {
            const p = params as { consoleId?: string; bannerId?: string; action?: 'proceed' | 'cancel' };
            return deps.console
              .resolveBanner(consoleIdOf(p), String(p.bannerId ?? ''), p.action === 'proceed' ? 'proceed' : 'cancel')
              .then(() => ({}));
          },
          exportResult: (params: unknown) => {
            const p = params as { consoleId?: string; itemSeq?: number; format?: 'csv' | 'json' };
            return deps.console.exportResult(
              consoleIdOf(p),
              Number(p.itemSeq ?? 0),
              p.format === 'json' ? 'json' : 'csv',
            );
          },
          close: () => {
            // 底部面板形态：关闭 = 收起整个底部面板（下次执行自动再激活）
            void vscode.commands.executeCommand('workbench.action.closePanel');
            return Promise.resolve({});
          },
        },
        handlers: ai
          ? {
              [RpcMethods.aiFixError]: async (raw) => {
                const p = raw as { consoleId?: string; seq?: number };
                try {
                  return await ai.fixError(String(p.consoleId ?? ''), Number(p.seq ?? 0));
                } catch (err) {
                  deps.logger.error('ai', `AI 修复建议失败：${describeError(err)}`);
                  throw err;
                }
              },
              [RpcMethods.aiApplyFix]: async (raw) => {
                const p = raw as { fixId?: string; mode?: 'replace' | 'insert' };
                try {
                  return await ai.applyFix(String(p.fixId ?? ''), p.mode === 'insert' ? 'insert' : 'replace');
                } catch (err) {
                  deps.logger.error('ai', `AI 修复应用失败：${describeError(err)}`);
                  throw err;
                }
              },
              [RpcMethods.aiOpenSettings]: () => {
                ai.openSettings();
                return Promise.resolve({});
              },
              [RpcMethods.aiRetryExplain]: async (raw) => {
                const p = raw as { consoleId?: string };
                try {
                  return await ai.retryExplain(String(p.consoleId ?? ''));
                } catch (err) {
                  deps.logger.error('ai', `AI 解释重试失败：${describeError(err)}`);
                  throw err;
                }
              },
            }
          : undefined,
      });

      view.onDidDispose(() => {
        if (resultView === view) {
          resultView = undefined;
        }
      });
    },
  };

  return vscode.window.registerWebviewViewProvider(CONSOLE_RESULT_VIEW_ID, provider, {
    webviewOptions: { retainContextWhenHidden: true },
  });
}

/** 激活底部面板并聚焦结果视图（执行/横幅时调用） */
export function revealConsoleResultView(): void {
  void vscode.commands.executeCommand(`${CONSOLE_RESULT_VIEW_ID}.focus`);
}

/** Host → Webview evt 帧推送（视图未打开时丢弃，恢复依赖 getState 引导） */
export function pushToConsolePanel(_consoleId: string, frame: { event: string; payload: unknown }): void {
  if (resultView) {
    void resultView.webview.postMessage({ kind: 'evt', ...frame });
  }
}
