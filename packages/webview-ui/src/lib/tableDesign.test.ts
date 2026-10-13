import { describe, expect, it } from 'vitest';
import type { TableSpecPayload } from '@db-explorer/protocol';
import {
  columnNameError,
  columnRowError,
  columnTypeError,
  diffSpecSummary,
  diffSummaryText,
  destructiveCount,
  nextOrdinal,
  tableSpecError,
  type ColumnRow,
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
