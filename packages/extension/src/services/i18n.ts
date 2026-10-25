/**
 * 用户可见文案门面（C-17 / D-25）：extension 侧文案一律经 t()，禁止硬编码裸字面量。
 *
 * 中文源文案即键（vscode.l10n 官方语义：无 bundle 命中时回落原文，中文环境零 bundle 正确）。
 * 缺省后端 = 原样返回 + {0} 插值——零 vscode 纯层单测语义不变；
 * extension.ts activate 时注入 vscode.l10n 后端（en 翻译在 l10n/bundle.l10n.en.json）。
 */
import { interpolateMessage } from '@db-explorer/protocol';

export type L10nBackend = (message: string, args: readonly (string | number)[]) => string;

let backend: L10nBackend = (message, args) => interpolateMessage(message, args);

/** activate 注入（或测试注入桩后端）；调用点不改 */
export function setL10nBackend(next: L10nBackend): void {
  backend = next;
}

/** 回落缺省后端（测试隔离用） */
export function resetL10nBackend(): void {
  backend = (message, args) => interpolateMessage(message, args);
}

export function t(message: string, args?: readonly (string | number)[]): string {
  return backend(message, args ?? []);
}
