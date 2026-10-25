import { describe, expect, it } from 'vitest';
import {
  rowsToInList,
  rowsToInsert,
  rowsToJson,
  rowsToMarkdown,
  rowsToTsType,
  toSqlLiteral,
} from './copyFormats';

describe('toSqlLiteral（值编码契约 §4.4 口径）', () => {
  it('NULL 与空串严格区分', () => {
    expect(toSqlLiteral(null)).toBe('NULL');
    expect(toSqlLiteral('')).toBe(`''`);
  });
  it('数字/布尔不加引号', () => {
    expect(toSqlLiteral(42)).toBe('42');
    expect(toSqlLiteral(1.5)).toBe('1.5');
    expect(toSqlLiteral(true)).toBe('TRUE');
  });
  it('字符串单引号转义', () => {
    expect(toSqlLiteral("it's")).toBe(`'it''s'`);
  });
  it('JSON 对象 → JSON 文本字面量（对象不落 [object Object]，P-53 同族）', () => {
    expect(toSqlLiteral({ k: 1 })).toBe(`'{"k":1}'`);
    expect(toSqlLiteral([1, 'a'])).toBe(`'[1,"a"]'`);
  });
});

describe('rowsToInList', () => {
  it('主键值列表（混合类型）', () => {
    expect(rowsToInList([1, 'a', null, "b'c"])).toBe(`(1, 'a', NULL, 'b''c')`);
  });
  it('空列表 → 空括号（调用方应在无选区时禁用）', () => {
    expect(rowsToInList([])).toBe('()');
  });
});

describe('rowsToJson', () => {
  it('对象数组 + 缺失值归 NULL', () => {
    const out = JSON.parse(rowsToJson(['id', 'name'], [[1, 'a'], [2, null]]));
    expect(out).toEqual([{ id: 1, name: 'a' }, { id: 2, name: null }]);
  });
  it('json 类型列的已解析对象原样保留', () => {
    const out = JSON.parse(rowsToJson(['j'], [[{ a: 1 }]]));
    expect(out[0].j).toEqual({ a: 1 });
  });
});

describe('rowsToMarkdown', () => {
  it('表头/分隔/行，管道转义，NULL 显式', () => {
    const md = rowsToMarkdown(['id', 'note'], [[1, 'a|b'], [2, null]]);
    expect(md.split('\n')).toEqual([
      '| id | note |',
      '| --- | --- |',
      '| 1 | a\\|b |',
      '| 2 | NULL |',
    ]);
  });
  it('换行折叠为空格（不破坏表格）', () => {
    expect(rowsToMarkdown(['t'], [['a\nb']])).toContain('a b');
  });
});

describe('rowsToTsType', () => {
  it('按 NormalizedType 映射；DECIMAL=string（C-7）', () => {
    const ts = rowsToTsType('users', [
      { name: 'id', type: 'integer' },
      { name: 'amount', type: 'decimal' },
      { name: 'active', type: 'boolean' },
      { name: 'meta', type: 'json' },
      { name: 'payload', type: 'binary' },
    ]);
    expect(ts).toContain('id: number;');
    expect(ts).toContain('amount: string;');
    expect(ts).toContain('active: boolean;');
    expect(ts).toContain('meta: unknown;');
    expect(ts).toContain('payload: string;');
    expect(ts.startsWith('interface users {')).toBe(true);
  });
  it('非法列名/表名消毒（Unicode 字母保留）', () => {
    const ts = rowsToTsType('订单表', [{ name: '1a b', type: 'integer' }]);
    expect(ts).toContain('interface 订单表 {');
    expect(ts).toContain('_1a_b: number;');
  });
});

describe('rowsToInsert', () => {
  it('多行单语句 + 标识符反引号 + 值转义', () => {
    const sql = rowsToInsert('users', ['id', 'name'], [[1, 'a'], [2, null]]);
    expect(sql).toBe(
      'INSERT INTO `users` (`id`, `name`) VALUES\n  (1, \'a\'),\n  (2, NULL);',
    );
  });
  it('表名/列名反引号转义', () => {
    const sql = rowsToInsert('we`ird', ['a`b'], [[1]]);
    expect(sql).toContain('`we``ird`');
    expect(sql).toContain('`a``b`');
  });
  it('空行 → 空串', () => {
    expect(rowsToInsert('t', ['a'], [])).toBe('');
  });
});
