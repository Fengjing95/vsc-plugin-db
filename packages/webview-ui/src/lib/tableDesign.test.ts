import { describe, expect, it } from 'vitest';
import type { TableSpecPayload } from '@db-explorer/protocol';
import {
  columnNameError,
  columnRowError,
  columnTypeError,
  diffSpecSummary,
  diffSummaryText,
  diffSummaryTextExtended,
  destructiveCount,
  fkNameError,
  fkPairCount,
  fkPairError,
  fkRefTableError,
  fkRowError,
  idxRowError,
  nextOrdinal,
  tableSpecError,
  ukRowError,
  type ColumnRow,
  type FkRow,
  type IdxRow,
  type UkRow,
} from './tableDesign';

function row(rowId: string, name: string, overrides: Partial<ColumnRow['col']> = {}): ColumnRow {
  return {
    rowId,
    col: { name, dataType: 'varchar(64)', nullable: true, isPrimaryKey: false, ordinal: 1, ...overrides },
  };
}

const baseline: TableSpecPayload = {
  name: 'users',
  comment: '用户表',
  columns: [
    { name: 'id', dataType: 'bigint', nullable: false, isPrimaryKey: true, ordinal: 1 },
    { name: 'uname', dataType: 'varchar(64)', nullable: false, isPrimaryKey: false, ordinal: 2 },
  ],
};

describe('diffSpecSummary（M8-B2 变更统计）', () => {
  it('新增/删除/修改计数；按列名对齐', () => {
    const rows = [
      row('r1', 'id', { dataType: 'bigint', nullable: false, isPrimaryKey: true }),
      row('r2', 'uname', { nullable: false }), // 未变
      row('r3', 'extra'), // 新增
    ];
    expect(diffSpecSummary(baseline, rows)).toEqual({ added: 1, removed: 0, modified: 0 });
    expect(diffSpecSummary(baseline, [row('r1', 'id', { dataType: 'bigint', nullable: false, isPrimaryKey: true })])).toEqual({
      added: 0,
      removed: 1,
      modified: 0,
    });
    expect(diffSpecSummary(baseline, [row('r1', 'id', { dataType: 'bigint', nullable: false, isPrimaryKey: true }), row('r2', 'uname', { nullable: true })])).toEqual({
      added: 0,
      removed: 0,
      modified: 1,
    });
  });

  it('删除标记的行不计入新增；create 态（无基线）全 0', () => {
    const rows = [row('r1', 'id', { dataType: 'bigint', nullable: false, isPrimaryKey: true }), { ...row('r3', 'extra'), deleted: true }];
    expect(diffSpecSummary(baseline, rows)).toEqual({ added: 0, removed: 1, modified: 0 });
    expect(diffSpecSummary(null, rows)).toEqual({ added: 0, removed: 0, modified: 0 });
  });

  it('diffSummaryText：全 0 为 undefined', () => {
    expect(diffSummaryText({ added: 1, removed: 2, modified: 0 })).toBe('新增 1 列 · 删除 2 列');
    expect(diffSummaryText({ added: 0, removed: 0, modified: 0 })).toBeUndefined();
  });
});

describe('校验（前端即时提示，错误按字段归属拆分）', () => {
  it('列名空/重复/类型空', () => {
    const rows = [row('r1', 'id'), row('r2', 'id')];
    expect(columnRowError({ ...row('r3', ''), deleted: false }, rows)).toBe('列名不能为空');
    expect(columnRowError(rows[0], rows)).toBe('列名 "id" 重复');
    expect(columnRowError({ ...row('r4', 'ok', { dataType: '' }) }, rows)).toBe('类型不能为空');
    expect(columnRowError(row('r5', 'ok'), rows)).toBeUndefined();
    expect(columnRowError({ ...row('r2', 'id'), deleted: true }, rows)).toBeUndefined(); // 删除行不校验
  });

  it('字段级拆分：类型错误只归类型位，列名错误只归列名位（§12.3 错误位预留）', () => {
    const rows = [row('r1', 'id'), row('r2', 'id')];
    expect(columnNameError(rows[0], rows)).toBe('列名 "id" 重复');
    expect(columnTypeError(rows[0])).toBeUndefined();
    expect(columnNameError(row('r4', 'ok', { dataType: '' }), rows)).toBeUndefined();
    expect(columnTypeError(row('r4', 'ok', { dataType: '' }))).toBe('类型不能为空');
    // 类型错误不再挂到列名位（回归：v0.2.1 统一挂在列名下的旧行为）
    const typeOnly = row('r5', 'ok', { dataType: '' });
    expect(columnNameError(typeOnly, rows)).toBeUndefined();
    expect(columnRowError(typeOnly, rows)).toBe('类型不能为空');
    // 删除行两类都不校验
    expect(columnNameError({ ...row('r6', 'x'), deleted: true }, rows)).toBeUndefined();
    expect(columnTypeError({ ...row('r6', 'x', { dataType: '' }), deleted: true })).toBeUndefined();
  });

  it('tableSpecError：表名/列数/列级错误；无主键建表不阻塞', () => {
    expect(tableSpecError('create', '', [row('r1', 'a')])).toBe('表名不能为空');
    expect(tableSpecError('create', 't', [])).toBe('表至少需要一列');
    expect(tableSpecError('create', 't', [row('r1', '')])).toBe('列名不能为空');
    expect(tableSpecError('create', 't', [row('r1', 'a')])).toBeUndefined();
    expect(tableSpecError('alter', 't', [row('r1', 'a')])).toBeUndefined();
  });

  it('nextOrdinal 与 destructiveCount', () => {
    expect(nextOrdinal([row('r1', 'a', { ordinal: 3 }), row('r2', 'b', { ordinal: 1 })])).toBe(4);
    expect(destructiveCount([{ sql: 'a' }, { sql: 'b', destructive: true }])).toBe(1);
  });
});

describe('键/外键/索引校验（表设计器批次 B，§12.4~12.6）', () => {
  const uk = (rowId: string, spec: Partial<UkRow['spec']> = {}): UkRow => ({
    rowId,
    spec: { columns: ['a'], ...spec },
  });
  const fk = (rowId: string, spec: Partial<FkRow['spec']> = {}): FkRow => ({
    rowId,
    spec: { columns: ['a'], refTable: 't1', refColumns: ['id'], ...spec },
  });
  const idx = (rowId: string, spec: Partial<IdxRow['spec']> = {}): IdxRow => ({
    rowId,
    spec: { columns: ['a'], ...spec },
  });

  it('ukRowError：列空/重名；删除行不校验', () => {
    expect(ukRowError(uk('r1', { columns: [] }), [uk('r1')])).toBe('唯一键至少需要一列');
    expect(ukRowError(uk('r1', { name: 'uk_1' }), [uk('r2', { name: 'uk_1' })])).toBe('唯一键名 "uk_1" 重复');
    expect(ukRowError(uk('r1', { name: 'uk_1' }), [uk('r2', { name: 'uk_2' })])).toBeUndefined();
    expect(ukRowError({ ...uk('r1', { columns: [] }), deleted: true }, [])).toBeUndefined();
  });

  it('fkRowError：引用表空/列对应不完整/重名（§12.5 成对映射口径）', () => {
    expect(fkRowError(fk('r1', { refTable: '' }), [fk('r1')])).toBe('引用表不能为空');
    expect(fkRowError(fk('r1', { columns: [], refColumns: [] }), [fk('r1')])).toBe('至少需要一组列对应（本表列 → 引用列）');
    expect(fkRowError(fk('r1', { refColumns: [] }), [fk('r1')])).toBe('缺少引用列');
    expect(fkRowError(fk('r1', { columns: [] }), [fk('r1')])).toBe('缺少本表列');
    expect(fkRowError(fk('r1', { name: 'fk_1' }), [fk('r2', { name: 'fk_1' })])).toBe('外键名 "fk_1" 重复');
    expect(fkRowError(fk('r1'), [fk('r2')])).toBeUndefined();
  });

  it('fkPairError/fkRefTableError/fkNameError 分字段校验（显示在各自控件旁）', () => {
    // 对应组两侧全空：仅首组提示待填写，后续空组静默（可留作增行占位）
    expect(fkPairError(fk('r1', { columns: [], refColumns: [] }), 0)).toBe('至少需要一组列对应（本表列 → 引用列）');
    expect(fkPairError(fk('r1', { columns: [], refColumns: [] }), 1)).toBeUndefined();
    expect(fkPairError(fk('r1', { refColumns: [] }), 0)).toBe('缺少引用列');
    expect(fkPairError(fk('r1', { columns: [] }), 0)).toBe('缺少本表列');
    expect(fkPairError(fk('r1'), 0)).toBeUndefined();
    expect(fkRefTableError(fk('r1'))).toBeUndefined();
    expect(fkRefTableError(fk('r1', { refTable: ' ' }))).toBe('引用表不能为空');
    expect(fkNameError(fk('r1', { name: 'fk_x' }), [fk('r2', { name: 'fk_x' })])).toBe('外键名 "fk_x" 重复');
    // 删除行三类都不校验
    const deleted = { ...fk('r3', { refTable: '' }), deleted: true } as FkRow;
    expect(fkPairError(deleted, 0)).toBeUndefined();
    expect(fkRefTableError(deleted)).toBeUndefined();
    expect(fkNameError(deleted, [fk('r4')])).toBeUndefined();
  });

  it('fkPairCount：列对应组数 = 两侧数组较长者，至少 1（新增空组可编辑）', () => {
    expect(fkPairCount(fk('r1'))).toBe(1);
    expect(fkPairCount(fk('r1', { columns: ['a', 'b'], refColumns: ['x'] }))).toBe(2);
    expect(fkPairCount(fk('r1', { columns: [], refColumns: [] }))).toBe(1);
  });

  it('idxRowError：列空/重名', () => {
    expect(idxRowError(idx('r1', { columns: [] }), [idx('r1')])).toBe('索引至少需要一列');
    expect(idxRowError(idx('r1', { name: 'idx_1' }), [idx('r2', { name: 'idx_1' })])).toBe('索引名 "idx_1" 重复');
    expect(idxRowError(idx('r1'), [idx('r2')])).toBeUndefined();
  });

  it('diffSummaryTextExtended：列与键/外键/索引合并计数；全 0 undefined', () => {
    const base: TableSpecPayload = {
      name: 't',
      columns: [{ name: 'id', dataType: 'bigint', nullable: false, isPrimaryKey: true, ordinal: 1 }],
      uniqueKeys: [{ name: 'uk_1', columns: ['id'] }],
      foreignKeys: [{ name: 'fk_1', columns: ['id'], refTable: 'r', refColumns: ['id'] }],
      indexes: [{ name: 'idx_1', columns: ['id'] }],
    };
    expect(diffSummaryTextExtended(base, [row('r1', 'id', { dataType: 'bigint', nullable: false, isPrimaryKey: true })], [uk('u1', { name: 'uk_1', columns: ['id'] })], [fk('f1', { name: 'fk_1', columns: ['id'], refTable: 'r', refColumns: ['id'] })], [idx('i1', { name: 'idx_1', columns: ['id'] })])).toBeUndefined();
    const text = diffSummaryTextExtended(
      base,
      [row('r1', 'id', { dataType: 'bigint', nullable: false, isPrimaryKey: true }), row('r2', 'extra')],
      [uk('u1', { name: 'uk_1', columns: ['id'] }), uk('u2', { name: 'uk_2', columns: ['id'] })],
      [],
      [idx('i1', { name: 'idx_1', columns: ['id'], unique: true })],
    );
    expect(text).toBe('新增 1 列 · 新增 1 唯一键 · 删除 1 外键 · 修改 1 索引');
  });
});
