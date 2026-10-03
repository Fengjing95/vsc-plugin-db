import { describe, expect, it } from 'vitest';
import { defaultQueryName, querySummary, sanitizeQueryFileName, timestampQueryName } from './savedQueries';

describe('sanitizeQueryFileName', () => {
  it('替换路径分隔符与 Windows 非法字符', () => {
    expect(sanitizeQueryFileName('a/b\\c:d*e?f"g<h>i|j')).toBe('a b c d e f g h i j');
  });

  it('去除首尾空白并压缩连续空白', () => {
    expect(sanitizeQueryFileName('  用户  订单 查询  ')).toBe('用户 订单 查询');
  });

  it('剥离开头的点（防路径穿越形态）', () => {
    expect(sanitizeQueryFileName('../etc/passwd')).toBe('etc passwd');
    expect(sanitizeQueryFileName('..')).toBe('');
  });

  it('超长截断到 80 字符', () => {
    expect(sanitizeQueryFileName('x'.repeat(100)).length).toBe(80);
  });
});

describe('defaultQueryName', () => {
  it('取首个非空非注释行', () => {
    // '*' 属 Windows 文件名非法字符，消毒为空格（savedQueries 纯函数行为）
    expect(defaultQueryName('-- 备注\n\nSELECT * FROM users;')).toBe('SELECT FROM users;');
  });

  it('截断超长语句到 32 字符（含省略号）', () => {
    const long = 'SELECT a, b, c, d, e, f, g, h FROM very_long_table_name';
    const name = defaultQueryName(long);
    expect(name.length).toBe(33);
    expect(name.endsWith('…')).toBe(true);
  });

  it('空文本退回时间戳名', () => {
    const t = new Date(2026, 9, 3, 17, 36, 5);
    expect(defaultQueryName('   \n-- 只有注释', t)).toBe('query-20261003-173605');
  });
});

describe('timestampQueryName', () => {
  it('按 query-YYYYMMDD-HHmmss 格式化', () => {
    expect(timestampQueryName(new Date(2026, 0, 2, 3, 4, 5))).toBe('query-20260102-030405');
  });
});

describe('querySummary', () => {
  it('跳过注释与空行，截断 60 字符', () => {
    const text = '-- header\n\n' + 'UPDATE t SET x = '.padEnd(70, 'y');
    const summary = querySummary(text);
    expect(summary.length).toBe(61);
    expect(summary.endsWith('…')).toBe(true);
  });

  it('空文本 → (空)', () => {
    expect(querySummary('')).toBe('(空)');
  });
});
