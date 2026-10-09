import { describe, expect, it } from 'vitest';
import { Binary, Decimal128, ObjectId } from 'mongodb';
import { DriverError } from '@db-explorer/core';
import { buildFilterDoc, buildSearchDoc, buildSortDoc, escapeRegex, toBsonValue, type ColumnTypes } from './filter';

/**
 * FilterOp → 查询文档下推（驱动规范 §5.5）。P-9 口径：值只出现在查询文档的值位置
 * （绑定语义），单测断言无值拼接、NULL 语义与 SQL 三值逻辑基准（sqlMatch）一致。
 */

const types: ColumnTypes = new Map([
  ['_id', { normalizedType: 'string', dataType: 'objectId' }],
  ['name', { normalizedType: 'string', dataType: 'string' }],
  ['qty', { normalizedType: 'integer', dataType: 'int' }],
  ['price', { normalizedType: 'decimal', dataType: 'decimal' }],
  ['created', { normalizedType: 'datetime', dataType: 'date' }],
  ['bin', { normalizedType: 'binary', dataType: 'binary' }],
]);

describe('buildFilterDoc（逐 FilterOp 形状）', () => {
  it('eq / ne（ne 按 SQL 三值排除 NULL 与缺失字段）', () => {
    expect(buildFilterDoc([{ column: 'name', op: 'eq', value: 'a' }], types)).toEqual({ name: 'a' });
    expect(buildFilterDoc([{ column: 'name', op: 'ne', value: 'a' }], types)).toEqual({
      name: { $nin: ['a', null] },
    });
  });

  it('gt / ge / lt / le', () => {
    expect(buildFilterDoc([{ column: 'qty', op: 'gt', value: 5 }], types)).toEqual({ qty: { $gt: 5 } });
    expect(buildFilterDoc([{ column: 'qty', op: 'ge', value: 5 }], types)).toEqual({ qty: { $gte: 5 } });
    expect(buildFilterDoc([{ column: 'qty', op: 'lt', value: 5 }], types)).toEqual({ qty: { $lt: 5 } });
    expect(buildFilterDoc([{ column: 'qty', op: 'le', value: 5 }], types)).toEqual({ qty: { $lte: 5 } });
  });

  it('like / notLike：子串语义，特殊字符转义（与内存基准 includes 一致）', () => {
    const doc = buildFilterDoc([{ column: 'name', op: 'like', value: 'a.c' }], types);
    expect(doc).toEqual({ name: { $regex: 'a\\.c' } });
    const weird = buildFilterDoc([{ column: 'name', op: 'like', value: '100%_\\' }], types);
    // % 与 _ 非正则特殊字符，天然字面量（like 无 SQL 通配符语义，§5.5）
    expect(weird).toEqual({ name: { $regex: '100%_\\\\' } });
    expect(buildFilterDoc([{ column: 'name', op: 'notLike', value: 'a' }], types)).toEqual({
      $nor: [{ name: { $regex: 'a' } }],
    });
  });

  it('in / notIn（notIn 排除 NULL 与缺失）', () => {
    expect(buildFilterDoc([{ column: 'name', op: 'in', values: ['a', 'b'] }], types)).toEqual({
      name: { $in: ['a', 'b'] },
    });
    expect(buildFilterDoc([{ column: 'name', op: 'notIn', values: ['a', 'b'] }], types)).toEqual({
      name: { $nin: ['a', 'b', null] },
    });
  });

  it('isNull / isNotNull：null 同时命中显式 null 与缺失（文档模型口径）', () => {
    expect(buildFilterDoc([{ column: 'category', op: 'isNull' }], types)).toEqual({ category: null });
    expect(buildFilterDoc([{ column: 'category', op: 'isNotNull' }], types)).toEqual({
      category: { $ne: null },
    });
  });

  it('between', () => {
    expect(buildFilterDoc([{ column: 'qty', op: 'between', values: [1, 9] }], types)).toEqual({
      qty: { $gte: 1, $lte: 9 },
    });
  });

  it('多条件 AND → $and 包裹（允许同列多条件）', () => {
    expect(
      buildFilterDoc(
        [
          { column: 'qty', op: 'gt', value: 5 },
          { column: 'qty', op: 'lt', value: 50 },
        ],
        types,
      ),
    ).toEqual({ $and: [{ qty: { $gt: 5 } }, { qty: { $lt: 50 } }] });
  });

  it('未知筛选列 → E_VALIDATION', () => {
    expect(() => buildFilterDoc([{ column: 'nope', op: 'eq', value: 1 }], types)).toThrowError(DriverError);
  });

  it('P-9：恶意值原样进入值位置，绝不拼接进查询结构', () => {
    const evil = "Robert'); DROP TABLE users;--";
    const doc = buildFilterDoc([{ column: 'name', op: 'eq', value: evil }], types) as { name: string };
    expect(doc.name).toBe(evil);
    const regexEvil = buildFilterDoc([{ column: 'name', op: 'like', value: '.*' }], types) as {
      name: { $regex: string };
    };
    expect(regexEvil.name.$regex).toBe('\\.\\*'); // 通配语义的 . 与 * 被转义为字面量
  });
});

describe('toBsonValue（按采样列类型转回 BSON 原生值）', () => {
  it('objectId hex → ObjectId；非法 hex → E_VALIDATION', () => {
    const v = toBsonValue({ normalizedType: 'string', dataType: 'objectId' }, '507f1f77bcf86cd799439011');
    expect(v).toBeInstanceOf(ObjectId);
    expect((v as ObjectId).toHexString()).toBe('507f1f77bcf86cd799439011');
    expect(() => toBsonValue({ normalizedType: 'string', dataType: 'objectId' }, 'nope')).toThrowError(
      DriverError,
    );
  });

  it("datetime 文本 → Date（UTC 解析，'YYYY-MM-DD HH:mm:ss.SSS'）", () => {
    const v = toBsonValue({ normalizedType: 'datetime', dataType: 'date' }, '2024-06-01 08:30:00.500');
    expect(v).toBeInstanceOf(Date);
    expect((v as Date).toISOString()).toBe('2024-06-01T08:30:00.500Z');
  });

  it('decimal 字符串 → Decimal128；binary base64 → Binary', () => {
    expect(toBsonValue({ normalizedType: 'decimal', dataType: 'decimal' }, '42.42')).toBeInstanceOf(Decimal128);
    const b = toBsonValue({ normalizedType: 'binary', dataType: 'binary' }, Buffer.from([1, 2]).toString('base64'));
    expect(b).toBeInstanceOf(Binary);
  });

  it('未采样列的值原样透传（缺失字段按原值匹配）', () => {
    expect(toBsonValue(undefined, 'raw')).toBe('raw');
  });
});

describe('buildSortDoc / buildSearchDoc / escapeRegex', () => {
  it('默认 _id 升序；用户排序追加 _id 兜底（P-10 不前置）；已含 _id 不重复', () => {
    expect(buildSortDoc(undefined)).toEqual({ _id: 1 });
    expect(buildSortDoc([{ column: 'qty', dir: 'desc' }])).toEqual({ qty: -1, _id: 1 });
    expect(buildSortDoc([{ column: '_id', dir: 'desc' }])).toEqual({ _id: -1 });
  });

  it('search → 各 string 列 $or 转义子串；无 string 列 → undefined', () => {
    expect(buildSearchDoc('a.c', ['name', 'note'])).toEqual({
      $or: [{ name: { $regex: 'a\\.c' } }, { note: { $regex: 'a\\.c' } }],
    });
    expect(buildSearchDoc('x', [])).toBeUndefined();
    expect(buildSearchDoc(undefined, ['name'])).toBeUndefined();
  });

  it('escapeRegex 覆盖全部正则特殊字符', () => {
    expect(escapeRegex('a.b*c[d](e){f}|g^h$i?j\\k')).toBe(
      'a\\.b\\*c\\[d\\]\\(e\\)\\{f\\}\\|g\\^h\\$i\\?j\\\\k',
    );
  });
});
