import { describe, expect, it } from 'vitest';
import {
  defaultQueryName,
  expandQueryDirectory,
  newQueryDefaultName,
  queryLabel,
  queryPathSegment,
  querySummary,
  sanitizeQueryFileName,
  stripSqlSuffix,
  timestampQueryName,
} from './savedQueries';

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

describe('newQueryDefaultName', () => {
  it('默认名为 query_<13 位毫秒时间戳>', () => {
    const now = 1_760_000_000_000; // 13 位
    expect(newQueryDefaultName(now)).toBe('query_1760000000000');
    expect(newQueryDefaultName(now).length).toBe('query_'.length + 13);
  });
});

describe('stripSqlSuffix / queryLabel', () => {
  it('剥 .sql 后缀（大小写不敏感），无后缀原样返回', () => {
    expect(queryLabel('用户订单查询.sql')).toBe('用户订单查询');
    expect(queryLabel('Report.SQL')).toBe('Report');
    expect(queryLabel('noext')).toBe('noext');
    expect(stripSqlSuffix('a.sql')).toBe('a');
  });
});

describe('queryPathSegment', () => {
  it('消毒路径段并保证非空（兜底 _）', () => {
    expect(queryPathSegment('my/db')).toBe('my db');
    expect(queryPathSegment('..')).toBe('_');
    expect(queryPathSegment('*')).toBe('_');
    expect(queryPathSegment('app_db')).toBe('app_db');
  });
});

describe('expandQueryDirectory', () => {
  it('~/ 前缀展开为主目录', () => {
    expect(expandQueryDirectory('~/Documents/db-queries', '/Users/u')).toBe('/Users/u/Documents/db-queries');
    expect(expandQueryDirectory('~', '/Users/u')).toBe('/Users/u');
  });

  it('绝对路径原样返回；空白值与非绝对路径返回空串（回退默认目录）', () => {
    expect(expandQueryDirectory('/var/queries', '/Users/u')).toBe('/var/queries');
    expect(expandQueryDirectory('  ', '/Users/u')).toBe('');
    expect(expandQueryDirectory('relative/dir', '/Users/u')).toBe('');
  });
});
