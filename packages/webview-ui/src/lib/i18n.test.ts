import { describe, expect, it, vi } from 'vitest';
import { interpolateMessage, t } from './i18n';

describe('webview t()（D-25 / C-17）', () => {
  it('无 bootstrap（stub/单测环境）：回落 zh 词典', () => {
    expect(t('table.noMatch')).toBe('无匹配数据');
    expect(t('common.retry')).toBe('重试');
  });

  it('args 插值（{0} 与 vscode.l10n 同形）', () => {
    expect(t('table.noMatch', [])).toBe('无匹配数据');
    expect(interpolateMessage('第 {0} / {1} 页', [3, 9])).toBe('第 3 / 9 页');
  });

  it('注入词典优先；注入缺键回落 zh（en Partial 缺键不裸键上屏）', async () => {
    (globalThis as unknown as { window: unknown }).window = {
      __BOOTSTRAP__: {
        page: 'table',
        viewId: 'v',
        params: {},
        lang: 'en',
        messages: { 'table.noMatch': 'No matching data' },
      },
    };
    vi.resetModules();
    const mod = await import('./i18n');
    expect(mod.t('table.noMatch')).toBe('No matching data');
    expect(mod.t('table.clearFilter')).toBe('清除筛选');
    (globalThis as unknown as { window: unknown }).window = undefined;
  });

  it('缺 zh 键 = 词表缺陷：告警并返回裸键', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    (globalThis as unknown as { window: unknown }).window = {
      __BOOTSTRAP__: { page: 'table', viewId: 'v', params: {}, messages: {} },
    };
    vi.resetModules();
    const mod = await import('./i18n');
    expect(mod.t('bogus.key' as never)).toBe('bogus.key');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
    (globalThis as unknown as { window: unknown }).window = undefined;
  });
});
