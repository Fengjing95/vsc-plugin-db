import { describe, expect, it } from 'vitest';
import { DriverError, type FilterCondition } from '@db-explorer/core';
import {
  buildSelect,
  encodeCell,
  escapeLike,
  filterMssqlSchemas,
  formatMssqlDataType,
  formatUtcDate,
  formatUtcDateTime,
  formatUtcTime,
  fragmentHasColumn,
  normalizeMssqlType,
  quoteMssqlIdentifier,
  stripMssqlColumnDefault,
  toNativeParam,
  TypedNullParam,
} from './sql';

/** 语句形状契约（P-9 同族）：筛选下推的参数化无法经 IConnection 观测，由构建层单测覆盖 */
describe('buildSelect（M8-MSSQL）', () => {
  it('基础：方括号 schema.obj 限定、@pN 占位符、OFFSET/FETCH 参数化（T-SQL 无 LIMIT）', () => {
    const built = buildSelect({
      db: 'dbo',
      obj: 'users',
      searchColumns: ['name'],
      limit: 50,
      offset: 100,
    });
    expect(built.sql).toBe(
      'SELECT * FROM [dbo].[users] ORDER BY (SELECT NULL) OFFSET @p1 ROWS FETCH NEXT @p2 ROWS ONLY',
    );
    expect(built.params).toEqual([100, 50]);
    // 无值拼接：OFFSET/FETCH 数值不出现在语句文本
    expect(/OFFSET \d+ ROWS/.test(built.sql)).toBe(false);
  });

  it('columns 指定：列名方括号引用；无 offset 时 OFFSET 0 兜底（T-SQL FETCH 必须带 OFFSET）', () => {
    const built = buildSelect({
      db: 'app',
      obj: 't',
      columns: ['id', 'name'],
      searchColumns: ['name'],
      limit: 10,
    });
    expect(built.sql).toBe(
      'SELECT [id], [name] FROM [app].[t] ORDER BY (SELECT NULL) OFFSET 0 ROWS FETCH NEXT @p1 ROWS ONLY',
    );
    expect(built.params).toEqual([10]);
  });

  const col = (name: string, cond: FilterCondition, extra: Partial<Parameters<typeof buildSelect>[0]> = {}) =>
    buildSelect({ db: 'dbo', obj: 't', filters: [cond], searchColumns: ['name'], limit: 10, ...extra });

  it('每个 FilterOp 生成 @pN 占位符且无值拼接（概要 §8）', () => {
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
      const atMax = Math.max(0, ...(built.sql.match(/@p(\d+)/g) ?? []).map((s) => Number(s.slice(2))));
      // params 等长于最高占位号（FETCH 常驻 1 个）
      expect(built.params.length).toBe(atMax);
      if (cond.op === 'isNull' || cond.op === 'isNotNull') {
        expect(atMax).toBe(1); // 仅 FETCH 占位，谓词无参数
      } else {
        expect(atMax).toBeGreaterThan(1);
        expect(built.sql).not.toContain("'x'");
      }
    }
    // LIKE 带 ESCAPE '\' 子句（T-SQL LIKE 默认无转义符）
    expect(col('t', cases[6]).sql).toContain('[a] LIKE @p1 ESCAPE \'\\\'');
    expect(col('t', cases[8]).sql).toContain('[a] IN (@p1, @p2)');
    expect(col('t', cases[10]).sql).toContain('[a] BETWEEN @p1 AND @p2');
    // in 空数组 → 恒假谓词（无占位符）
    expect(col('t', { column: 'a', op: 'in', values: [] }).sql).toContain('1 = 0');
  });

  it('like 值通配符转义（驱动规范 §4）', () => {
    const built = col('t', { column: 'a', op: 'like', value: '100%_x\\y' });
    expect(built.params[0]).toBe('%100\\%\\_x\\\\y%');
  });

  it('search 多列 OR + 转义后参数化', () => {
    const built = buildSelect({
      db: 'dbo',
      obj: 't',
      search: 'ab%c',
      searchColumns: ['n1', 'n2'],
      limit: 10,
    });
    expect(built.sql).toContain('([n1] LIKE @p1 ESCAPE \'\\\' OR [n2] LIKE @p2 ESCAPE \'\\\')');
    expect(built.params[0]).toBe('%ab\\%c%');
    expect(built.params[1]).toBe('%ab\\%c%');
  });

  it('whereSql 原样拼接且括号包裹（用户自撰 SQL，不做转义/参数化）', () => {
    const built = buildSelect({
      db: 'dbo',
      obj: 't',
      whereSql: 'age > 18',
      searchColumns: ['name'],
      limit: 10,
    });
    expect(built.sql).toContain('WHERE (age > 18)');
  });

  it('sorts/orderBySql/tailSorts 拼接顺序：列头排序 → 用户片段 → 兜底主键（P-10）', () => {
    const built = buildSelect({
      db: 'dbo',
      obj: 't',
      sorts: [{ column: 'b', dir: 'desc' }],
      orderBySql: 'a COLLATE Chinese_PRC_CI_AS',
      tailSorts: [{ column: 'id', dir: 'asc' }],
      searchColumns: ['name'],
      limit: 10,
    });
    expect(built.sql).toContain('ORDER BY [b] DESC, a COLLATE Chinese_PRC_CI_AS, [id] ASC');
    // 有 ORDER BY 后不得再追加 (SELECT NULL) 兜底
    expect(built.sql).not.toContain('(SELECT NULL)');
  });

  it('标识符含 ] 转义为 ]]', () => {
    expect(quoteMssqlIdentifier('a]b')).toBe('[a]]b]');
    const built = col('t', { column: 'a]b', op: 'isNull' });
    expect(built.sql).toContain('[a]]b] IS NULL');
  });

  it('未知 FilterOp 抛 E_VALIDATION', () => {
    expect(() => col('t', { column: 'a', op: 'regex' as never })).toThrowError(DriverError);
  });
});

describe('类型归一与值编码（驱动规范 §5.6）', () => {
  it('normalizeMssqlType：SQL Server 类型 → NormalizedType', () => {
    expect(normalizeMssqlType('int')).toBe('integer');
    expect(normalizeMssqlType('bigint')).toBe('integer');
    expect(normalizeMssqlType('smallint')).toBe('integer');
    expect(normalizeMssqlType('tinyint')).toBe('integer');
    expect(normalizeMssqlType('decimal(12, 2)')).toBe('decimal');
    expect(normalizeMssqlType('numeric')).toBe('decimal');
    expect(normalizeMssqlType('money')).toBe('decimal');
    expect(normalizeMssqlType('float')).toBe('float');
    expect(normalizeMssqlType('real')).toBe('float');
    expect(normalizeMssqlType('bit')).toBe('boolean');
    expect(normalizeMssqlType('nvarchar(64)')).toBe('string');
    expect(normalizeMssqlType('varchar(max)')).toBe('string');
    expect(normalizeMssqlType('nchar')).toBe('string');
    expect(normalizeMssqlType('text')).toBe('string');
    expect(normalizeMssqlType('xml')).toBe('string');
    expect(normalizeMssqlType('date')).toBe('date');
    expect(normalizeMssqlType('time(3)')).toBe('time');
    expect(normalizeMssqlType('datetime')).toBe('datetime');
    expect(normalizeMssqlType('datetime2(3)')).toBe('datetime');
    expect(normalizeMssqlType('smalldatetime')).toBe('datetime');
    expect(normalizeMssqlType('datetimeoffset')).toBe('datetime');
    expect(normalizeMssqlType('uniqueidentifier')).toBe('uuid');
    expect(normalizeMssqlType('varbinary(max)')).toBe('binary');
    expect(normalizeMssqlType('rowversion')).toBe('binary');
    expect(normalizeMssqlType('geography')).toBe('unknown');
    expect(normalizeMssqlType('sql_variant')).toBe('unknown');
  });

  it('formatMssqlDataType：sys.columns 元数据 → 方言类型原文', () => {
    const f = (typeName: string, maxLength: number, precision = 0, scale = 0) =>
      formatMssqlDataType({ typeName, maxLength, precision, scale });
    expect(f('int', 4, 10, 0)).toBe('int');
    expect(f('nvarchar', 128)).toBe('nvarchar(64)'); // 半宽 = max_length/2
    expect(f('nvarchar', -1)).toBe('nvarchar(max)');
    expect(f('varchar', 64)).toBe('varchar(64)');
    expect(f('varchar', -1)).toBe('varchar(max)');
    expect(f('decimal', 17, 12, 2)).toBe('decimal(12, 2)');
    expect(f('numeric', 17, 10, 4)).toBe('numeric(10, 4)');
    expect(f('datetime2', 8, 27, 3)).toBe('datetime2(3)');
    expect(f('time', 5, 16, 7)).toBe('time(7)');
    expect(f('varbinary', -1)).toBe('varbinary(max)');
    expect(f('bit', 1, 1, 0)).toBe('bit');
  });

  it('stripMssqlColumnDefault：约束定义去括号/去引号 roundtrip', () => {
    expect(stripMssqlColumnDefault('((0))')).toBe('0');
    expect(stripMssqlColumnDefault("(N'anon')")).toBe('anon');
    expect(stripMssqlColumnDefault("('anon')")).toBe('anon');
    expect(stripMssqlColumnDefault('(getdate())')).toBe('getdate()');
    expect(stripMssqlColumnDefault(null)).toBeUndefined();
    expect(stripMssqlColumnDefault(undefined)).toBeUndefined();
  });

  it('encodeCell：Buffer → base64；Date 按 UTC 组件格式化（C-7）；bigint 字符串安全转数值', () => {
    expect(encodeCell(Buffer.from([0x00, 0x01, 0xff]), 'binary')).toBe('AAH/');
    expect(encodeCell(Buffer.from([0x00, 0x01, 0x02, 0xff]), 'binary')).toBe('AAEC/w==');
    expect(encodeCell(new Date(Date.UTC(2024, 5, 1, 8, 30, 0, 0)), 'datetime')).toBe('2024-06-01 08:30:00.000');
    expect(encodeCell(new Date(Date.UTC(2024, 5, 1)), 'date')).toBe('2024-06-01');
    expect(encodeCell(new Date(Date.UTC(1970, 0, 1, 8, 30, 0, 500)), 'time')).toBe('08:30:00.500');
    expect(encodeCell('9007199254740993', 'integer')).toBe('9007199254740993'); // 超限保留字符串
    expect(encodeCell('42', 'integer')).toBe(42); // 安全范围转 number
    expect(encodeCell('9007199254740993', 'decimal')).toBe('9007199254740993'); // decimal 恒字符串
    expect(encodeCell(null, 'string')).toBeNull();
    expect(encodeCell('x', 'string')).toBe('x');
    expect(formatUtcDate(new Date(Date.UTC(2024, 0, 2)))).toBe('2024-01-02');
    expect(formatUtcTime(new Date(Date.UTC(1970, 0, 1, 23, 59, 59, 123)))).toBe('23:59:59.123');
    expect(formatUtcDateTime(new Date(Date.UTC(2024, 11, 31, 23, 0, 0, 0)))).toBe('2024-12-31 23:00:00.000');
  });

  it('toNativeParam：日期文本 → TypedDate（UTC 组件解析）、binary base64 → Buffer、对象 → JSON 文本', () => {
    const types = new Map([
      ['d', 'date' as const],
      ['t', 'time' as const],
      ['ts', 'datetime' as const],
      ['b', 'binary' as const],
      ['j', 'json' as const],
    ]);
    const d = toNativeParam('d', '2024-06-01', types);
    expect(d).toMatchObject({ kind: 'date' });
    expect((d as { value: Date }).value.getUTCFullYear()).toBe(2024);
    const t = toNativeParam('t', '08:30:00.000', types);
    expect(t).toMatchObject({ kind: 'time' });
    expect((t as { value: Date }).value.getUTCHours()).toBe(8);
    const ts = toNativeParam('ts', '2024-06-01 08:30:00.000', types);
    expect(ts).toMatchObject({ kind: 'datetime' });
    expect((ts as { value: Date }).value.getUTCMonth()).toBe(5);
    expect(toNativeParam('b', 'AAEC/w==', types)).toEqual(Buffer.from([0x00, 0x01, 0x02, 0xff]));
    // binary 列的 null → TypedNullParam（显式 VarBinary 绑定）——mssql 对 null 自动推断
    // NVarChar，nvarchar→varbinary 无隐式转换（CI mssql 契约首跑抓到）
    expect(toNativeParam('b', null, types)).toBeInstanceOf(TypedNullParam);
    expect(toNativeParam('plain', null, new Map())).toBeNull();
    expect(toNativeParam('ts', null, types)).toBeNull(); // 非二进制列 null 不包装
    expect(toNativeParam('j', { k: 1 }, types)).toBe('{"k":1}');
    expect(toNativeParam('plain', 'x', new Map())).toBe('x');
    expect(toNativeParam('n', 42, new Map())).toBe(42);
  });
});

describe('元数据辅助', () => {
  it('filterMssqlSchemas：系统固定架构硬过滤（dbo 保留）', () => {
    expect(
      filterMssqlSchemas(['dbo', 'appdata', 'sys', 'information_schema', 'guest', 'db_owner', 'db_datareader']),
    ).toEqual(['dbo', 'appdata']);
  });

  it('escapeLike / fragmentHasColumn', () => {
    expect(escapeLike('a%b_c\\d')).toBe('a\\%b\\_c\\\\d');
    expect(fragmentHasColumn('ORDER BY name', 'name')).toBe(true);
    expect(fragmentHasColumn("ORDER BY 'name'", 'name')).toBe(false);
  });
});
