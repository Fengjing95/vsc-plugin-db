import * as vscode from 'vscode';
import { RpcMethods } from '@db-explorer/protocol';
import { attachRpcHost } from '../rpc/rpcHost';
import { buildWebviewHtml, webviewDistRoot } from './webviewHtml';
import type { AiSettingsStore } from '../services/aiSettings';
import type { SettingsHub } from '../services/settingsHub';

import type { Logger } from '../services/logger';
import { t } from '../services/i18n';

/**
 * 设置中心（交互稿 §16）：分类侧栏 + 内容区的总设置面板（AI 辅助 / 查询与导出 / 关于）。
 * 单例；深链 category 直达分类（AI 入口「去配置」引导 → ai）。
 * AI 密钥边界不变（ai.* RPC，SecretStorage）；代理编辑走 settings.*（白名单 fail-closed）。
 */

export type SettingsCategory = 'ai' | 'queryExport' | 'about';

let panel: vscode.WebviewPanel | undefined;

export function openSettingsPanel(
  context: vscode.ExtensionContext,
  deps: { settings: AiSettingsStore; hub: SettingsHub; logger: Logger },
  category?: SettingsCategory,
): void {
  if (panel) {
    void panel.reveal();
    return;
  }
  const viewId = 'settings';
  const created = vscode.window.createWebviewPanel(
    'dbExplorer.settings',
    t('设置'),
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
    page: 'settings',
    viewId,
    params: { category: category ?? '' },
  });

  attachRpcHost(created.webview, {
    viewId,
    params: {},
    logger: deps.logger,
    handlers: {
      [RpcMethods.aiGetSettings]: () => deps.settings.getSettings(),
      [RpcMethods.aiSaveSettings]: (raw) => deps.settings.saveSettings(raw),
      [RpcMethods.aiTestSettings]: (raw) => deps.settings.testSettings(raw),
      [RpcMethods.settingsGet]: () => Promise.resolve(deps.hub.getSettings()),
      [RpcMethods.settingsUpdate]: (raw) => {
        const p = raw as { key?: string; value?: unknown };
        return deps.hub.update(p.key as never, p.value).then(() => ({}));
      },
      [RpcMethods.settingsOpenInVscode]: (raw) => {
        const p = raw as { key?: string };
        // key 可缺省（缺省 = @ext: 扩展设置区域）
        return deps.hub
          .openInVscodeSettings(p.key === undefined ? undefined : (p.key as Parameters<SettingsHub['openInVscodeSettings']>[0]))
          .then(() => ({}));
      },
      [RpcMethods.settingsHubAction]: (raw) => {
        const p = raw as { action?: 'openLog' | 'openGitHub' | 'openIssues' | 'openWebsite' };
        return deps.hub.hubAction(p.action ?? 'openLog').then(() => ({}));
      },
    },
  });
}
