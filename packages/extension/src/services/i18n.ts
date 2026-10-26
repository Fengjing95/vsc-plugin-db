/**
 * 用户可见文案门面（C-17 / D-25）：extension 侧文案一律经 t()，禁止硬编码裸字面量。
 *
 * 中文源文案即键。缺省后端 = 原样返回 + {0} 插值——零 vscode 纯层单测语义不变；
 * extension.ts activate 时注入 createL10nFileBackend（按显示语言读随包词典）。
 *
 * 为什么不用 vscode.l10n 的 bundle 加载（P-72）：VSCode 官方按「源文案 = 英文」假定设计，
 * 显示语言为英文时**不加载** bundle.l10n.en.json（microsoft/vscode#168127）——中文源 +
 * en 词典的组合在英文环境下 l10n.t 恒回落原文。因此词典文件（l10n/bundle.l10n.<lang>.json，
 * 随 VSIX 分发）由门面自行读取；manifest 层 %key% + package.nls.<locale>.json 不受影响
 * （主进程扩展扫描对 en 同样加载 nls.en.json，实测生效）。
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
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

/**
 * 按显示语言加载扩展安装目录下 l10n/bundle.l10n.<lang>.json 的查表后端。
 * 词典文件缺失（未翻译语言 / zh 源语言）回落缺省行为——原样返回 + 插值，与 l10n 官方语义一致。
 */
export function createL10nFileBackend(extensionPath: string, lang: string): L10nBackend {
  let dict: Record<string, string> = {};
  if (!/^zh\b/i.test(lang)) {
    const base = path.join(extensionPath, 'l10n');
    // 语言码回退：en-us → en（词典按主码命名）
    const candidates = [lang, lang.split('-')[0]];
    for (const l of candidates) {
      try {
        dict = JSON.parse(readFileSync(path.join(base, `bundle.l10n.${l}.json`), 'utf8')) as Record<string, string>;
        break;
      } catch {
        // 试下一个候选；全失败保留空表（原文回落），静默降级与 l10n 官方行为一致
      }
    }
  }
  return (message, args) => {
    const translated = dict[message];
    return interpolateMessage(translated !== undefined ? translated : message, args);
  };
}
