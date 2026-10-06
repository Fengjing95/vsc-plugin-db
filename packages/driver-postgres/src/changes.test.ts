import { describe, expect, it } from 'vitest';
import { DriverError, type ChangeSet } from '@db-explorer/core';
import { buildChangeStatements } from './changes';

const emptyCs = (): ChangeSet => ({ inserts: [], updates: [], deletes: [] });

describe('buildChangeStatements（M8-PG，驱动规范 §8）', () => {
  it('INSERT：$n 占位符 + RETURNING 主键列（回填同源），params 等长', () => {
    const items = buildChangeStatements(
      'public',
      'users',
      { ...emptyCs(), inserts: [{ tempId: 't1', values: { name: 'a', email: 'b@c' } }] },
      { pkColumns: ['id'] },
    );
    expect(items).toHaveLength(1);
    expect(items[0].sql).toBe(
      'INSERT INTO "public"."users" ("name", "email") VALUES ($1, $2) RETURNING "id"',
    );
    expect(items[0].params).toEqual(['a', 'b@c']);
  });

  it('INSERT 无主键信息：不带 RETURNING（无主键表）', () => {
    const items = buildChangeStatements('public', 'logs', {
      ...emptyCs(),
      inserts: [{ tempId: 't1', values: { msg: 'x' } }],
    });
    expect(items[0].sql).toBe('INSERT INTO "public"."logs" ("msg") VALUES ($1)');
  });

  it('INSERT 空值 → E_VALIDATION（含 tempId 定位）', () => {
    try {
      buildChangeStatements('public', 'users', { ...emptyCs(), inserts: [{ tempId: 't1', values: {} }] }, { pkColumns: ['id'] });
      expect.unreachable('应抛错');
    } catch (err) {
      expect(DriverError.is(err)).toBe(true);
      expect((err as DriverError).code).toBe('E_VALIDATION');
      expect((err as DriverError).meta?.tempId).toBe('t1');
    }
  });

  it('UPDATE：WHERE = RowKey + 变更列原值（字段级乐观锁，D-03）', () => {
    const items = buildChangeStatements('public', 'users', {
      ...emptyCs(),
      updates: [
        {
          rowKey: { id: 7 },
          original: { id: 7 },
          changes: { name: { old: 'x', new: 'y' }, note: { old: null, new: 'n' } },
        },
      ],
    });
    expect(items[0].sql).toBe(
      'UPDATE "public"."users" SET "name" = $1, "note" = $2 WHERE "id" = $3 AND "name" = $4 AND "note" IS NULL',
    );
    expect(items[0].params).toEqual(['y', 'n', 7, 'x']);
  });

  it('UPDATE 空 rowKey 且原值 NULL → IS NULL 兜底条件（不产生无条件 UPDATE）', () => {
    const items = buildChangeStatements('public', 'users', {
      ...emptyCs(),
      updates: [{ rowKey: {}, original: {}, changes: { name: { old: null, new: 'y' } } }],
    });
    expect(items[0].sql).toContain('WHERE "name" IS NULL');
  });

  it('DELETE：仅按 RowKey；无 rowKey → E_VALIDATION', () => {
    const items = buildChangeStatements('public', 'users', {
      ...emptyCs(),
      deletes: [{ rowKey: { id: 7, code: 'c' }, original: {} }],
    });
    expect(items[0].sql).toBe('DELETE FROM "public"."users" WHERE "id" = $1 AND "code" = $2');
    expect(items[0].params).toEqual([7, 'c']);

    expect(() =>
      buildChangeStatements('public', 'users', { ...emptyCs(), deletes: [{ rowKey: {}, original: {} }] }),
    ).toThrow(DriverError);
  });

  it('混合集合：insert/update/delete 语句序与 params 逐语句独立编号', () => {
    const items = buildChangeStatements(
      'public',
      't',
      {
        inserts: [{ tempId: 'i1', values: { a: 1 } }],
        updates: [{ rowKey: { id: 1 }, original: { id: 1 }, changes: { a: { old: 1, new: 2 } } }],
        deletes: [{ rowKey: { id: 2 }, original: {} }],
      },
      { pkColumns: ['id'] },
    );
    expect(items.map((i) => i.kind)).toEqual(['insert', 'update', 'delete']);
    for (const item of items) {
      const dollarMax = Math.max(0, ...(item.sql.match(/\$\d+/g) ?? []).map((s) => Number(s.slice(1))));
      expect(item.params!.length).toBe(dollarMax);
    }
  });
});
