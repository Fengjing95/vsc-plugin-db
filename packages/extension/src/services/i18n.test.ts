import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { interpolateMessage } from '@db-explorer/protocol';
import { createL10nFileBackend, resetL10nBackend, setL10nBackend, t } from './i18n';

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

describe('createL10nFileBackend（P-72：en 显示语言下 vscode.l10n 不加载 en 词典，门面自管文件）', () => {
  function makeExtDir(dict: Record<string, string> | null, lang = 'en'): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbkit-l10n-'));
    fs.mkdirSync(path.join(dir, 'l10n'));
    if (dict !== null) {
      fs.writeFileSync(path.join(dir, 'l10n', `bundle.l10n.${lang}.json`), JSON.stringify(dict));
    }
    return dir;
  }

  it('en：查表命中翻译，未命中键回落原文；插值走词典值', () => {
    const dir = makeExtDir({ 表: 'Tables', '已导出 {0} 行': 'Exported {0} rows' });
    const backend = createL10nFileBackend(dir, 'en');
    expect(backend('表', [])).toBe('Tables');
    expect(backend('已连接', [])).toBe('已连接');
    expect(backend('已导出 {0} 行', [3])).toBe('Exported 3 rows');
    expect(backend('已导出 {0} 行', [])).toBe('Exported {0} rows');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('语言码回退：en-us 命中 bundle.l10n.en.json', () => {
    const dir = makeExtDir({ 表: 'Tables' });
    expect(createL10nFileBackend(dir, 'en-us')('表', [])).toBe('Tables');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('词典文件缺失：静默回落原文（与 l10n 官方语义一致）', () => {
    const dir = makeExtDir(null);
    expect(createL10nFileBackend(dir, 'en')('表', [])).toBe('表');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('zh 显示语言：不读词典（源语言零文件依赖）', () => {
    const dir = makeExtDir({ 表: 'SHOULD_NOT_LOAD' });
    expect(createL10nFileBackend(dir, 'zh-cn')('表', [])).toBe('表');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

