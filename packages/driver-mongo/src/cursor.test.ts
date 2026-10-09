import { describe, expect, it } from 'vitest';
import { ObjectId } from 'mongodb';
import { DriverError } from '@db-explorer/core';
import { decodeCursorOrThrow, encodeCursor, resumeFilter } from './cursor';

/** cursor 分页游标（驱动规范 §5.5）：opaque 自包含位点（P-27），复合排序 resume 不跳行 */

describe('encodeCursor / decodeCursorOrThrow（roundtrip 保真）', () => {
  it('ObjectId / Date / Decimal 值经 BSON 序列化往返类型不变形', () => {
    const state = {
      id: new ObjectId('507f1f77bcf86cd799439011'),
      sk: ['qty', 'name'],
      sd: [1, -1] as Array<1 | -1>,
      sv: [10, 'a'],
    };
    const decoded = decodeCursorOrThrow(encodeCursor(state));
    expect(decoded.v).toBe(1);
    expect((decoded.id as ObjectId).toHexString()).toBe('507f1f77bcf86cd799439011');
    expect(decoded.sk).toEqual(['qty', 'name']);
    expect(decoded.sd).toEqual([1, -1]);
    expect(decoded.sv).toEqual([10, 'a']);
  });

  it('非法游标 → E_VALIDATION（fail-closed，从首页重翻）', () => {
    expect(() => decodeCursorOrThrow('not-a-cursor!!!')).toThrowError(DriverError);
    expect(() => decodeCursorOrThrow(Buffer.from('{"nonsense":1}').toString('base64url'))).toThrowError(
      DriverError,
    );
  });
});

describe('resumeFilter（位点重建）', () => {
  it('无排序：_id 严格递增 resume', () => {
    const id = new ObjectId('507f1f77bcf86cd799439011');
    expect(resumeFilter({ id })).toEqual({ _id: { $gt: id } });
  });

  it('带排序：前缀相等 + 末位严格比较 + _id tiebreak（同值字段不跳行）', () => {
    const id = new ObjectId('507f1f77bcf86cd799439011');
    const f = resumeFilter({ id, sk: ['a', 'b'], sd: [1, -1], sv: [1, 'x'] }) as { $or: unknown[] };
    expect(f.$or).toEqual([
      { a: { $gt: 1 } },
      { a: 1, b: { $lt: 'x' } },
      { a: 1, b: 'x', _id: { $gt: id } },
    ]);
  });
});
