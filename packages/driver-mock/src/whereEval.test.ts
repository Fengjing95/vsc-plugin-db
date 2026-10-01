import { describe, expect, it } from 'vitest';
import type { ColumnMeta } from '@db-explorer/core';
import { compileOrderBy, compileWhere } from './whereEval';

const COLS: ColumnMeta[] = [
  { name: 'id', type: 'int', normalizedType: 'integer' },
  { name: 'name', type: 'varchar', normalizedType: 'text' },
  { name: 'amount', type: 'decimal', normalizedType: 'decimal' },
  { name: 'note', type: 'varchar', normalizedType: 'text' },
] as unknown as ColumnMeta[];

function filter(sql: string, row: unknown[]): boolean {
  const pred = compileWhere(sql, COLS);
  expect(pred).not.toBeNull();
  return pred!(row);
}

// 行：id, name, amount, note
const ROW = [7, 'Alice', '12.50', null];

describe('compileWhere（用户 WHERE 片段求值，三值逻辑）', () => {
  it('基础比较与 AND/OR/NOT 优先级', () => {
    expect(filter('id = 7', ROW)).toBe(true);
    expect(filter('id <> 7', ROW)).toBe(false);
    expect(filter("name = 'Alice' AND amount >= 12.5", ROW)).toBe(true);
    expect(filter("name = 'Bob' OR amount > 12", ROW)).toBe(true);
    expect(filter("NOT name = 'Bob'", ROW)).toBe(true);
    // AND 优先于 OR：false AND false OR true = true
    expect(filter("name = 'Bob' AND amount = 1 OR name = 'Alice'", ROW)).toBe(true);
    expect(filter("(name = 'Bob' OR amount = 1) AND name = 'Alice'", ROW)).toBe(false);
  });

  it('字符串引号转义与大小写保留', () => {
    expect(filter("name = 'O''Brien'", [3, "O'Brien", '1.00', null])).toBe(true);
    expect(filter("name = 'alice'", ROW)).toBe(false); // 字符串比较区分大小写
  });

  it('NULL 三值逻辑：比较为 unknown、IS [NOT] NULL 可判', () => {
    expect(filter('note = NULL', ROW)).toBe(false); // = NULL 永不匹配
    expect(filter('note IS NULL', ROW)).toBe(true);
    expect(filter('note IS NOT NULL', ROW)).toBe(false);
    expect(filter('NOT note = NULL', ROW)).toBe(false); // NOT unknown 仍 unknown
    expect(filter("note = 'x' OR id = 7", ROW)).toBe(true); // unknown OR true = true
  });

  it('IN / NOT IN / LIKE / NOT LIKE / BETWEEN', () => {
    expect(filter('id IN (1, 7, 9)', ROW)).toBe(true);
    expect(filter('id NOT IN (1, 2)', ROW)).toBe(true);
    expect(filter("name LIKE 'a%'", ROW)).toBe(true); // MySQL 默认排序规则大小写不敏感
    expect(filter("name LIKE '_lice'", ROW)).toBe(true);
    expect(filter("name NOT LIKE 'B%'", ROW)).toBe(true);
    expect(filter('id BETWEEN 5 AND 10', ROW)).toBe(true);
    expect(filter('id NOT BETWEEN 1 AND 3', ROW)).toBe(true);
  });

  it('标识符：反引号/双引号/大小写不敏感列名', () => {
    expect(filter('`id` = 7', ROW)).toBe(true);
    expect(filter('"ID" = 7', ROW)).toBe(true);
    expect(filter('Id = 7', ROW)).toBe(true);
  });

  it('注释与多余空白', () => {
    expect(filter('id = 7 -- 行注释\n', ROW)).toBe(true);
    expect(filter('  id  =  7 ', ROW)).toBe(true);
  });

  it('语法错误与未知列 → E_VALIDATION', () => {
    expect(() => compileWhere("id =", COLS)).toThrow();
    expect(() => compileWhere("id = 'x", COLS)).toThrow();
    expect(() => compileWhere('unknown_col = 1', COLS)).toThrow(/未知列/);
    expect(() => compileWhere('id = 7 extra', COLS)).toThrow(/多余内容/);
  });

  it('空片段返回 null（不筛选）', () => {
    expect(compileWhere('   ', COLS)).toBeNull();
  });
});

describe('compileOrderBy（用户 ORDER BY 片段解析）', () => {
  it('多列与方向', () => {
    expect(compileOrderBy('name ASC, id DESC', COLS)).toEqual([
      { index: 1, dir: 'asc' },
      { index: 0, dir: 'desc' },
    ]);
    expect(compileOrderBy('amount', COLS)).toEqual([{ index: 2, dir: 'asc' }]);
  });

  it('语法错误/未知列 → E_VALIDATION；空片段为空数组', () => {
    expect(() => compileOrderBy('nope DESC', COLS)).toThrow(/未知列/);
    expect(() => compileOrderBy('id DOWN', COLS)).toThrow();
    expect(compileOrderBy('  ', COLS)).toEqual([]);
  });
});
