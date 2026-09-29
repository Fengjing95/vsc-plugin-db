import { describe, expect, it } from 'vitest';
import {
  applyOverlay,
  countEdits,
  effectiveFetchColumns,
  insertRowToArray,
  mergeSetCell,
  overlayFromSnapshot,
  rowKeyOfRow,
  rowKeyString,
} from './editOverlay';

const COLS = [
  { name: 'id', type: 'integer' },
  { name: 'name', type: 'string' },
  { name: 'note', type: 'string' },
];

describe('rowKeyString / rowKeyOfRow', () => {
  it('键序无关', () => {
    expect(rowKeyString({ a: 1, b: 2 })).toBe(rowKeyString({ b: 2, a: 1 }));
  });

  it('主键行取主键映射；无主键取全行', () => {
    const row = [1, 'n', null];
    expect(rowKeyOfRow(row, COLS, ['id'])).toEqual({ id: 1 });
    expect(rowKeyOfRow(row, COLS, [])).toEqual({ id: 1, name: 'n', note: null });
  });
});

describe('mergeSetCell', () => {
  it('反复编辑保留最初 old', () => {
    let o = mergeSetCell(undefined, { id: 1 }, 'name', 'a', 'b');
    o = mergeSetCell(o!, { id: 1 }, 'name', 'b', 'c');
    expect(o!.cells.name).toEqual({ old: 'a', new: 'c' });
  });

  it('回改原值消项；消空后移除', () => {
    let o = mergeSetCell(undefined, { id: 1 }, 'name', 'a', 'b');
    o = mergeSetCell(o!, { id: 1 }, 'name', 'b', 'a');
    expect(o).toBeNull();
  });

  it('首改即原值：无变化', () => {
    expect(mergeSetCell(undefined, { id: 1 }, 'name', 'a', 'a')).toBeNull();
  });

  it('多列共享基线，original 补被改列首次原值', () => {
    let o = mergeSetCell(undefined, { id: 1 }, 'name', 'a', 'b');
    o = mergeSetCell(o!, { id: 1 }, 'note', null, 'x');
    expect(o!.original).toEqual({ id: 1, name: 'a', note: null });
  });
});

describe('overlayFromSnapshot / applyOverlay', () => {
  it('快照还原覆盖层并应用到行', () => {
    const { updates, deletes, inserts } = overlayFromSnapshot({
      inserts: [{ tempId: 't1', values: { name: 'n' } }],
      updates: [
        {
          rowKey: { id: 1 },
          original: { id: 1, name: 'a' },
          changes: { name: { old: 'a', new: 'b' }, note: { old: null, new: 'x' } },
        },
      ],
      deletes: [{ rowKey: { id: 2 }, original: { id: 2 } }],
    });
    expect(updates[rowKeyString({ id: 1 })]!.cells.name!.new).toBe('b');
    expect(deletes[rowKeyString({ id: 2 })]).toBe(true);
    expect(inserts).toHaveLength(1);
    const row = applyOverlay([1, 'a', null], COLS, updates[rowKeyString({ id: 1 })]);
    expect(row).toEqual([1, 'b', 'x']);
  });
});

describe('insertRowToArray / countEdits / effectiveFetchColumns', () => {
  it('插入行按列序对齐，缺列 null', () => {
    expect(insertRowToArray({ name: 'n' }, COLS)).toEqual([null, 'n', null]);
  });

  it('计数汇总', () => {
    expect(countEdits({ updates: { a: 1, b: 2 }, deletes: { c: 1 }, inserts: [{}] })).toEqual({
      total: 4,
      inserts: 1,
      updates: 2,
      deletes: 1,
    });
  });

  it('取数列 = 投影 ∪ 主键；无主键强制全列', () => {
    expect(effectiveFetchColumns(['name'], ['id'], COLS)).toEqual(['id', 'name']);
    expect(effectiveFetchColumns(null, ['id'], COLS)).toBeUndefined();
    expect(effectiveFetchColumns(['name'], [], COLS)).toBeUndefined();
  });
});
