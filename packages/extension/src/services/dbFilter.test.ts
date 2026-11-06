import { describe, expect, it } from 'vitest';
import type { DatabaseMeta } from '@db-explorer/core';
import { applyDbFilter, visibleDatabasesFromSelection } from './dbFilter';

const dbs: DatabaseMeta[] = [
  { name: 'main' },
  { name: 'sales' },
  { name: 'hr' },
  { name: 'archive' },
];

describe('applyDbFilter（D-33 树展示层过滤）', () => {
  it('visible 为 undefined/空 = 显示全部，无失效项', () => {
    expect(applyDbFilter(dbs, undefined)).toEqual({ rows: dbs, stale: [], converged: undefined });
    expect(applyDbFilter(dbs, [])).toEqual({ rows: dbs, stale: [], converged: undefined });
  });

  it('筛选生效：只保留命中库，保持服务端返回序', () => {
    const r = applyDbFilter(dbs, ['archive', 'sales']);
    expect(r.rows.map((d) => d.name)).toEqual(['sales', 'archive']);
    expect(r.stale).toEqual([]);
    expect(r.converged).toEqual(['sales', 'archive']);
  });

  it('筛选含失效项：渲染时忽略，converged 收敛为交集（服务端序）', () => {
    const r = applyDbFilter(dbs, ['sales', 'ghost', 'hr', 'deleted']);
    expect(r.rows.map((d) => d.name)).toEqual(['sales', 'hr']);
    expect(r.stale).toEqual(['ghost', 'deleted']);
    expect(r.converged).toEqual(['sales', 'hr']);
  });

  it('交集为空 = 筛选全失效 → converged undefined（调用方应清除筛选回全部）', () => {
    const r = applyDbFilter(dbs, ['ghost', 'deleted']);
    expect(r.rows).toEqual([]);
    expect(r.stale).toEqual(['ghost', 'deleted']);
    expect(r.converged).toBeUndefined();
  });
});

describe('visibleDatabasesFromSelection（QuickPick 应用 → 存储值）', () => {
  const all = ['main', 'sales', 'hr'];

  it('picked 空 = 清除（undefined）', () => {
    expect(visibleDatabasesFromSelection(undefined, all)).toBeUndefined();
    expect(visibleDatabasesFromSelection([], all)).toBeUndefined();
  });

  it('勾选全部 = 等价无筛选，清除（避免「已筛选 m/m」假计数）', () => {
    expect(visibleDatabasesFromSelection(['hr', 'main', 'sales'], all)).toBeUndefined();
  });

  it('部分勾选按服务端序收口（与勾选顺序无关）', () => {
    expect(visibleDatabasesFromSelection(['hr', 'main'], all)).toEqual(['main', 'hr']);
  });

  it('picked 含未知项：以服务端候选为准过滤掉', () => {
    expect(visibleDatabasesFromSelection(['main', 'ghost'], all)).toEqual(['main']);
  });
});
