import { describe, expect, it } from 'vitest';
import type { ChangeSet } from '../model/rows';
import {
  ChangeSetService,
  emptyChangeSet,
  rowKeyString,
  valuesEqual,
  type ChangeCounts,
} from './changeSetService';

function collect(service: ChangeSetService): { events: Array<{ viewId: string; counts: ChangeCounts }> } {
  const events: Array<{ viewId: string; counts: ChangeCounts }> = [];
  service.subscribe((_viewId, _cs, counts) => events.push({ viewId: _viewId, counts }));
  return { events };
}

describe('rowKeyString / valuesEqual', () => {
  it('RowKey 键序无关', () => {
    expect(rowKeyString({ a: 1, b: 2 })).toBe(rowKeyString({ b: 2, a: 1 }));
    expect(rowKeyString({ a: 1 })).not.toBe(rowKeyString({ a: 2 }));
  });

  it('值相等：对象按 JSON、null 与 严格相等', () => {
    expect(valuesEqual({ a: 1 }, { a: 1 })).toBe(true);
    expect(valuesEqual(null, null)).toBe(true);
    expect(valuesEqual(null, '')).toBe(false);
    expect(valuesEqual('1', 1)).toBe(false);
  });
});

describe('ChangeSetService 更新合并', () => {
  it('同格反复编辑只留一条，old 为最初原值', () => {
    const svc = new ChangeSetService();
    svc.applyOp('v', { op: 'setCell', rowKey: { id: 1 }, column: 'name', old: 'a', new: 'b' });
    svc.applyOp('v', { op: 'setCell', rowKey: { id: 1 }, column: 'name', old: 'b', new: 'c' });
    const cs = svc.get('v');
    expect(cs.updates).toHaveLength(1);
    expect(cs.updates[0].changes.name).toEqual({ old: 'a', new: 'c' });
  });

  it('回改回原值自动消项；全部消项后整个 update 记录移除', () => {
    const svc = new ChangeSetService();
    svc.applyOp('v', { op: 'setCell', rowKey: { id: 1 }, column: 'name', old: 'a', new: 'b' });
    svc.applyOp('v', { op: 'setCell', rowKey: { id: 1 }, column: 'age', old: 1, new: 2 });
    expect(svc.counts('v').updates).toBe(1);
    svc.applyOp('v', { op: 'setCell', rowKey: { id: 1 }, column: 'name', old: 'b', new: 'a' });
    const cs = svc.get('v');
    expect(cs.updates).toHaveLength(1);
    expect(cs.updates[0].changes).toEqual({ age: { old: 1, new: 2 } });
    expect(cs.updates[0].original).toEqual({ id: 1, name: 'a' });
    svc.applyOp('v', { op: 'setCell', rowKey: { id: 1 }, column: 'age', old: 2, new: 1 });
    expect(svc.isEmpty('v')).toBe(true);
  });

  it('不同行不同列互不合并；多列同入一条 original', () => {
    const svc = new ChangeSetService();
    svc.applyOp('v', { op: 'setCell', rowKey: { id: 1 }, column: 'name', old: 'a', new: 'b' });
    svc.applyOp('v', { op: 'setCell', rowKey: { id: 2 }, column: 'name', old: 'x', new: 'y' });
    svc.applyOp('v', { op: 'setCell', rowKey: { id: 1 }, column: 'age', old: 10, new: 20 });
    const cs = svc.get('v');
    expect(cs.updates).toHaveLength(2);
    const row1 = cs.updates.find((u) => u.rowKey.id === 1)!;
    expect(Object.keys(row1.changes).sort()).toEqual(['age', 'name']);
    // original 只需定位键 + 首次触及列原值；后续变更列的原值在 changes[].old
    expect(row1.original).toEqual({ id: 1, name: 'a' });
    expect(row1.changes.age.old).toBe(10);
  });

  it('新值与原值相等的首次 setCell 不产生记录', () => {
    const svc = new ChangeSetService();
    const { events } = collect(svc);
    const changed = svc.applyOp('v', { op: 'setCell', rowKey: { id: 1 }, column: 'name', old: 'a', new: 'a' });
    expect(changed).toBe(false);
    expect(svc.isEmpty('v')).toBe(true);
    expect(events).toHaveLength(0);
  });
});

describe('ChangeSetService 新增行', () => {
  it('addRow 合并同 tempId；setInsertCell 改值；removeRow 移除', () => {
    const svc = new ChangeSetService();
    svc.applyOp('v', { op: 'addRow', tempId: 't1', values: { name: null } });
    svc.applyOp('v', { op: 'setInsertCell', tempId: 't1', column: 'name', value: '新' });
    svc.applyOp('v', { op: 'setInsertCell', tempId: 't1', column: 'age', value: 3 });
    let cs = svc.get('v');
    expect(cs.inserts).toEqual([{ tempId: 't1', values: { name: '新', age: 3 } }]);
    svc.applyOp('v', { op: 'removeRow', tempId: 't1' });
    cs = svc.get('v');
    expect(cs.inserts).toHaveLength(0);
  });

  it('setInsertCell 指向不存在的 tempId 抛错', () => {
    const svc = new ChangeSetService();
    expect(() => svc.applyOp('v', { op: 'setInsertCell', tempId: 'nope', column: 'a', value: 1 })).toThrow();
  });
});

describe('ChangeSetService 删除行与撤销', () => {
  it('markDelete 吞并同行 update，unmarkDelete 恢复', () => {
    const svc = new ChangeSetService();
    svc.applyOp('v', { op: 'setCell', rowKey: { id: 1 }, column: 'name', old: 'a', new: 'b' });
    svc.applyOp('v', { op: 'markDelete', rowKey: { id: 1 } });
    const cs = svc.get('v');
    expect(cs.updates).toHaveLength(0);
    expect(cs.deletes).toEqual([{ rowKey: { id: 1 }, original: { id: 1 } }]);
    expect(svc.counts('v').deletes).toBe(1);
    svc.applyOp('v', { op: 'unmarkDelete', rowKey: { id: 1 } });
    expect(svc.isEmpty('v')).toBe(true);
  });

  it('revertRow 清除该行 update+delete；revertRow 对无关行无效果', () => {
    const svc = new ChangeSetService();
    svc.applyOp('v', { op: 'setCell', rowKey: { id: 1 }, column: 'name', old: 'a', new: 'b' });
    svc.applyOp('v', { op: 'markDelete', rowKey: { id: 2 } });
    svc.applyOp('v', { op: 'revertRow', rowKey: { id: 2 } });
    const cs = svc.get('v');
    expect(cs.updates).toHaveLength(1);
    expect(cs.deletes).toHaveLength(0);
  });

  it('clear 清空并通知', () => {
    const svc = new ChangeSetService();
    const { events } = collect(svc);
    svc.applyOp('v', { op: 'markDelete', rowKey: { id: 1 } });
    svc.clear('v');
    expect(svc.isEmpty('v')).toBe(true);
    expect(events.at(-1)?.counts).toEqual({ inserts: 0, updates: 0, deletes: 0 });
  });
});

describe('ChangeSetService 快照往返', () => {
  it('snapshot 深拷贝；restore 恢复到新视图', () => {
    const svc = new ChangeSetService();
    svc.applyOp('v1', { op: 'setCell', rowKey: { id: 1 }, column: 'name', old: 'a', new: 'b' });
    svc.applyOp('v1', { op: 'addRow', tempId: 't1', values: { name: 'n' } });
    svc.applyOp('v1', { op: 'markDelete', rowKey: { id: 2 } });
    const snap = svc.snapshot('v1');

    // 修改原视图不影响快照
    svc.clear('v1');
    expect(snap.updates).toHaveLength(1);

    const svc2 = new ChangeSetService();
    svc2.restore('v2', snap);
    expect(svc2.snapshot('v2')).toEqual(snap);
    expect(svc2.counts('v2')).toEqual({ inserts: 1, updates: 1, deletes: 1 });
  });

  it('restore 空 ChangeSet 等价 emptyChangeSet', () => {
    const svc = new ChangeSetService();
    svc.restore('v', emptyChangeSet());
    expect(svc.snapshot('v')).toEqual(emptyChangeSet() satisfies ChangeSet);
  });
});
