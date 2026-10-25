import { describe, expect, it } from 'vitest';
import { enMessages, interpolateMessage, messagesFor, zhMessages, type MessageKey } from './i18n';

describe('i18n 词典（D-25）', () => {
  it('messagesFor：zh 全量兜底——任意语言词典与 zh 键集完全一致（en Partial 缺键回落中文，绝不裸键上屏）', () => {
    const zhKeys = Object.keys(zhMessages);
    for (const lang of ['', 'zh', 'zh-cn', 'zh-TW', 'en', 'en-US', 'de']) {
      const dict = messagesFor(lang);
      expect(Object.keys(dict).sort()).toEqual([...zhKeys].sort());
    }
  });

  it('en 覆盖生效，zh 语言取 zh 原文', () => {
    expect(messagesFor('en')['table.noMatch']).toBe('No matching data');
    expect(messagesFor('zh-cn')['table.noMatch']).toBe('无匹配数据');
  });

  it('en 词典与 zh 键集完全一致（B3 收口起全量对译，parity 守卫）', () => {
    expect(Object.keys(enMessages).sort()).toEqual(Object.keys(zhMessages).sort());
  });

  it('en 词典已登记的值必须非空字符串', () => {
    for (const [key, value] of Object.entries(enMessages)) {
      expect(typeof value).toBe('string');
      expect((value as string).length).toBeGreaterThan(0);
      expect(zhMessages[key as MessageKey]).toBeDefined();
    }
  });

  it('interpolateMessage：{0} 占位插值，越界占位原样保留', () => {
    expect(interpolateMessage('已导出 {0} 行 → {1}', [3, 'a.csv'])).toBe('已导出 3 行 → a.csv');
    expect(interpolateMessage('第 {0} / {1} 页', [2])).toBe('第 2 / {1} 页');
  });
});
