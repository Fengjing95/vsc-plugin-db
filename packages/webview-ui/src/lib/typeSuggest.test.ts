import { describe, expect, it } from 'vitest';
import type { DataTypeOptionPayload } from '@db-explorer/protocol';
import { caretPosFor, fillValueOf, filterDataTypeOptions, movedHighlight } from './typeSuggest';

const WORDS: DataTypeOptionPayload[] = [
  { value: 'INT' },
  { value: 'VARCHAR', template: 'VARCHAR()' },
  { value: 'DECIMAL', template: 'DECIMAL(,)' },
  { value: 'DATETIME' },
];

describe('filterDataTypeOptions', () => {
  it('空输入给全量；子串大小写不敏感；无命中为空数组', () => {
    expect(filterDataTypeOptions(WORDS, '')).toHaveLength(4);
    expect(filterDataTypeOptions(WORDS, '  ')).toHaveLength(4);
    expect(filterDataTypeOptions(WORDS, 'date')).toEqual([{ value: 'DATETIME' }]);
    expect(filterDataTypeOptions(WORDS, 'TIME')).toHaveLength(1); // DATETIME 子串命中
    expect(filterDataTypeOptions(WORDS, 'zzz')).toEqual([]);
  });
});

describe('fillValueOf / caretPosFor', () => {
  it('无参回填 value；带形参回填 template，光标落形参位', () => {
    expect(fillValueOf({ value: 'INT' })).toBe('INT');
    expect(fillValueOf({ value: 'VARCHAR', template: 'VARCHAR()' })).toBe('VARCHAR()');

    expect(caretPosFor('INT')).toBe(3); // 无括号落末尾
    expect(caretPosFor('VARCHAR()')).toBe(8); // 右括号前
    expect(caretPosFor('DECIMAL(,)')).toBe(8); // 形参分隔逗号处
    expect(caretPosFor("ENUM('')")).toBe(7); // 右括号前（引号内）
  });
});

describe('movedHighlight', () => {
  it('↑↓ 循环；空列表原样返回', () => {
    expect(movedHighlight(0, 1, 3)).toBe(1);
    expect(movedHighlight(2, 1, 3)).toBe(0);
    expect(movedHighlight(0, -1, 3)).toBe(2);
    expect(movedHighlight(1, 0, 3)).toBe(1);
    expect(movedHighlight(1, 1, 0)).toBe(1);
  });
});
