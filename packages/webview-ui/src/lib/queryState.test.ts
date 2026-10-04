import { describe, expect, it } from 'vitest';
import { encodeMultiValues, encodeScalar, opsForType, opValueShape } from './filterOps';
import { buildQueryParams, formatEstimate, maxExploredPage, paginationLabel, updateCursorStack } from './queryState';

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

  it('offset = page × pageSize；空条件不产生 whereSql/orderBySql', () => {
    const params = buildQueryParams(
      {
        connId: 'c',
        db: 'demo',
        obj: 'users',
        page: 3,
        pageSize: 100,
        where: '',
        orderBy: '',
        search: '',
        visibleColumns: null,
      },
    );
    expect(params.offset).toBe(300);
    expect(params.limit).toBe(100);
    expect(params.whereSql).toBeUndefined();
    expect(params.orderBySql).toBeUndefined();
    expect(params.search).toBeUndefined();
    expect(params.columns).toBeUndefined();
  });

  it('where/orderBy 片段透传（非空才下发）', () => {
    const params = buildQueryParams(
      {
        connId: 'c',
        db: 'demo',
        obj: 'users',
        page: 0,
        pageSize: 50,
        where: "status = 'active'",
        orderBy: 'created_at DESC',
        search: '张',
        visibleColumns: ['id', 'status'],
      },
    );
    expect(params.whereSql).toBe("status = 'active'");
    expect(params.orderBySql).toBe('created_at DESC');
    expect(params.search).toBe('张');
    expect(params.columns).toEqual(['id', 'status']);
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


describe('buildQueryParams cursor 模式（M7 透传）', () => {
  const base = { connId: 'c1', db: 'db0', obj: '*', pageSize: 50, where: '', orderBy: '', search: '', visibleColumns: null };

  it('offset 模式（缺省）：offset = page × pageSize，不下发 cursor', () => {
    const p = buildQueryParams({ ...base, page: 3, pagination: 'offset' });
    expect(p.offset).toBe(150);
    expect(p.cursor).toBeUndefined();
  });

  it('cursor 模式：下发游标且省略 offset（两者互斥）', () => {
    const p = buildQueryParams({ ...base, page: 2, pagination: 'cursor', cursor: 'cur-2' });
    expect(p.cursor).toBe('cur-2');
    expect(p.offset).toBeUndefined();
  });

  it('cursor 模式首页（无游标）：不下发 cursor 与 offset', () => {
    const p = buildQueryParams({ ...base, page: 0, pagination: 'cursor' });
    expect(p.cursor).toBeUndefined();
    expect(p.offset).toBeUndefined();
  });
});

describe('updateCursorStack / maxExploredPage（游标栈）', () => {
  it('推进下一页游标，不破坏既有栈', () => {
    const s1 = updateCursorStack([undefined], 0, 'c1');
    expect(s1).toEqual([undefined, 'c1']);
    const s2 = updateCursorStack(s1, 1, 'c2');
    expect(s2).toEqual([undefined, 'c1', 'c2']);
  });

  it('尽头（无 nextCursor）：下一页槽位记 undefined', () => {
    const s = updateCursorStack([undefined, 'c1'], 1, undefined);
    expect(s).toEqual([undefined, 'c1', undefined]);
  });

  it('不可变更新（原栈不受影响）', () => {
    const original = [undefined];
    updateCursorStack(original, 0, 'c1');
    expect(original).toEqual([undefined]);
  });

  it('maxExploredPage：cursors.length - 1，空栈为 0', () => {
    expect(maxExploredPage([undefined])).toBe(0);
    expect(maxExploredPage([undefined, 'c1', 'c2'])).toBe(2);
  });
});