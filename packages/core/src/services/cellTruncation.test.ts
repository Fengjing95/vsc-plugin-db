import { describe, expect, it } from 'vitest';
import { truncateResultSetCells } from './cellTruncation';
import type { NormalizedType } from '../model/meta';
import type { ResultSet } from '../model/rows';

function rsOf(columns: Array<{ name: string; type: NormalizedType }>, rows: unknown[][]): ResultSet {
  return { columns, rows, rowCount: rows.length, executionMs: 1 };
}

describe('truncateResultSetCells', () => {
  it('无超长单元格时原样返回（同一引用、零标记）', () => {
    const rs = rsOf(
      [{ name: 'id', type: 'integer' }, { name: 'txt', type: 'string' }],
      [[1, 'short'], [2, null]],
    );
    const out = truncateResultSetCells(rs, 100);
    expect(out.rs).toBe(rs);
    expect(out.truncatedCells).toEqual([]);
  });

  it('超长文本截断为前缀并落坐标标记，其余单元格不动', () => {
    const long = 'x'.repeat(300);
    const rs = rsOf(
      [{ name: 'id', type: 'integer' }, { name: 'txt', type: 'string' }, { name: 'keep', type: 'string' }],
      [[1, long, 'ok'], [2, 'fine', null]],
    );
    const out = truncateResultSetCells(rs, 100);
    expect(out.truncatedCells).toEqual([[0, 1]]);
    expect(out.rs.rows[0][1]).toBe('x'.repeat(100));
    expect(out.rs.rows[0][2]).toBe('ok');
    expect(out.rs.rows[1]).toBe(rs.rows[1]); // 未变更行保持原引用
  });

  it('binary 列按 4 字符对齐切分 base64', () => {
    const b64 = 'A'.repeat(103); // 103 % 4 = 3
    const rs = rsOf([{ name: 'blob', type: 'binary' }], [[b64]]);
    const out = truncateResultSetCells(rs, 100);
    expect(out.truncatedCells).toEqual([[0, 0]]);
    expect((out.rs.rows[0][0] as string).length).toBe(100); // 100 % 4 === 0
  });

  it('JSON/对象单元格不截断（D-30 岔口 2）', () => {
    const big = { data: 'y'.repeat(500) };
    const rs = rsOf([{ name: 'doc', type: 'json' }], [[big]]);
    const out = truncateResultSetCells(rs, 100);
    expect(out.rs).toBe(rs);
    expect(out.truncatedCells).toEqual([]);
  });

  it('文本前缀不切在代理对中间', () => {
    const text = 'a'.repeat(99) + '😀' + 'b'.repeat(50); // 😀 起始下标 99（占据 99/100 两个码元）
    const rs = rsOf([{ name: 'txt', type: 'string' }], [[text]]);
    const out = truncateResultSetCells(rs, 100);
    const prefix = out.rs.rows[0][0] as string;
    expect(prefix).toBe('a'.repeat(99));
    expect(out.truncatedCells).toEqual([[0, 0]]);
  });

  it('maxChars 非正/非法时 fail-safe 跳过截断', () => {
    const rs = rsOf([{ name: 'txt', type: 'string' }], [['z'.repeat(999)]]);
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const out = truncateResultSetCells(rs, bad);
      expect(out.rs).toBe(rs);
      expect(out.truncatedCells).toEqual([]);
    }
  });

  it('多行多列截断坐标按行列序累积', () => {
    const long = 'q'.repeat(500);
    const rs = rsOf(
      [{ name: 'a', type: 'string' }, { name: 'b', type: 'string' }],
      [[long, long], ['s', long]],
    );
    const out = truncateResultSetCells(rs, 100);
    expect(out.truncatedCells).toEqual([[0, 0], [0, 1], [1, 1]]);
  });
});
