/**
 * Webview 轻量 t()（D-25 / C-17）：vscode.l10n 在 webview bundle 内不可用——
 * 词典由 extension buildWebviewHtml 经 __BOOTSTRAP__.messages 注入（P-60 对象口径）；
 * 回落链 = 注入词典 → zh 词典 → key（缺 zh 键视为词表缺陷，console 告警）。
 * 域键词表单一来源 = @db-explorer/protocol（MessageKey 类型约束调用点）。
 */
import { interpolateMessage, zhMessages, type MessageKey } from '@db-explorer/protocol';

export { interpolateMessage };

export function t(key: MessageKey, args?: readonly (string | number)[]): string {
  const boot = typeof window !== 'undefined' ? window.__BOOTSTRAP__ : undefined;
  const raw = boot?.messages?.[key] ?? zhMessages[key];
  if (raw === undefined) {
    console.warn(`[i18n] missing message key: ${key}`);
    return key;
  }
  if (!args || args.length === 0) {
    return raw;
  }
  return interpolateMessage(raw, args);
}
