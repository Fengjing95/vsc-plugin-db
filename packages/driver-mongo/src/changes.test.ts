import { describe, expect, it } from 'vitest';
import { ObjectId } from 'mongodb';
import { buildChangeOps } from './changes';
import type { ColumnTypes } from './filter';

/**
 * ChangeSet → Mongo 变更计划（D-18）：preview/apply 同源生成（§8-6）。
 * update = 字段级 $set（乐观锁 = _id + 变更列原值，D-03 同构；null/缺失统一 {f: null}）；
 * 清空 = $set null（不引入 $unset）；sql 为 mongosh 伪语句（? 占位符 + params 等长，P-22）。
 */

const types: ColumnTypes = new Map([
  ['_id', { normalizedType: 'string', dataType: 'objectId' }],
  ['name', { normalizedType: 'string', dataType: 'string' }],
  ['age', { normalizedType: 'integer', dataType: 'int' }],
  ['note', { normalizedType: 'string', dataType: 'string' }],
  ['score', { normalizedType: 'decimal', dataType: 'decimal' }],
]);

const HEX = '507f1f77bcf86cd799439011';

describe('buildChangeOps（D-18）', () => {
  it('update：字段级 $set，乐观锁 = _id + 变更列原值；? 与 params 等长（P-22）', () => {
    const ops = buildChangeOps(
      'user',
      {
        inserts: [],
        updates: [{ rowKey: { _id: HEX }, original: {}, changes: { age: { old: 29, new: 30 } } }],
        deletes: [],
      },
      types,
    );
    expect(ops).toHaveLength(1);
    const op = ops[0]!;
    expect(op.kind).toBe('update');
    expect(op.sql).toBe('db.user.updateOne({ "_id": ?, "age": ? }, { $set: { "age": ? } })');
    expect(op.params).toEqual([HEX, 29, 30]);
    expect(op.params).toHaveLength((op.sql.match(/\?/g) ?? []).length);
    expect(op.rowKey).toEqual({ _id: HEX });
    expect(op.exec).toEqual({
      type: 'updateOne',
      filter: { _id: new ObjectId(HEX), age: 29 },
      update: { $set: { age: 30 } },
    });
  });

  it('原值 null / 新值 null：filter 命中缺失与显式 null；清空 = $set null（不引入 $unset）', () => {
    const ops = buildChangeOps(
      'user',
      {
        inserts: [],
        updates: [
          { rowKey: { _id: HEX }, original: {}, changes: { note: { old: null, new: null } } },
        ],
        deletes: [],
      },
      types,
    );
    const op = ops[0]!;
    expect(op.exec.type).toBe('updateOne');
    if (op.exec.type === 'updateOne') {
      expect(op.exec.filter).toEqual({ _id: new ObjectId(HEX), note: null });
      expect(op.exec.update).toEqual({ $set: { note: null } });
    }
    expect(op.sql).not.toContain('$unset');
  });

  it('多字段变更：全部原值 AND 进 WHERE、全部新值进 $set', () => {
    const ops = buildChangeOps(
      'user',
      {
        inserts: [],
        updates: [
          {
            rowKey: { _id: HEX },
            original: {},
            changes: { age: { old: 29, new: 30 }, name: { old: 'a', new: 'b' } },
          },
        ],
        deletes: [],
      },
      types,
    );
    const op = ops[0]!;
    if (op.exec.type === 'updateOne') {
      expect(op.exec.filter).toEqual({ _id: new ObjectId(HEX), age: 29, name: 'a' });
      expect(op.exec.update).toEqual({ $set: { age: 30, name: 'b' } });
    }
    // params：_id + 两个 old + 两个 new = 5，与 ? 数等长
    expect(op.params).toHaveLength(5);
    expect(op.params).toHaveLength((op.sql.match(/\?/g) ?? []).length);
  });

  it('decimal/类型转换：decimal 字符串 → Decimal128 绑定（params 保持 §5 编码形态）', () => {
    const ops = buildChangeOps(
      'user',
      {
        inserts: [],
        updates: [
          { rowKey: { _id: HEX }, original: {}, changes: { score: { old: '88.5', new: '90.25' } } },
        ],
        deletes: [],
      },
      types,
    );
    const op = ops[0]!;
    if (op.exec.type === 'updateOne') {
      expect(String(op.exec.filter.score)).toBe('88.5');
      expect(String(op.exec.update.$set.score)).toBe('90.25');
    }
    expect(op.params).toEqual([HEX, '88.5', '90.25']);
  });

  it('insert：值转 BSON 进 doc；objectId 列非法 hex 容错降级为字符串（schema-free）', () => {
    const ops = buildChangeOps(
      'user',
      {
        inserts: [{ tempId: 't1', values: { name: 'cf-str-ins', age: 1, _id: 'not-hex-value' } }],
        updates: [],
        deletes: [],
      },
      types,
    );
    const op = ops[0]!;
    expect(op.kind).toBe('insert');
    expect(op.tempId).toBe('t1');
    expect(op.sql.startsWith('db.user.insertOne({ ')).toBe(true);
    expect(op.sql.endsWith(' })')).toBe(true);
    if (op.exec.type === 'insertOne') {
      expect(op.exec.doc).toEqual({ name: 'cf-str-ins', age: 1, _id: 'not-hex-value' });
    }
    expect(op.params).toHaveLength((op.sql.match(/\?/g) ?? []).length);
  });

  it('delete：deleteOne({ _id })，rowKey 透传', () => {
    const ops = buildChangeOps(
      'user',
      { inserts: [], updates: [], deletes: [{ rowKey: { _id: HEX }, original: {} }] },
      types,
    );
    const op = ops[0]!;
    expect(op.kind).toBe('delete');
    expect(op.sql).toBe('db.user.deleteOne({ "_id": ? })');
    expect(op.params).toEqual([HEX]);
    expect(op.exec).toEqual({ type: 'deleteOne', filter: { _id: new ObjectId(HEX) } });
  });

  it('空变更集 → 空计划（探针/无操作路径）', () => {
    expect(buildChangeOps('user', { inserts: [], updates: [], deletes: [] }, types)).toEqual([]);
  });
});
