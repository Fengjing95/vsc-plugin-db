import { describe, expect, it } from 'vitest';
import {
  assessMongoCommand,
  isProvablyReadMongoCommand,
  parseMongoChain,
  parseMongoUse,
  splitMongoCommandLines,
} from './mongoCommands';

/**
 * mongosh 命令域切分与白名单（M8-Mongo，驱动规范 §5.5）：
 * 与 redisCommands.test.ts 同构覆盖——切分/形状、provablyRead fail-closed、危险表、use/show 解析。
 */

describe('splitMongoCommandLines', () => {
  it('按行切分，空行与 // 注释行跳过，尾分号剥离', () => {
    const script = [
      '// 注释行',
      'db.users.find({})',
      '',
      '   // 缩进注释',
      'db.users.count();',
      'db.runCommand({ ping: 1 }) ;',
    ].join('\n');
    const lines = splitMongoCommandLines(script);
    expect(lines.map((l) => l.text)).toEqual([
      'db.users.find({})',
      'db.users.count()',
      'db.runCommand({ ping: 1 })',
    ]);
    // 偏移量落在原文（statementAtOffset 复用）
    expect(script.slice(lines[0].start, lines[0].end)).toBe('db.users.find({})');
  });

  it('块注释跨行跳过；字符串内 // 与 ; 不受影响', () => {
    const script = [
      '/* 块注释开始',
      '   仍在注释 */ db.users.find({})',
      'db.users.find({ pattern: "a//b;" })',
    ].join('\n');
    const lines = splitMongoCommandLines(script);
    expect(lines.map((l) => l.text)).toEqual([
      'db.users.find({})',
      'db.users.find({ pattern: "a//b;" })',
    ]);
  });
});

describe('parseMongoUse', () => {
  it('use <db> → 目标库名；use 无参 → null；非 use → undefined', () => {
    expect(parseMongoUse('use admin')).toBe('admin');
    expect(parseMongoUse('  use   cf_mongo  ')).toBe('cf_mongo');
    expect(parseMongoUse('use')).toBeNull();
    expect(parseMongoUse('use ')).toBeNull();
    expect(parseMongoUse('db.users.find({})')).toBeUndefined();
  });
});

describe('parseMongoChain', () => {
  it('db.<coll>.<method>(args) / getCollection / db 级方法 / getSiblingDB', () => {
    expect(parseMongoChain('db.users.find({})')).toMatchObject({ coll: 'users', method: 'find', argsSrc: '{}' });
    expect(parseMongoChain('db.getCollection("users").findOne()')).toMatchObject({
      coll: 'users',
      method: 'findOne',
      argsSrc: '',
    });
    expect(parseMongoChain('db.runCommand({ ping: 1 })')).toMatchObject({
      method: 'runCommand',
      argsSrc: '{ ping: 1 }',
    });
    expect(parseMongoChain("db.getSiblingDB('other').logs.count()")).toMatchObject({
      dbTarget: 'other',
      coll: 'logs',
      method: 'count',
    });
  });

  it('字符串内括号/引号不破坏平衡；游标链式调用 → undefined（fail-closed）', () => {
    expect(parseMongoChain(`db.users.find({ a: "})" })`)).toMatchObject({ method: 'find' });
    expect(parseMongoChain('db.users.find({}).limit(5)')).toBeUndefined();
    expect(parseMongoChain('db.users.find')).toBeUndefined();
    expect(parseMongoChain('db.users.find(')).toBeUndefined();
    expect(parseMongoChain('notdb.users.find()')).toBeUndefined();
    expect(parseMongoChain('db.users.find({}); db.users.count()')).toBeUndefined();
  });
});

describe('assessMongoCommand（provablyRead fail-closed / dangerous）', () => {
  it('读命令 → provablyRead', () => {
    for (const cmd of [
      'db.users.find({})',
      'db.users.findOne({ _id: 1 })',
      'db.users.count({ a: 1 })',
      'db.users.countDocuments({})',
      'db.users.estimatedDocumentCount()',
      'db.users.distinct("category")',
      'db.users.getIndexes()',
      'db.getCollectionNames()',
      'db.getDBNames()',
      'db.users.stats()',
      'db.stats()',
      'db.users.aggregate([ { $match: { a: 1 } }, { $group: { _id: null } } ])',
      'db.runCommand({ ping: 1 })',
      'db.runCommand({ listCollections: 1 })',
      'show dbs',
      'show collections',
      'use cf_mongo',
    ]) {
      const a = assessMongoCommand(cmd);
      expect(a.provablyRead, cmd).toBe(true);
      expect(a.dangerous, cmd).toBe(false);
      expect(a.unparseable, cmd).toBe(false);
    }
  });

  it('写/危险命令 → dangerous + 原因；aggregate 带 $out/$merge 视为写', () => {
    for (const [cmd, reasonPart] of [
      ['db.users.deleteMany({})', '删除'],
      ['db.users.deleteOne({})', '删除'],
      ['db.users.insertOne({})', '写入'],
      ['db.users.updateMany({}, { $set: { a: 1 } })', '修改'],
      ['db.users.replaceOne({}, {})', '替换'],
      ['db.users.drop()', '删除整个 collection'],
      ['db.dropDatabase()', '删除整个数据库'],
      ['db.users.createIndex({ a: 1 })', '索引'],
      ['db.runCommand({ dropDatabase: 1 })', '删除整个数据库'],
      ['db.users.aggregate([ { $out: "copy" } ])', '$out'],
      ['db.users.aggregate([ { $merge: { into: "copy" } } ])', '$merge'],
    ] as Array<[string, string]>) {
      const a = assessMongoCommand(cmd);
      expect(a.dangerous, cmd).toBe(true);
      expect(a.provablyRead, cmd).toBe(false);
      expect(a.reasons.join('；'), cmd).toContain(reasonPart);
    }
  });

  it('runCommand 非白名单命令 fail-closed（不证明为读，不误报危险）', () => {
    const a = assessMongoCommand('db.runCommand({ whatever: 1 })');
    expect(a.provablyRead).toBe(false);
    expect(a.dangerous).toBe(false);
    expect(a.known).toBe(false);
  });

  it('未知方法 fail-closed；不可解析 → unparseable', () => {
    const unknown = assessMongoCommand('db.users.noSuchMethod({})');
    expect(unknown.known).toBe(false);
    expect(unknown.provablyRead).toBe(false);
    expect(unknown.dangerous).toBe(false);

    const bad = assessMongoCommand('db.users.find(');
    expect(bad.unparseable).toBe(true);
    expect(bad.provablyRead).toBe(false);
  });

  it('isProvablyReadMongoCommand 与 assessment 一致', () => {
    expect(isProvablyReadMongoCommand('db.users.find({})')).toBe(true);
    expect(isProvablyReadMongoCommand('db.users.deleteMany({})')).toBe(false);
    expect(isProvablyReadMongoCommand('db.runCommand({ serverStatus: 1 })')).toBe(false);
  });
});
