import { describe, expect, it } from 'vitest';
import type { ChangeSet } from '@db-explorer/core';
import { buildChangeStatements } from './changes';

const DB = 'demo';

describe('buildChangeStatements · INSERT', () => {
  it('列名反引号引用、值全部参数化', () => {
    const cs: ChangeSet = {
      inserts: [{ tempId: 't1', values: { name: '张三', email: 'z@x.com' } }],
      updates: [],
      deletes: [],
    };
    const [item] = buildChangeStatements(DB, 'users', cs);
    expect(item.kind).toBe('insert');
    expect(item.tempId).toBe('t1');
    expect(item.sql).toBe('INSERT INTO `demo`.`users` (`name`, `email`) VALUES (?, ?)');
    expect(item.params).toEqual(['张三', 'z@x.com']);
  });

  it('空 inserts/updates/deletes 返回空数组；空值新增行报 E_VALIDATION', () => {
    expect(buildChangeStatements(DB, 'users', { inserts: [], updates: [], deletes: [] })).toEqual([]);
    expect(() =>
      buildChangeStatements(DB, 'users', {
        inserts: [{ tempId: 't1', values: {} }],
        updates: [],
        deletes: [],
      }),
    ).toThrow(/E_VALIDATION|没有任何列值/);
  });
});

describe('buildChangeStatements · UPDATE（WHERE = 主键 + 变更列原值，规范 §8-2）', () => {
  it('SET 与 WHERE 均参数化，参数顺序 = SET 新值在前、WHERE 原值在后', () => {
    const cs: ChangeSet = {
      inserts: [],
      updates: [
        {
          rowKey: { id: 7 },
          original: { id: 7, name: '张三', email: 'z@x.com' },
          changes: {
            name: { old: '张三', new: '张三改' },
            email: { old: 'z@x.com', new: 'new@x.com' },
          },
        },
      ],
      deletes: [],
    };
    const [item] = buildChangeStatements(DB, 'users', cs);
    expect(item.sql).toBe(
      'UPDATE `demo`.`users` SET `name` = ?, `email` = ? WHERE `id` = ? AND `name` = ? AND `email` = ?',
    );
    expect(item.params).toEqual(['张三改', 'new@x.com', 7, '张三', 'z@x.com']);
  });

  it('原值为 NULL 的变更列生成 IS NULL（col = NULL 永不匹配）', () => {
    const cs: ChangeSet = {
      inserts: [],
      updates: [
        {
          rowKey: { id: 7 },
          original: { id: 7, note: null },
          changes: { note: { old: null, new: 'filled' } },
        },
      ],
      deletes: [],
    };
    const [item] = buildChangeStatements(DB, 'users', cs);
    expect(item.sql).toBe('UPDATE `demo`.`users` SET `note` = ? WHERE `id` = ? AND `note` IS NULL');
    expect(item.params).toEqual(['filled', 7]);
  });

  it('无主键全列匹配模式（D-03）：RowKey 为全行原值，WHERE 覆盖全部列', () => {
    const cs: ChangeSet = {
      inserts: [],
      updates: [
        {
          rowKey: { code: 'A', note: null, qty: 3 },
          original: { code: 'A', note: null, qty: 3 },
          changes: { qty: { old: 3, new: 5 } },
        },
      ],
      deletes: [],
    };
    const [item] = buildChangeStatements(DB, 'nopk', cs);
    expect(item.sql).toBe(
      'UPDATE `demo`.`nopk` SET `qty` = ? WHERE `code` = ? AND `note` IS NULL AND `qty` = ?',
    );
    expect(item.params).toEqual([5, 'A', 3]);
  });

  it('标识符含反引号时转义', () => {
    const cs: ChangeSet = {
      inserts: [],
      updates: [
        {
          rowKey: { 'we`ird': 1 },
          original: { 'we`ird': 1 },
          changes: { 'va`l': { old: 'a', new: 'b' } },
        },
      ],
      deletes: [],
    };
    const [item] = buildChangeStatements(DB, 't', cs);
    expect(item.sql).toContain('`va``l` = ?');
    expect(item.sql).toContain('`we``ird` = ?');
  });
});

describe('buildChangeStatements · DELETE（WHERE 仅按主键）', () => {
  it('不携带变更列/original 其他列', () => {
    const cs: ChangeSet = {
      inserts: [],
      updates: [],
      deletes: [{ rowKey: { id: 9 }, original: { id: 9, name: 'x' } }],
    };
    const [item] = buildChangeStatements(DB, 'users', cs);
    expect(item.sql).toBe('DELETE FROM `demo`.`users` WHERE `id` = ?');
    expect(item.params).toEqual([9]);
  });

  it('复合主键全列 AND；无主键全行匹配', () => {
    const cs: ChangeSet = {
      inserts: [],
      updates: [],
      deletes: [{ rowKey: { a: 1, b: 'x' }, original: {} }],
    };
    const [item] = buildChangeStatements(DB, 't', cs);
    expect(item.sql).toBe('DELETE FROM `demo`.`t` WHERE `a` = ? AND `b` = ?');
    expect(item.params).toEqual([1, 'x']);

    const noPk = buildChangeStatements(DB, 't', {
      inserts: [],
      updates: [],
      deletes: [{ rowKey: { c: null, d: 2 }, original: {} }],
    });
    expect(noPk[0].sql).toBe('DELETE FROM `demo`.`t` WHERE `c` IS NULL AND `d` = ?');
  });

  it('空 RowKey 的 DELETE 报 E_VALIDATION（规范 §8-4 兜底）', () => {
    expect(() =>
      buildChangeStatements(DB, 't', { inserts: [], updates: [], deletes: [{ rowKey: {}, original: {} }] }),
    ).toThrow(/E_VALIDATION|缺少主键/);
  });
});
