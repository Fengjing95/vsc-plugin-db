import { describe, expect, it } from 'vitest';
import type { ColumnMeta } from '../model/meta';
import { sortSpecColumns, specFromColumns } from './tableSpec';

function meta(overrides: Partial<ColumnMeta> & { name: string; ordinal: number }): ColumnMeta {
  return {
    dataType: 'varchar(64)',
    normalizedType: 'string',
    nullable: true,
    isPrimaryKey: false,
    ...overrides,
  };
}

describe('specFromColumns（M8-B2 表结构编辑器基线派生）', () => {
  it('ColumnMeta → ColumnSpec：保留 名称/类型/nullable/PK/自增/默认值/注释/ordinal', () => {
    const spec = specFromColumns('users', [
      meta({ name: 'id', ordinal: 1, dataType: 'bigint', normalizedType: 'integer', nullable: false, isPrimaryKey: true, autoIncrement: true, defaultValue: undefined, comment: '主键' }),
      meta({ name: 'status', ordinal: 2, defaultValue: "'active'", comment: '状态' }),
    ], '用户表');
    expect(spec).toEqual({
      name: 'users',
      comment: '用户表',
      columns: [
        { name: 'id', dataType: 'bigint', nullable: false, isPrimaryKey: true, autoIncrement: true, defaultValue: undefined, comment: '主键', ordinal: 1 },
        { name: 'status', dataType: 'varchar(64)', nullable: true, isPrimaryKey: false, autoIncrement: undefined, defaultValue: "'active'", comment: '状态', ordinal: 2 },
      ],
    });
  });

  it('无表注释时 comment 字段为 undefined', () => {
    const spec = specFromColumns('t', [meta({ name: 'a', ordinal: 1 })]);
    expect(spec.comment).toBeUndefined();
  });
});

describe('sortSpecColumns', () => {
  it('按 ordinal 升序稳定排序，不改原数组', () => {
    const a = { name: 'a', dataType: 'int', nullable: true, isPrimaryKey: false, ordinal: 2 };
    const b = { name: 'b', dataType: 'int', nullable: true, isPrimaryKey: false, ordinal: 1 };
    const input = [a, b];
    const sorted = sortSpecColumns(input);
    expect(sorted.map((c) => c.name)).toEqual(['b', 'a']);
    expect(input.map((c) => c.name)).toEqual(['a', 'b']);
  });
});
