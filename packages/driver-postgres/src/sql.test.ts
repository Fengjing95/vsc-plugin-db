import { describe, expect, it } from 'vitest';
import { DriverError, type FilterCondition } from '@db-explorer/core';
import {
  buildSelect,
  encodeCell,
  escapeLike,
  fragmentHasColumn,
  normalizePgType,
  normalizeTimeText,
  normalizeTimestampText,
  normalizeTimestamptzText,
  quotePgIdentifier,
} from './sql';

/** 语句形状契约（P-9 同族）：筛选下推的参数化无法经 IConnection 观测，由构建层单测覆盖 */
describe('buildSelect（M8-PG）', () => {
  it('基础：双引号 schema.obj 限定、$n 占位符、LIMIT/OFFSET 参数化', () => {
    const built = buildSelect({
      db: 'public',
      obj: 'users',
      searchColumns: ['name'],
      limit: 50,
      offset: 100,
    });
    expect(built.sql).toBe('SELECT * FROM "public"."users" LIMIT $1 OFFSET $2');
    expect(built.params).toEqual([50, 100]);
    // 无值拼接：语句文本不含任何字面量值
    expect(/\b\d+\b LIMIT/.test(built.sql)).toBe(false);
  });

  it('columns 指定：列名双引号引用', () => {
    const built = buildSelect({
      db: 'app',
      obj: 't',
      columns: ['id', 'name'],
      searchColumns: ['name'],
      limit: 10,
    });
    expect(built.sql).toBe('SELECT "id", "name" FROM "app"."t" LIMIT $1');
  });

  const col = (name: string, cond: FilterCondition, extra: Partial<Parameters<typeof buildSelect>[0]> = {}) =>
    buildSelect({ db: 'public', obj: 't', filters: [cond], searchColumns: ['name'], limit: 10, ...extra });

  it('每个 FilterOp 生成 $n 占位符且无值拼接（概要 §8）', () => {
    const cases: FilterCondition[] = [
      { column: 'a', op: 'eq', value: 'x' },
      { column: 'a', op: 'ne', value: 'x' },
      { column: 'a', op: 'gt', value: 1 },
      { column: 'a', op: 'ge', value: 1 },
      { column: 'a', op: 'lt', value: 1 },
      { column: 'a', op: 'le', value: 1 },
      { column: 'a', op: 'like', value: 'x' },
      { column: 'a', op: 'notLike', value: 'x' },
      { column: 'a', op: 'in', values: ['x', 'y'] },
      { column: 'a', op: 'notIn', values: ['x', 'y'] },
      { column: 'a', op: 'between', values: [1, 9] },
      { column: 'a', op: 'isNull' },
      { column: 'a', op: 'isNotNull' },
    ];
    for (const cond of cases) {
      const built = col('t', cond);
      const dollarMax = Math.max(0, ...(built.sql.match(/\$\d+/g) ?? []).map((s) => Number(s.slice(1))));
      // params 等长于最高占位号（LIMIT 常驻 1 个）
      expect(built.params.length).toBe(dollarMax);
      if (cond.op === 'isNull' || cond.op === 'isNotNull') {
        expect(dollarMax).toBe(1); // 仅 LIMIT 占位，谓词无参数
      } else {
        expect(dollarMax).toBeGreaterThan(1);
        expect(built.sql).not.toContain("'x'");
      }
    }
    expect(col('t', cases[6]).sql).toContain('"a" LIKE $1');
    expect(col('t', cases[8]).sql).toContain('"a" IN ($1, $2)');
    expect(col('t', cases[10]).sql).toContain('"a" BETWEEN $1 AND $2');
  });

  it('like 值通配符转义（驱动规范 §4）', () => {
    const built = col('t', { column: 'a', op: 'like', value: '100%_x\\y' });
    expect(built.params[0]).toBe('%100\\%\\_x\\\\y%');
  });

  it('in 空集合 → 恒假谓词；notIn 空集合 → 无条件', () => {
    expect(col('t', { column: 'a', op: 'in', values: [] }).sql).toContain('WHERE 1 = 0');
    expect(col('t', { column: 'a', op: 'notIn', values: [] }).sql).not.toContain('WHERE');
  });

  it('search：大小写敏感 LIKE OR 组合（与内存基准一致）', () => {
    const built = buildSelect({
      db: 'public',
      obj: 't',
      search: 'a_b',
      searchColumns: ['x', 'y'],
      limit: 5,
    });
    expect(built.sql).toContain('("x" LIKE $1 OR "y" LIKE $2)');
    expect(built.params[0]).toBe('%a\\_b%');
  });

  it('whereSql 原样拼接并括号包裹（§10 例外），filters 以 AND 组合', () => {
    const built = buildSelect({
      db: 'public',
      obj: 't',
      filters: [{ column: 'a', op: 'eq', value: 1 }],
      whereSql: 'b > 10 AND c IS NOT NULL',
      searchColumns: ['name'],
      limit: 5,
    });
    expect(built.sql).toContain('WHERE "a" = $1 AND (b > 10 AND c IS NOT NULL)');
  });

  it('排序拼接顺序：sorts → orderBySql → tailSorts（主键兜底由 fetchRows 决策，P-10）', () => {
    const base = { db: 'public', obj: 't', searchColumns: ['name'], limit: 5 };
    const withSorts = buildSelect({ ...base, sorts: [{ column: 'a', dir: 'desc' }] });
    expect(withSorts.sql).toContain('ORDER BY "a" DESC');
    const withFragment = buildSelect({
      ...base,
      sorts: [{ column: 'a', dir: 'asc' }],
      orderBySql: 'amount DESC, id ASC',
      tailSorts: [{ column: 'id', dir: 'asc' }],
    });
    expect(withFragment.sql).toContain('ORDER BY "a" ASC, amount DESC, id ASC, "id" ASC');
  });

  it('未支持的 FilterOp → E_VALIDATION', () => {
    expect(() =>
      col('t', { column: 'a', op: 'regex' as never }),
    ).toThrow(DriverError);
  });
});

describe('normalizePgType（驱动规范 §5.2）', () => {
  it('常见 PG 类型归一', () => {
    expect(normalizePgType('smallint')).toBe('integer');
    expect(normalizePgType('integer')).toBe('integer');
    expect(normalizePgType('bigint')).toBe('integer');
    expect(normalizePgType('numeric(10,2)')).toBe('decimal');
    expect(normalizePgType('numeric')).toBe('decimal');
    expect(normalizePgType('double precision')).toBe('float');
    expect(normalizePgType('real')).toBe('float');
    expect(normalizePgType('boolean')).toBe('boolean');
    expect(normalizePgType('character varying(64)')).toBe('string');
    expect(normalizePgType('text')).toBe('string');
    expect(normalizePgType('date')).toBe('date');
    expect(normalizePgType('time without time zone')).toBe('time');
    expect(normalizePgType('timestamp without time zone')).toBe('datetime');
    expect(normalizePgType('timestamp with time zone')).toBe('datetime');
    expect(normalizePgType('jsonb')).toBe('json');
    expect(normalizePgType('uuid')).toBe('uuid');
    expect(normalizePgType('bytea')).toBe('binary');
    expect(normalizePgType('text[]')).toBe('json');
    expect(normalizePgType('integer[]')).toBe('json');
    expect(normalizePgType('circle')).toBe('unknown');
  });
});

describe('时间文本规范化（§5.2 解析口径）', () => {
  it('timestamp：毫秒规范化（截断微秒、补齐 .000）', () => {
    expect(normalizeTimestampText('2024-06-01 08:30:00.123456')).toBe('2024-06-01 08:30:00.123');
    expect(normalizeTimestampText('2024-06-01 08:30:00')).toBe('2024-06-01 08:30:00.000');
  });
  it('timestamptz：剥偏移保留会话时区墙上时间', () => {
    expect(normalizeTimestamptzText('2024-06-01 08:30:00.5+08')).toBe('2024-06-01 08:30:00.500');
    expect(normalizeTimestamptzText('2024-06-01 08:30:00.123456+00')).toBe('2024-06-01 08:30:00.123');
    expect(normalizeTimestamptzText('2024-06-01 08:30:00-04:30')).toBe('2024-06-01 08:30:00.000');
  });
  it('time/timetz：毫秒规范化', () => {
    expect(normalizeTimeText('08:30:00.123456')).toBe('08:30:00.123');
    expect(normalizeTimeText('08:30:00')).toBe('08:30:00.000');
    expect(normalizeTimeText('08:30:00.5+08')).toBe('08:30:00.500');
  });
});

describe('encodeCell（§5 值编码）', () => {
  it('Buffer → base64；NULL 恒 null', () => {
    expect(encodeCell(Buffer.from([0x00, 0x01, 0x02, 0xff]), 'binary')).toBe('AAEC/w==');
    expect(encodeCell(null, 'binary')).toBeNull();
    expect(encodeCell(undefined, 'string')).toBeNull();
  });
  it('int8 安全转数值：|v| ≤ 2^53 → number，超限保留字符串（decimal）', () => {
    expect(encodeCell('42', 'integer')).toBe(42);
    expect(encodeCell('9007199254740991', 'integer')).toBe(9007199254740991);
    expect(encodeCell('9007199254740993', 'integer')).toBe('9007199254740993');
    // decimal 列恒字符串（防 numeric 值被误转）
    expect(encodeCell('42', 'decimal')).toBe('42');
    expect(encodeCell('42.42', 'decimal')).toBe('42.42');
  });
});

describe('标识符与片段工具', () => {
  it('quotePgIdentifier：双引号包裹，内部引号翻倍', () => {
    expect(quotePgIdentifier('users')).toBe('"users"');
    expect(quotePgIdentifier('a"b')).toBe('"a""b"');
  });
  it('escapeLike：通配符反斜杠转义', () => {
    expect(escapeLike('a%b_c\\d')).toBe('a\\%b\\_c\\\\d');
  });
  it('fragmentHasColumn：整词匹配、字符串字面量剥除', () => {
    expect(fragmentHasColumn('amount DESC, id ASC', 'id')).toBe(true);
    expect(fragmentHasColumn("name = 'id'", 'id')).toBe(false);
    expect(fragmentHasColumn('amount DESC', 'id')).toBe(false);
  });
});
