import { describe, expect, it } from 'vitest';
import type { ColumnMeta, IndexMeta, KeyMeta } from '../model/meta';
import { diffColumns, diffTable, diffTableSummaries, type TableBaseline } from './schemaDiff';

function col(name: string, dataType = 'int', nullable = false, isPrimaryKey = false, defaultValue?: string): ColumnMeta {
  return { name, dataType, normalizedType: 'integer', nullable, isPrimaryKey, defaultValue, ordinal: 0 };
}

function baseline(cols: ColumnMeta[], keys: KeyMeta[] = [], indexes: IndexMeta[] = []): TableBaseline {
  return { columns: cols, keys, indexes };
}

describe('列 diff', () => {
  it('两侧同名同形 = same；字段差异精确到 changedFields', () => {
    const out = diffColumns(
      [col('id', 'int', false, true), col('name', 'varchar(64)', true, false, "'x'")],
      [col('id', 'int', false, true), col('name', 'varchar(128)', true, false, "'x'")],
    );
    expect(out.find((c) => c.name === 'id')?.status).toBe('same');
    const name = out.find((c) => c.name === 'name');
    expect(name?.status).toBe('changed');
    expect(name?.changedFields).toEqual(['dataType']);
  });

  it('仅单侧有的列与 defaultValue/comment 差异', () => {
    const out = diffColumns([col('a'), col('gone', 'int', true, false, '0', )], [col('a', 'int', true), col('new')]);
    expect(out.find((c) => c.name === 'gone')?.status).toBe('only-left');
    expect(out.find((c) => c.name === 'new')?.status).toBe('only-right');
    const a = out.find((c) => c.name === 'a');
    expect(a?.changedFields).toEqual(['nullable']);
    // defaultValue 缺省与 '' 等价（不误报）
    const same = diffColumns([col('a', 'int', false, false)], [col('a', 'int', false, false)]);
    expect(same[0].status).toBe('same');
  });
});

describe('表级 diff（键/索引/外键形状对齐，P-57① 口径）', () => {
  it('外键两侧合成名不同但形状同 → same', () => {
    const keys = (fkName: string): KeyMeta[] => [
      { name: 'PRIMARY', kind: 'PK', columns: ['id'] },
      { name: fkName, kind: 'FK', columns: ['pid'], refTable: 'p', refColumns: ['id'], onDelete: 'CASCADE' },
    ];
    const d = diffTable('t', baseline([col('id', 'int', false, true), col('pid')], keys('t_fk_1')), baseline([col('id', 'int', false, true), col('pid')], keys('t_fk_9')));
    expect(d.foreignKeys).toHaveLength(1);
    expect(d.foreignKeys[0].status).toBe('same');
  });

  it('外键动作不同 → changed', () => {
    const keys = (action?: string): KeyMeta[] => [
      { name: 'fk', kind: 'FK', columns: ['pid'], refTable: 'p', refColumns: ['id'], onDelete: action },
    ];
    const d = diffTable('t', baseline([col('pid')], keys('CASCADE')), baseline([col('pid')], keys('SET NULL')));
    expect(d.foreignKeys[0].status).toBe('changed');
  });

  it('索引按名对齐；引擎合成名（sqlite_autoindex_*）不参与', () => {
    const d = diffTable(
      't',
      baseline([col('id')], [], [{ name: 'idx_a', columns: ['a'], unique: false }]),
      baseline([col('id')], [], [{ name: 'idx_a', columns: ['a', 'b'], unique: false }]),
    );
    expect(d.indexes[0].status).toBe('changed');
    const d2 = diffTable(
      't',
      baseline([col('id')], [], [{ name: 'sqlite_autoindex_t_1', columns: ['a'], unique: true }]),
      baseline([col('id')], [], [{ name: 'sqlite_autoindex_t_2', columns: ['a'], unique: true }]),
    );
    expect(d2.indexes).toHaveLength(0);
  });

  it('主键列集变化 → changed；summary 计数', () => {
    const d = diffTable(
      't',
      baseline([col('id', 'int', false, true), col('b'), col('c')]),
      baseline([col('id', 'int', false, true), col('b', 'text'), col('c')]),
    );
    expect(d.primaryKey?.status).toBe('same');
    expect(d.summary.changed).toBe(1);
    const d2 = diffTable('t', baseline([col('id', 'int', false, true), col('b')]), baseline([col('id'), col('b')]));
    expect(d2.primaryKey?.status).toBe('changed');
  });
});

describe('两库表清单汇总', () => {
  it('仅单侧 / 差异降序 / 一致字典序', () => {
    const make = (name: string, cols: ColumnMeta[]): TableBaseline => baseline(cols);
    const baselines = new Map<string, TableBaseline>([
      ['t_same', make('t_same', [col('id')])],
      ['t_diff', make('t_diff', [col('id'), col('x', 'int')])],
      ['t_left', make('t_left', [col('id')])],
      ['a_only_right_side', make('a', [col('id')])],
    ]);
    const diffOf = (table: string): ReturnType<typeof diffTable> => {
      const l = baselines.get(table)!;
      const r =
        table === 't_diff'
          ? make('t_diff', [col('id'), col('x', 'text')])
          : table === 't_left' || table === 't_same'
            ? make(table, [col('id')])
            : make(table, [col('id')]);
      return diffTable(table, l, r);
    };
    const rows = diffTableSummaries(
      [
        { name: 't_same', rowEstimate: 1 },
        { name: 't_diff', rowEstimate: 2 },
        { name: 't_left', rowEstimate: 3 },
      ],
      [
        { name: 't_same', rowEstimate: 1 },
        { name: 't_diff', rowEstimate: 2 },
        { name: 'a_only_right_side', rowEstimate: 0 },
      ],
      diffOf,
    );
    expect(rows.map((r) => [r.table, r.status])).toEqual([
      ['t_diff', 'changed'],
      ['a_only_right_side', 'only-right'],
      ['t_left', 'only-left'],
      ['t_same', 'same'],
    ]);
    expect(rows[0].diffCount).toBe(1);
  });
});
