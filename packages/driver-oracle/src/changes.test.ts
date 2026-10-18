import { describe, expect, it } from 'vitest';
import type { ChangeSet } from '@db-explorer/core';
import { buildChangeStatements } from './changes';

/** 变更集语句生成单测（驱动规范 §8；P-9 同口径：占位符断言在此层覆盖） */
describe('buildChangeStatements（:N 位置绑定 + RETURNING 回填 + IS NULL 乐观锁）', () => {
  const pk = ['id'];

  it('insert：RETURNING 占位符从输入绑定数之后编号（执行时尾部追加 out 绑定）', () => {
    const items = buildChangeStatements('DBKIT', 't', {
      inserts: [{ tempId: 't1', values: { name: 'x', age: 1 } }],
      updates: [],
      deletes: [],
    }, { pkColumns: pk });
    expect(items).toHaveLength(1);
    expect(items[0].sql).toBe('INSERT INTO "DBKIT"."t" ("name", "age") VALUES (:1, :2) RETURNING "id" INTO :3');
    expect(items[0].params).toEqual(['x', 1]);
  });

  it('无 pkColumns：不生成 RETURNING（回填回落用户值）', () => {
    const items = buildChangeStatements('DBKIT', 't', {
      inserts: [{ tempId: 't1', values: { name: 'x' } }],
      updates: [],
      deletes: [],
    });
    expect(items[0].sql).toBe('INSERT INTO "DBKIT"."t" ("name") VALUES (:1)');
  });

  it('update：WHERE = RowKey + 变更列原值；NULL 原值 → IS NULL（D-03）', () => {
    const items = buildChangeStatements('DBKIT', 't', {
      inserts: [],
      updates: [{
        rowKey: { id: 7 },
        original: { name: 'old', note: null },
        changes: { name: { old: 'old', new: 'new' }, note: { old: null, new: 'v' } },
      }],
      deletes: [],
    }, { pkColumns: pk });
    expect(items[0].sql).toBe('UPDATE "DBKIT"."t" SET "name" = :1, "note" = :2 WHERE "id" = :3 AND "name" = :4 AND "note" IS NULL');
    expect(items[0].params).toEqual(['new', 'v', 7, 'old']);
  });

  it('update：RowKey 已覆盖变更列时不重复进 WHERE（全列匹配模式）', () => {
    const items = buildChangeStatements('DBKIT', 't', {
      inserts: [],
      updates: [{
        rowKey: { id: 1, name: 'old' },
        original: { id: 1, name: 'old' },
        changes: { name: { old: 'old', new: 'new' } },
      }],
      deletes: [],
    }, { pkColumns: pk });
    expect(items[0].sql).toBe('UPDATE "DBKIT"."t" SET "name" = :1 WHERE "id" = :2 AND "name" = :3');
    expect(items[0].params).toEqual(['new', 1, 'old']);
  });

  it('delete：仅按 RowKey 定位', () => {
    const items = buildChangeStatements('DBKIT', 't', {
      inserts: [],
      updates: [],
      deletes: [{ rowKey: { id: 9 }, original: {} }],
    }, { pkColumns: pk });
    expect(items[0].sql).toBe('DELETE FROM "DBKIT"."t" WHERE "id" = :1');
  });

  it('空值边界：insert 无列 / delete 无定位 → E_VALIDATION；update 空 SET 静默跳过', () => {
    const empty: ChangeSet = { inserts: [], updates: [], deletes: [] };
    expect(() => buildChangeStatements('DBKIT', 't', { ...empty, inserts: [{ tempId: 'x', values: {} }] }, { pkColumns: pk })).toThrow(/任何列值|列值/);
    // changes 为空的 update 不产生语句（continue 口径，同 mssql）
    const skipped = buildChangeStatements('DBKIT', 't', { ...empty, updates: [{ rowKey: {}, original: {}, changes: {} }] });
    expect(skipped).toHaveLength(0);
    expect(() => buildChangeStatements('DBKIT', 't', { ...empty, deletes: [{ rowKey: {}, original: {} }] })).toThrow();
  });

  it('preview（无 encodeParam）与 apply（有 encodeParam）同源形状——仅 params 值形态不同', () => {
    const cs = {
      inserts: [{ tempId: 't', values: { created: '2024-06-01 08:30:00.000' } }],
      updates: [],
      deletes: [],
    };
    const preview = buildChangeStatements('DBKIT', 't', cs, { pkColumns: pk });
    const apply = buildChangeStatements('DBKIT', 't', cs, { pkColumns: pk, encodeParam: () => 'ENCODED' });
    expect(preview[0].sql).toBe(apply[0].sql);
    expect(preview[0].params![0]).toBe('2024-06-01 08:30:00.000');
    expect(apply[0].params![0]).toBe('ENCODED');
  });
});
