import * as vscode from 'vscode';
import { RpcMethods } from '@db-explorer/protocol';
import { attachRpcHost } from '../rpc/rpcHost';
import { buildWebviewHtml, webviewDistRoot } from './webviewHtml';
import type { AiSettingsStore } from '../services/aiSettings';
import type { Logger } from '../services/logger';

/**
 * AI 设置面板（M9-AI / D-24 / 交互稿 §15.1）：BYOK 配置单例面板
 * （endpoint/model 落 settings、密钥只进 SecretStorage——getSettings 只回 hasKey）。
 * 入口：树视图标题栏「AI 设置」按钮（「＋ 新建连接」右侧）与命令面板；三个 AI 入口
 * 未配置时的「去配置」引导也落到这里。
 */

let panel: vscode.WebviewPanel | undefined;

export function openAiSettingsPanel(
  context: vscode.ExtensionContext,
  deps: { settings: AiSettingsStore; logger: Logger },
): void {
  if (panel) {
    void panel.reveal();
    return;
  }
  const viewId = 'aiSettings';
  const created = vscode.window.createWebviewPanel(
    'dbExplorer.aiSettings',
    'AI 设置',
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.file(webviewDistRoot(context.extensionUri))],
    },
  );
  panel = created;
  created.onDidDispose(
    () => {
      if (panel === created) {
        panel = undefined;
      }
    },
    null,
    context.subscriptions,
  );

  created.webview.html = buildWebviewHtml(created.webview, context.extensionUri, {
    page: 'aiSettings',
    viewId,
    params: {},
  });

  attachRpcHost(created.webview, {
    viewId,
    params: {},
    logger: deps.logger,
    handlers: {
      [RpcMethods.aiGetSettings]: () => deps.settings.getSettings(),
      [RpcMethods.aiSaveSettings]: (raw) => deps.settings.saveSettings(raw),
      [RpcMethods.aiTestSettings]: (raw) => deps.settings.testSettings(raw),
    },
  });
}
