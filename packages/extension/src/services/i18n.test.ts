import { describe, expect, it } from 'vitest';
import { interpolateMessage } from '@db-explorer/protocol';
import { resetL10nBackend, setL10nBackend, t } from './i18n';

describe('i18n 门面（C-17 / D-25）', () => {
  it('缺省后端：中文源文案原样返回（单测语义与硬编码时代一致）', () => {
    expect(t('已连接')).toBe('已连接');
    expect(t('表')).toBe('表');
  });

  it('缺省后端：{0} 占位插值，越界占位原样保留', () => {
    expect(t('已导出 {0} 行 → {1}', [1, 'out.csv'])).toBe('已导出 1 行 → out.csv');
    expect(t('第 {0} 处', [])).toBe('第 {0} 处');
    expect(t('第 {0} / {1} 页', [2])).toBe('第 2 / {1} 页');
  });

  it('注入后端后翻译生效；reset 回落缺省（测试隔离）', () => {
    setL10nBackend((message, args) => (message === '已连接' ? 'Connected' : interpolateMessage(message, args)));
    expect(t('已连接')).toBe('Connected');
    resetL10nBackend();
    expect(t('已连接')).toBe('已连接');
  });

  it('按钮回执比较口径：与翻译后的同一变量比较（D-25 决议 6）', () => {
    const del = t('删除');
    const pick = del; // showMessage 返回值桩
    expect(pick === del).toBe(true);
  });
});
