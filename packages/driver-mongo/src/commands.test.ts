import { describe, expect, it } from 'vitest';
import { Binary, Code, Decimal128, Long, ObjectId } from 'mongodb';
import { DriverError } from '@db-explorer/core';
import { parseMongoArgs } from './commands';

/**
 * mongosh 参数字面量解析（驱动规范 §5.5：禁 eval——受限解析器，解析失败 E_SYNTAX fail-closed）。
 * 命令切分/白名单判定在 core mongoCommands（那边有单测），此处覆盖执行层参数解析。
 */

describe('parseMongoArgs（受限字面量解析器）', () => {
  it('对象 / 数组 / 嵌套结构（含 $ 前缀键）', () => {
    expect(parseMongoArgs(`{ a: 1, b: "x", c: [1, 2, 3], $gt: 5 }`)).toEqual([
      { a: 1, b: 'x', c: [1, 2, 3], $gt: 5 },
    ]);
    expect(parseMongoArgs(`{ f: { $elemMatch: { $in: [1, 2] } } }`)).toEqual([
      { f: { $elemMatch: { $in: [1, 2] } } },
    ]);
  });

  it('字符串引号与转义（单/双/反引号）；数字/布尔/null', () => {
    expect(parseMongoArgs(`'a\\'b', "c\\"d"`)).toEqual(["a'b", 'c"d']);
    expect(parseMongoArgs('-1.5e3, true, false, null')).toEqual([-1.5e3, true, false, null]);
  });

  it('构造器包装：ObjectId / ISODate / NumberLong / NumberDecimal / BinData / new ObjectId()', () => {
    expect((parseMongoArgs(`ObjectId('507f1f77bcf86cd799439011')`)[0] as ObjectId).toHexString()).toBe(
      '507f1f77bcf86cd799439011',
    );
    expect(parseMongoArgs('new ObjectId()')[0]).toBeInstanceOf(ObjectId);
    expect(parseMongoArgs(`ISODate('2024-01-01T00:00:00Z')`)[0]).toEqual(new Date('2024-01-01T00:00:00Z'));
    expect(parseMongoArgs(`NumberLong('9007199254740993')`)[0]).toEqual(Long.fromString('9007199254740993'));
    expect(parseMongoArgs(`NumberDecimal('42.42')`)[0]).toEqual(Decimal128.fromString('42.42'));
    const bin = parseMongoArgs(`BinData(0, 'AQI=')`)[0] as Binary;
    expect(bin).toBeInstanceOf(Binary);
    expect(bin.buffer.subarray(0, bin.length())).toEqual(Buffer.from([1, 2]));
  });

  it('function 表达式 → BSON Code（源码透传，服务端执行）', () => {
    const [v] = parseMongoArgs(`function() { var s = Date.now(); while (false) {} return s; }`);
    expect(v).toBeInstanceOf(Code);
    expect((v as Code).code).toContain('while');
    const [doc] = parseMongoArgs(`{ $where: function() { return true; } }`) as [Record<string, unknown>];
    expect(doc.$where).toBeInstanceOf(Code);
  });

  it('解析失败 fail-closed：未知标识符 / 括号不平衡 / 尾随垃圾 → E_SYNTAX', () => {
    expect(() => parseMongoArgs('{ a: unknownIdent }')).toThrowError(DriverError);
    expect(() => parseMongoArgs('{ a: 1')).toThrowError(DriverError);
    expect(() => parseMongoArgs('1 2')).toThrowError(DriverError);
    expect(() => parseMongoArgs('db.users.find()')).toThrowError(DriverError); // 方法调用不是字面量
  });

  it('空参数源 → 空数组（无参方法）', () => {
    expect(parseMongoArgs('')).toEqual([]);
    expect(parseMongoArgs('   ')).toEqual([]);
  });
});
