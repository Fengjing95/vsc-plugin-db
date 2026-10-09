import { describe, expect, it } from 'vitest';
import { Binary, Decimal128, Long, ObjectId } from 'mongodb';
import { DriverError } from '@db-explorer/core';
import { columnsFromDocs, encodeValue, formatDateTimeUtc, parseDateTimeUtc } from './document';

/** BSON → §5 编码（驱动规范 §5.5 映射表）与动态列采样推断 */

describe('encodeValue（逐 BSON 类型）', () => {
  it('标量：string/boolean/number 原样；null/undefined → null', () => {
    expect(encodeValue('x')).toBe('x');
    expect(encodeValue(true)).toBe(true);
    expect(encodeValue(1.5)).toBe(1.5);
    expect(encodeValue(null)).toBeNull();
    expect(encodeValue(undefined)).toBeNull();
  });

  it('ObjectId → 24 位 hex；Date → UTC YYYY-MM-DD HH:mm:ss.SSS', () => {
    expect(encodeValue(new ObjectId('507f1f77bcf86cd799439011'))).toBe('507f1f77bcf86cd799439011');
    expect(encodeValue(new Date(Date.UTC(2024, 0, 2, 3, 4, 5, 6)))).toBe('2024-01-02 03:04:05.006');
  });

  it('Long：安全范围内 → number，超限 → decimal 字符串；Decimal128 → 字符串', () => {
    expect(encodeValue(Long.fromNumber(3_000_000_000))).toBe(3_000_000_000);
    expect(encodeValue(Long.fromString('9007199254740993'))).toBe('9007199254740993');
    expect(encodeValue(Decimal128.fromString('42.42'))).toBe('42.42');
  });

  it('Binary → base64；嵌套对象/数组深度转换（内嵌 ObjectId/Date/Binary）', () => {
    expect(encodeValue(new Binary(Buffer.from([0, 1, 255])))).toBe(Buffer.from([0, 1, 255]).toString('base64'));
    expect(
      encodeValue({ a: new ObjectId('507f1f77bcf86cd799439011'), b: [new Date(Date.UTC(2024, 0, 1)), 1] }),
    ).toEqual({ a: '507f1f77bcf86cd799439011', b: ['2024-01-01 00:00:00.000', 1] });
  });

  it('NaN/Infinity → 字符串（JSON 安全，无静默丢失）', () => {
    expect(encodeValue(Number.NaN)).toBe('NaN');
    expect(encodeValue(Number.POSITIVE_INFINITY)).toBe('Infinity');
  });
});

describe('columnsFromDocs（动态列：采样推断顶层字段并集）', () => {
  it('_id 恒为首列且 isPrimaryKey；其余按首见序；ordinal 严格递增', () => {
    const cols = columnsFromDocs([
      { _id: new ObjectId(), a: 1, b: 'x' },
      { _id: new ObjectId(), b: 'y', c: null },
    ]);
    expect(cols.map((c) => c.name)).toEqual(['_id', 'a', 'b', 'c']);
    expect(cols[0].isPrimaryKey).toBe(true);
    expect(cols.slice(1).every((c) => !c.isPrimaryKey)).toBe(true);
    expect(cols.map((c) => c.ordinal)).toEqual([1, 2, 3, 4]);
    expect(cols.every((c) => (c.name === '_id' ? !c.nullable : c.nullable))).toBe(true);
  });

  it('列类型取首个非 null 样本；全 null 列 → unknown', () => {
    const cols = columnsFromDocs([
      { _id: new ObjectId(), v: null },
      { _id: new ObjectId(), v: 3 },
    ]);
    const v = cols.find((c) => c.name === 'v')!;
    expect(v.normalizedType).toBe('integer');
    const allNull = columnsFromDocs([
      { _id: new ObjectId(), w: null },
      { _id: new ObjectId(), w: null },
    ]);
    expect(allNull.find((c) => c.name === 'w')!.normalizedType).toBe('unknown');
  });

  it('dataType 承载 BSON 原生类型名（objectId/date/decimal/long/binary）', () => {
    const cols = columnsFromDocs([
      {
        _id: new ObjectId(),
        d: new Date(),
        p: Decimal128.fromString('1'),
        l: Long.fromNumber(1),
        bin: new Binary(Buffer.from([1])),
      },
    ]);
    const byName = Object.fromEntries(cols.map((c) => [c.name, c]));
    expect(byName._id.dataType).toBe('objectId');
    expect(byName.d.dataType).toBe('date');
    expect(byName.p.dataType).toBe('decimal');
    expect(byName.l.dataType).toBe('long');
    expect(byName.bin.dataType).toBe('binary');
  });
});

describe('parseDateTimeUtc / formatDateTimeUtc（C-7 无时区口径）', () => {
  it('解析 UTC（不受本机时区影响）并格式化回原样', () => {
    const d = parseDateTimeUtc('2024-06-01 08:30:00.500');
    expect(d.toISOString()).toBe('2024-06-01T08:30:00.500Z');
    expect(formatDateTimeUtc(d)).toBe('2024-06-01 08:30:00.500');
    expect(parseDateTimeUtc('2024-06-01')).toEqual(new Date(Date.UTC(2024, 5, 1)));
    expect(formatDateTimeUtc(parseDateTimeUtc('2024-06-01 08:30:00'))).toBe('2024-06-01 08:30:00.000');
  });

  it('非法格式 → E_VALIDATION', () => {
    expect(() => parseDateTimeUtc('not-a-date')).toThrowError(DriverError);
    expect(() => parseDateTimeUtc('2024-13-01 00:00:00')).toThrowError(DriverError);
  });
});
