import { describe, expect, it } from 'vitest';
import type { ChangeSet } from '@db-explorer/core';
import { buildChangeStatements } from './changes';

const emptySet = (): ChangeSet => ({ inserts: [], updates: [], deletes: [] });

/** 语句形状契约（P-9/P-22 同族）：preview/apply 同源生成，@pN 占位符 + params 等长 */
describe('buildChangeStatements（M8-MSSQL）', () => {
  it('insert：@pN 占位、OUTPUT INSERTED 主键列回填（ADR D-21）', () => {
    const cs = emptySet();
    cs.inserts.push({ tempId: 't1', values: { name: 'n1', age: 3 } });
    const items = buildChangeStatements('dbo', 't', cs, { pkColumns: ['id'] });
    expect(items).toHaveLength(1);
    expect(items[0].sql).toBe('INSERT INTO [dbo].[t] ([name], [age]) OUTPUT INSERTED.[id] VALUES (@p1, @p2)');
    expect(items[0].params).toEqual(['n1', 3]);
    expect(items[0].kind).toBe('insert');
    expect(items[0].tempId).toBe('t1');
  });

  it('insert 无主键列时不带 OUTPUT；空 values 抛 E_VALIDATION', () => {
    const cs = emptySet();
    cs.inserts.push({ tempId: 't1', values: { name: 'n1' } });
    const items = buildChangeStatements('dbo', 't', cs);
    expect(items[0].sql).toBe('INSERT INTO [dbo].[t] ([name]) VALUES (@p1)');

    const bad = emptySet();
    bad.inserts.push({ tempId: 't2', values: {} });
    expect(() => buildChangeStatements('dbo', 't', bad)).toThrowError(/E_VALIDATION|没有任何列值/);
  });

  it('update：SET 先绑定、WHERE = RowKey + 变更列原值（字段级乐观锁 D-03）、NULL 原值 IS NULL', () => {
    const cs = emptySet();
    cs.updates.push({
      rowKey: { id: 7 },
      original: { id: 7, name: null, status: 'a' },
      changes: {
        name: { old: null, new: 'x' },
        status: { old: 'a', new: 'b' },
      },
    });
    const items = buildChangeStatements('dbo', 't', cs);
    expect(items).toHaveLength(1);
    // SET 参数在前（@p1/@p2），WHERE 紧随（@p3=RowKey；原值 null → IS NULL 不占位）
    expect(items[0].sql).toBe(
      'UPDATE [dbo].[t] SET [name] = @p1, [status] = @p2 WHERE [id] = @p3 AND [name] IS NULL AND [status] = @p4',
    );
    expect(items[0].params).toEqual(['x', 'b', 7, 'a']);
  });

  it('update：变更列命中 RowKey 列（全列匹配模式）不重复入 WHERE；无主键时按原值匹配（D-03）', () => {
    const cs = emptySet();
    cs.updates.push({
      rowKey: { k: 1 },
      original: { k: 1 },
      changes: { k: { old: 1, new: 2 } },
    });
    const items = buildChangeStatements('dbo', 't', cs);
    expect(items[0].sql).toBe('UPDATE [dbo].[t] SET [k] = @p1 WHERE [k] = @p2');
    expect(items[0].params).toEqual([2, 1]);

    // 无主键表（allowNoPrimaryKey 全列匹配）：RowKey 空 + 变更列原值作定位条件
    const orphan = emptySet();
    orphan.updates.push({ rowKey: {}, original: {}, changes: { a: { old: 1, new: 2 } } });
    const orphanItems = buildChangeStatements('dbo', 't', orphan);
    expect(orphanItems[0].sql).toBe('UPDATE [dbo].[t] SET [a] = @p1 WHERE [a] = @p2');
    expect(orphanItems[0].params).toEqual([2, 1]);
  });

  it('delete：WHERE 仅按 RowKey；空 RowKey 抛 E_VALIDATION', () => {
    const cs = emptySet();
    cs.deletes.push({ rowKey: { id: 9 }, original: { id: 9 } });
    const items = buildChangeStatements('dbo', 't', cs);
    expect(items[0].sql).toBe('DELETE FROM [dbo].[t] WHERE [id] = @p1');
    expect(items[0].params).toEqual([9]);

    const bad = emptySet();
    bad.deletes.push({ rowKey: {}, original: {} });
    expect(() => buildChangeStatements('dbo', 't', bad)).toThrowError(/E_VALIDATION|缺少主键/);
  });

  it('对象/数组参数 JSON 化收口（P-53 同族：tedious 对象参数不可直传）；Buffer 透传', () => {
    const cs = emptySet();
    cs.inserts.push({ tempId: 't1', values: { j: { k: 1, arr: [1, 2] } } });
    const items = buildChangeStatements('dbo', 't', cs);
    expect(items[0].params).toEqual(['{"k":1,"arr":[1,2]}']);

    const cs2 = emptySet();
    cs2.inserts.push({ tempId: 't2', values: { b: Buffer.from([1]) } });
    expect(buildChangeStatements('dbo', 't', cs2)[0].params).toEqual([Buffer.from([1])]);
  });

  it('encodeParam 钩子：applyChanges 侧原生参数转换、preview 缺省保持 §5 编码（P-22）', () => {
    const cs = emptySet();
    cs.inserts.push({ tempId: 't1', values: { ts: '2024-06-01 08:30:00.000', n: 'x' } });
    const preview = buildChangeStatements('dbo', 't', cs);
    expect(preview[0].params).toEqual(['2024-06-01 08:30:00.000', 'x']); // §5 原文，Webview 回填依赖

    const applied = buildChangeStatements('dbo', 't', cs, {
      encodeParam: (col, v) => (col === 'ts' ? { kind: 'datetime', value: new Date(Date.UTC(2024, 5, 1, 8, 30)) } : v),
    });
    expect(applied[0].params![0]).toMatchObject({ kind: 'datetime' });
    expect(applied[0].sql).toBe(preview[0].sql); // 预览即执行：语句形状同源
  });

  it('空变更集返回空数组', () => {
    expect(buildChangeStatements('dbo', 't', emptySet())).toEqual([]);
  });
});
