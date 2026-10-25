/**
 * Webview UI 词表（D-25 / C-17）：zh 为源语言——zh 词典的键集即权威键集（MessageKey），
 * en 为翻译（Partial 分批补齐，完成态升级为全量 MessageDict，类型层面强制键集一致）。
 *
 * 链路：extension 按 vscode.env.language 经 messagesFor 选词典（zh 兜底合并），
 * 经 __BOOTSTRAP__.messages 注入（P-60 对象字面量口径）；webview t() 回落链 =
 * 注入词典 → zh 词典 → key（缺 zh 键视为缺陷，开发态告警）。
 * 官网 Playground 的 iframe bootstrap 由外壳按站点语言注入（嵌入界面随站点语言）。
 *
 * 域键命名：`<域>.<对象>[.<动作>]`——common/tree/table/form/console/er/design/dbddl/settings/ai/site。
 */

export const zhMessages = {
  // common
  'common.retry': '重试',
  'common.close': '关闭',
  'common.cancel': '取消',
  'common.copy': '复制',
  'common.loading': '加载中…',

  // table（B1 试点）
  'table.noMatch': '无匹配数据',
  'table.clearFilter': '清除筛选',
} as const;

export type MessageKey = keyof typeof zhMessages;
export type MessageDict = Record<MessageKey, string>;

export const enMessages: Partial<MessageDict> = {
  'common.retry': 'Retry',
  'common.close': 'Close',
  'common.cancel': 'Cancel',
  'common.copy': 'Copy',
  'common.loading': 'Loading…',
  'table.noMatch': 'No matching data',
  'table.clearFilter': 'Clear filters',
};

/** 当前语言的完整词典：en 覆盖 zh（Partial 缺键回落中文，绝不裸键上屏） */
export function messagesFor(lang: string): MessageDict {
  const extra = /^en\b/i.test(lang) ? enMessages : {};
  return { ...zhMessages, ...extra };
}

/** 插值：`{0}` 占位（与 vscode.l10n 同形），越界占位原样保留 */
export function interpolateMessage(message: string, args: readonly (string | number)[]): string {
  return message.replace(/\{(\d+)\}/g, (raw, index) => {
    const value = args[Number(index)];
    return value === undefined ? raw : String(value);
  });
}
