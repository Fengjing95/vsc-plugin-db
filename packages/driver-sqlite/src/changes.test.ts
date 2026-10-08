import { describe, expect, it } from 'vitest';
import { DriverError, type ChangeSet } from '@db-explorer/core';
import { buildChangeStatements } from './changes';

/** 变更语句生成单测（P-9 口径：断言占位符形状、params 等长、NULL 原值 IS NULL，无值拼接）。 */

const empty: ChangeSet = { inserts: [], updates: [], deletes: [] };

describe('buildChangeStatements：INSERT', () => {
  it('? 占位符与 params 等长，RETURNING 主键列', () => {
    const items = buildChangeStatements('main', 't', {
      ...empty,
      inserts: [{ tempId: 'i1', values: { name: 'a', age: 1 } }],
    }, { pkColumns: ['id'] });
    expect(items).toHaveLength(1);
    expect(items[0].sql).toBe('INSERT INTO "t" ("name", "age") VALUES (?, ?) RETURNING "id"');
    expect(items[0].params).toEqual(['a', 1]);
    expect(items[0].sql.match(/\?/g)).toHaveLength(items[0].params!.length);
  });

  it('无 pkColumns 时无 RETURNING（预览与执行同形状由调用方决定）', () => {
    const items = buildChangeStatements('main', 't', {
      ...empty,
      inserts: [{ tempId: 'i1', values: { name: 'a' } }],
    });
    expect(items[0].sql).toBe('INSERT INTO "t" ("name") VALUES (?)');
  });

  it('encodeParam 钩子生效（applyChanges 侧 base64 → Uint8Array）', () => {
    const items = buildChangeStatements('main', 't', {
      ...empty,
      inserts: [{ tempId: 'i1', values: { blob: 'AAEC/w==' } }],
    }, {
      pkColumns: ['id'],
      encodeParam: (col, v) => (col === 'blob' ? Buffer.from(String(v), 'base64') : v),
    });
    expect(items[0].params![0]).toEqual(Buffer.from([0, 1, 2, 255]));
  });

  it('空列值 → E_VALIDATION（带 insert/tempId 元数据）', () => {
    expect(() =>
      buildChangeStatements('main', 't', { ...empty, inserts: [{ tempId: 'bad', values: {} }] }),
    ).toThrowError(expect.objectContaining({ code: 'E_VALIDATION' }));
  });
});

describe('buildChangeStatements：UPDATE（乐观锁 D-03）', () => {
  it('WHERE = RowKey + 变更列原值；SET 先于 WHERE 占位', () => {
    const items = buildChangeStatements('main', 't', {
      ...empty,
      updates: [
        {
          rowKey: { id: 7 },
          original: { id: 7 },
          changes: { name: { old: 'a', new: 'b' }, age: { old: 1, new: 2 } },
        },
      ],
    });
    expect(items[0].sql).toBe('UPDATE "t" SET "name" = ?, "age" = ? WHERE "id" = ? AND "name" = ? AND "age" = ?');
    expect(items[0].params).toEqual(['b', 2, 7, 'a', 1]);
  });

  it('原值 NULL → IS NULL（col = NULL 永不匹配，会使乐观锁失效）', () => {
    const items = buildChangeStatements('main', 't', {
      ...empty,
      updates: [
        {
          rowKey: { id: 7 },
          original: { id: 7 },
          changes: { name: { old: null, new: 'b' } },
        },
      ],
    });
    expect(items[0].sql).toBe('UPDATE "t" SET "name" = ? WHERE "id" = ? AND "name" IS NULL');
    expect(items[0].params).toEqual(['b', 7]);
  });

  it('RowKey 已覆盖的变更列不再重复原值条件（全列匹配模式）', () => {
    const items = buildChangeStatements('main', 't', {
      ...empty,
      updates: [
        {
          rowKey: { id: 1, name: 'old' },
          original: { id: 1, name: 'old' },
          changes: { name: { old: 'old', new: 'new' } },
        },
      ],
    });
    expect(items[0].sql).toBe('UPDATE "t" SET "name" = ? WHERE "id" = ? AND "name" = ?');
  });

  it('空变更列跳过；无 RowKey 时按原值回退定位（全列匹配语义，与 pg 同构）', () => {
    const skipped = buildChangeStatements('main', 't', {
      ...empty,
      updates: [{ rowKey: { id: 1 }, original: {}, changes: {} }],
    });
    expect(skipped).toHaveLength(0);
    const fallback = buildChangeStatements('main', 't', {
      ...empty,
      updates: [{ rowKey: {}, original: {}, changes: { name: { old: 'a', new: 'b' } } }],
    });
    expect(fallback[0].sql).toBe('UPDATE "t" SET "name" = ? WHERE "name" = ?');
  });
});

describe('buildChangeStatements：DELETE / 混合', () => {
  it('DELETE 仅按 RowKey；无定位 → E_VALIDATION', () => {
    const items = buildChangeStatements('main', 't', {
      ...empty,
      deletes: [{ rowKey: { id: 9 }, original: {} }],
    });
    expect(items[0].sql).toBe('DELETE FROM "t" WHERE "id" = ?');
    expect(items[0].params).toEqual([9]);
    expect(() =>
      buildChangeStatements('main', 't', { ...empty, deletes: [{ rowKey: {}, original: {} }] }),
    ).toThrowError(DriverError);
  });

  it('insert/update/delete 混合按序生成（预览即执行）', () => {
    const items = buildChangeStatements('main', 't', {
      inserts: [{ tempId: 'i', values: { name: 'n' } }],
      updates: [{ rowKey: { id: 1 }, original: { id: 1 }, changes: { name: { old: 'a', new: 'b' } } }],
      deletes: [{ rowKey: { id: 2 }, original: {} }],
    }, { pkColumns: ['id'] });
    expect(items.map((i) => i.kind)).toEqual(['insert', 'update', 'delete']);
    for (const item of items) {
      expect(item.sql.match(/\?/g)).toHaveLength(item.params!.length);
    }
  });
});
