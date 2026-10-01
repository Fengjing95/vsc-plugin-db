import { describe, expect, it } from 'vitest';
import { headerSortToText, parseOrderTerms, termsToText, toggleTerm } from './orderTerms';

const COLS = ['id', 'name', 'amount', 'created_at'];

describe('parseOrderTerms（ORDER BY 片段解析，双向联动）', () => {
  it('空片段 = 规范且无排序项', () => {
    expect(parseOrderTerms('', COLS)).toEqual({ canonical: true, terms: [] });
    expect(parseOrderTerms('   ', COLS)).toEqual({ canonical: true, terms: [] });
  });

  it('规范片段：列 + 可选方向，大小写/引号列引用可解析', () => {
    expect(parseOrderTerms('id ASC, name DESC', COLS)).toEqual({
      canonical: true,
      terms: [
        { name: 'id', dir: 'asc' },
        { name: 'name', dir: 'desc' },
      ],
    });
    expect(parseOrderTerms('`id`', COLS).terms).toEqual([{ name: 'id', dir: 'asc' }]);
    expect(parseOrderTerms('"Amount" desc', COLS).terms).toEqual([{ name: 'amount', dir: 'desc' }]);
    expect(parseOrderTerms('Id', COLS).terms).toEqual([{ name: 'id', dir: 'asc' }]);
  });

  it('非规范：括号/函数/未知列/非法词法/空项', () => {
    expect(parseOrderTerms('CASE WHEN id > 1 THEN 1 END', COLS).canonical).toBe(false);
    expect(parseOrderTerms('COALESCE(amount, 0) DESC', COLS).canonical).toBe(false);
    expect(parseOrderTerms('nope DESC', COLS).canonical).toBe(false);
    expect(parseOrderTerms('id extra', COLS).canonical).toBe(false);
    expect(parseOrderTerms('id,', COLS).canonical).toBe(false);
  });
});

describe('toggleTerm / termsToText（三态循环与回写）', () => {
  it('无 → asc → desc → 移除', () => {
    expect(toggleTerm([], 'id')).toEqual([{ name: 'id', dir: 'asc' }]);
    expect(toggleTerm([{ name: 'id', dir: 'asc' }], 'id')).toEqual([{ name: 'id', dir: 'desc' }]);
    expect(toggleTerm([{ name: 'id', dir: 'desc' }], 'id')).toEqual([]);
  });

  it('其余项保留；termsToText 序列化（desc 显式、asc 省略、特殊名双引号）', () => {
    const terms = toggleTerm([{ name: 'id', dir: 'desc' }, { name: 'name', dir: 'asc' }], 'id');
    expect(terms).toEqual([{ name: 'name', dir: 'asc' }]);
    expect(termsToText([{ name: 'id', dir: 'desc' }, { name: 'name', dir: 'asc' }])).toBe('id DESC, name');
    expect(termsToText([{ name: 'we ird', dir: 'asc' }])).toBe('"we ird"');
  });
});

describe('headerSortToText（列头点击 → 片段文本）', () => {
  it('空片段点击 → 单列升序；二次点击 → 降序；三次 → 移除', () => {
    expect(headerSortToText('', 'name', COLS)).toBe('name');
    expect(headerSortToText('name', 'name', COLS)).toBe('name DESC');
    expect(headerSortToText('name DESC', 'name', COLS)).toBe('');
  });

  it('在既有排序上追加/切换（保留其他项）', () => {
    expect(headerSortToText('id DESC, name', 'amount', COLS)).toBe('id DESC, name, amount');
    expect(headerSortToText('id DESC, name', 'name', COLS)).toBe('id DESC, name DESC');
    expect(headerSortToText('id DESC, name DESC', 'id', COLS)).toBe('name DESC');
  });

  it('自由表达式 → null（联动停用，不覆盖用户输入）', () => {
    expect(headerSortToText('CASE WHEN id > 1 THEN 1 END', 'id', COLS)).toBeNull();
    expect(headerSortToText('nope DESC', 'id', COLS)).toBeNull();
  });
});
