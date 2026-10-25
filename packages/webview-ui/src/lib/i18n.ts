/**
 * Webview 轻量 t()（D-25 / C-17）：vscode.l10n 在 webview bundle 内不可用——
 * 词典由 extension buildWebviewHtml 经 __BOOTSTRAP__.messages 注入（P-60 对象口径）；
 * 回落链 = 注入词典 → zh 词典 → key（缺 zh 键视为词表缺陷，console 告警）。
 * 域键词表单一来源 = @db-explorer/protocol（MessageKey 类型约束调用点）。
 */
import { interpolateMessage, zhMessages, type MessageKey } from '@db-explorer/protocol';

export { interpolateMessage };
export type { MessageKey };

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

/**
 * FormSchema 文案解析（D-25）：驱动/Host 下发的 label/placeholder/hint 若是登记过的域键
 * （form.* 等）则翻译，否则原样展示——第三方驱动（L2/L3）的自由文本天然兼容
 * （C-5 契约：label 为自由字符串，键化只发生在内置驱动）。
 */
export function formText(value: string): string {
  return (zhMessages as Record<string, string | undefined>)[value] !== undefined
    ? t(value as MessageKey)
    : value;
}
