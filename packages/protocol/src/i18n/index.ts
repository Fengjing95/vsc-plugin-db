/**
 * Webview UI 词表（D-25 / C-17）：zh 为源语言——zh 词典的键集即权威键集（MessageKey），
 * en 为翻译（Partial 分批补齐，B3 收口起键集与 zh 全等——parity 测试守卫）。
 *
 * 分域文件：common / error / table / console / form / dbddl / settings / design / er / ai。
 * 键命名 `<域>.<语义>`；各域文件互不重叠，新增词条进对应域文件。
 *
 * 链路：extension 按 vscode.env.language 经 messagesFor 选词典（zh 兜底合并），
 * 经 __BOOTSTRAP__.messages 注入（P-60 对象字面量口径）；webview t() 回落链 =
 * 注入词典 → zh 词典 → key（缺 zh 键视为缺陷，开发态告警）。
 * 官网 Playground 的 iframe bootstrap 由外壳按站点语言注入（嵌入界面随站点语言）。
 */
import { enAi, zhAi } from './ai';
import { enCommon, zhCommon } from './common';
import { enConsole, zhConsole } from './console';
import { enDbddl, zhDbddl } from './dbddl';
import { enDesign, zhDesign } from './design';
import { enEr, zhEr } from './er';
import { enError, zhError } from './error';
import { enForm, zhForm } from './form';
import { enSettings, zhSettings } from './settings';
import { enTable, zhTable } from './table';

export const zhMessages = {
  ...zhCommon,
  ...zhError,
  ...zhTable,
  ...zhConsole,
  ...zhForm,
  ...zhDbddl,
  ...zhSettings,
  ...zhDesign,
  ...zhEr,
  ...zhAi,
} as const;

export type MessageKey = keyof typeof zhMessages;
export type MessageDict = Record<MessageKey, string>;

export const enMessages: Partial<MessageDict> = {
  ...enCommon,
  ...enError,
  ...enTable,
  ...enConsole,
  ...enForm,
  ...enDbddl,
  ...enSettings,
  ...enDesign,
  ...enEr,
  ...enAi,
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
