import { describe, expect, it } from 'vitest';
import { encodeMultiValues, encodeScalar, opsForType, opValueShape } from './filterOps';
import { buildQueryParams, draftsToFilters, formatEstimate, nextSort, paginationLabel } from './queryState';
import type { FilterDraft } from './filterOps';

function draft(partial: Partial<FilterDraft>): FilterDraft {
  return { id: 'd1', column: 'c', op: 'eq', value: '', value2: '', ...partial };
}

describe('opsForType（交互稿 §4.4：操作符按列类型过滤）', () => {
  it('文本列含 like，不含 between', () => {
    const ops = opsForType('string');
    expect(ops).toContain('like');
    expect(ops).not.toContain('between');
  });
  it('数值列含 between，不含 like', () => {
    const ops = opsForType('integer');
    expect(ops).toContain('between');
    expect(ops).not.toContain('like');
  });
  it('二进制列仅 NULL 判定', () => {
    expect(opsForType('binary')).toEqual(['isNull', 'isNotNull']);
  });
});

describe('opValueShape', () => {
  it('isNull 无输入，between 双值，in 多值', () => {
    expect(opValueShape('isNull')).toBe('none');
    expect(opValueShape('between')).toBe('double');
    expect(opValueShape('in')).toBe('multi');
    expect(opValueShape('eq')).toBe('single');
  });
});

describe('值编码（概要设计 §4.4）', () => {
  it('整数/浮点 → number；无法解析时保留字符串', () => {
    expect(encodeScalar('integer', '42')).toBe(42);
    expect(encodeScalar('float', '3.5')).toBe(3.5);
    expect(encodeScalar('integer', 'abc')).toBe('abc');
  });
  it('DECIMAL → 字符串原样（保精度）', () => {
    expect(encodeScalar('decimal', '15.00')).toBe('15.00');
  });
  it('in 多值：换行/逗号分隔，空项剔除', () => {
    expect(encodeMultiValues('integer', '1\n2, 3\n\n')).toEqual([1, 2, 3]);
    expect(encodeMultiValues('string', 'a，b')).toEqual(['a', 'b']);
  });
});

describe('buildQueryParams', () => {
  const columns = [
    { name: 'id', type: 'integer' },
    { name: 'status', type: 'string' },
  ];

  it('offset = page × pageSize；空草稿不产生 filters', () => {
    const params = buildQueryParams(
      {
        connId: 'c',
        db: 'demo',
        obj: 'users',
        page: 3,
        pageSize: 100,
        sorts: [],
        drafts: [],
        search: '',
        visibleColumns: null,
      },
      columns,
    );
    expect(params.offset).toBe(300);
    expect(params.limit).toBe(100);
    expect(params.filters).toEqual([]);
    expect(params.sorts).toBeUndefined();
    expect(params.search).toBeUndefined();
    expect(params.columns).toBeUndefined();
  });

  it('草稿 → 下推条件（值类型化）', () => {
    const params = buildQueryParams(
      {
        connId: 'c',
        db: 'demo',
        obj: 'users',
        page: 0,
        pageSize: 50,
        sorts: [{ column: 'id', dir: 'asc' }],
        drafts: [draft({ column: 'id', op: 'gt', value: '10' })],
        search: '张',
        visibleColumns: ['id', 'status'],
      },
      columns,
    );
    expect(params.filters).toEqual([{ column: 'id', op: 'gt', value: 10 }]);
    expect(params.sorts).toEqual([{ column: 'id', dir: 'asc' }]);
    expect(params.search).toBe('张');
    expect(params.columns).toEqual(['id', 'status']);
  });

  it('draftsToFilters 丢弃值缺失的非法行', () => {
    const filters = draftsToFilters(
      [draft({ column: 'status', op: 'eq', value: '' })],
      columns,
    );
    expect(filters).toEqual([]);
  });
});

describe('nextSort（三态循环）', () => {
  it('无 → asc → desc → 无', () => {
    expect(nextSort([], 'a')).toEqual([{ column: 'a', dir: 'asc' }]);
    expect(nextSort([{ column: 'a', dir: 'asc' }], 'a')).toEqual([{ column: 'a', dir: 'desc' }]);
    expect(nextSort([{ column: 'a', dir: 'desc' }], 'a')).toEqual([]);
  });
  it('切换列时保留既有排序（多列）', () => {
    expect(nextSort([{ column: 'a', dir: 'asc' }], 'b')).toEqual([
      { column: 'a', dir: 'asc' },
      { column: 'b', dir: 'asc' },
    ]);
  });
});

describe('paginationLabel（交互稿 §4.7 分页栏细则）', () => {
  it('totalCount 已知：第 X-Y 行 / 共 N 行', () => {
    expect(
      paginationLabel({ page: 1, pageSize: 50, loadedRows: 50, totalCount: 12345 }),
    ).toBe('第 51-100 行 / 共 12345 行');
  });
  it('totalCount 缺省 + rowEstimate：约 N 行（“约”字必须带）', () => {
    const label = paginationLabel({ page: 0, pageSize: 50, loadedRows: 50, rowEstimate: 12300 });
    expect(label).toBe('第 1-50 行 · 约 12.3k 行');
  });
  it('均缺省：仅显示区间', () => {
    expect(paginationLabel({ page: 0, pageSize: 50, loadedRows: 30 })).toBe('第 1-30 行');
  });
  it('formatEstimate：万级用 k 单位', () => {
    expect(formatEstimate(50000)).toBe('50k');
    expect(formatEstimate(12300)).toBe('12.3k');
    expect(formatEstimate(999)).toBe('999');
  });
});
