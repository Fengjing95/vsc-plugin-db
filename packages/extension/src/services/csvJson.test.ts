import { describe, expect, it } from 'vitest';
import { csvEscapeField, csvRow, safeFileName, toJsonObject } from './csvJson';

describe('csvEscapeField（RFC 4180）', () => {
  it('普通值原样输出', () => {
    expect(csvEscapeField('abc')).toBe('abc');
    expect(csvEscapeField(42)).toBe('42');
    expect(csvEscapeField(true)).toBe('true');
  });

  it('NULL → 空串（与空串在 CSV 中不可区分，属格式固有限制）', () => {
    expect(csvEscapeField(null)).toBe('');
    expect(csvEscapeField(undefined)).toBe('');
  });

  it('含逗号/引号/换行加引号，引号翻倍', () => {
    expect(csvEscapeField('a,b')).toBe('"a,b"');
    expect(csvEscapeField('say "hi"')).toBe('"say ""hi"""');
    expect(csvEscapeField('line1\nline2')).toBe('"line1\nline2"');
  });

  it('JSON 对象序列化为原文（含引号时按 RFC 4180 转义）', () => {
    expect(csvEscapeField({ a: 1 })).toBe('"{""a"":1}"');
  });
});

describe('csvRow', () => {
  it('行以 CRLF 结尾', () => {
    expect(csvRow([1, 'a', null])).toBe('1,a,\r\n');
  });
});

describe('toJsonObject', () => {
  it('行式数组映射为列名对象', () => {
    expect(toJsonObject(['id', 'name'], [1, '张三'])).toEqual({ id: 1, name: '张三' });
    expect(toJsonObject(['id'], [undefined])).toEqual({ id: null });
  });
});

describe('safeFileName', () => {
  it('替换文件系统非法字符', () => {
    expect(safeFileName('a/b<c>d')).toBe('a_b_c_d');
    expect(safeFileName('users')).toBe('users');
  });
});
