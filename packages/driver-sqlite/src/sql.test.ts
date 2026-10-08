import { describe, expect, it } from 'vitest';
import { buildSelect, encodeCell, escapeLike, fragmentHasColumn, isMutatingSql, normalizeSqliteType, quoteIdentifier, quoteStringLiteral, toNativeParam, unquoteDdlDefault, valueToNormalizedType } from './sql';

/**
 * SQL 构建层单测（P-9 口径）：逐 FilterOp 断言参数化占位符与无值拼接——
 * 「语句必须参数化」无法经 IConnection 接口观测，由本文件承载契约。
 */

describe('quoteIdentifier / quoteStringLiteral', () => {
  it('双引号引用与内部引号翻倍', () => {
    expect(quoteIdentifier('users')).toBe('"users"');
    expect(quoteIdentifier('we"ird')).toBe('"we""ird"');
  });

  it('字符串字面量单引号翻倍', () => {
    expect(quoteStringLiteral("it's")).toBe("'it''s'");
  });
});

describe('escapeLike', () => {
  it('转义 \\ % _ 三类通配符', () => {
    expect(escapeLike('100%_\\x')).toBe('100\\%\\_\\\\x');
  });
});

describe('isMutatingSql', () => {
  it('SELECT/PRAGMA/EXPLAIN/VALUES 视为只读，其余（含 WITH/DDL/写语句）视为可能写库', () => {
    expect(isMutatingSql('SELECT 1')).toBe(false);
    expect(isMutatingSql('  pragma table_info("t")')).toBe(false);
    expect(isMutatingSql('EXPLAIN QUERY PLAN SELECT 1')).toBe(false);
    expect(isMutatingSql('VALUES (1)')).toBe(false);
    expect(isMutatingSql('WITH x AS (SELECT 1) INSERT INTO t SELECT * FROM x')).toBe(true);
    expect(isMutatingSql('INSERT INTO t VALUES (1)')).toBe(true);
    expect(isMutatingSql('CREATE TABLE t (id INTEGER)')).toBe(true);
    expect(isMutatingSql('VACUUM')).toBe(true);
  });
});

describe('buildSelect：逐 FilterOp 参数化（P-9）', () => {
  const base = { db: 'main', obj: 't', searchColumns: [] as string[], limit: 10 };

  const q = (n: number): string => Array.from({ length: n }, () => '?').join(', ');

  it('eq/ne/gt/ge/lt/le：单占位符，值只进 params 不入语句（尾参为 LIMIT ?）', () => {
    for (const op of ['eq', 'ne', 'gt', 'ge', 'lt', 'le'] as const) {
      const built = buildSelect({ ...base, filters: [{ column: 'c', op, value: 'RAW_VALUE' }] });
      expect(built.sql).toContain('"c"');
      expect(built.sql).not.toContain('RAW_VALUE');
      expect(built.sql.match(/\?/g)).toHaveLength(2); // 筛选 1 + LIMIT 1
      expect(built.params).toEqual(['RAW_VALUE', 10]);
    }
  });

  it('like/notLike：通配符转义 + ESCAPE 子句，值参数化', () => {
    const built = buildSelect({ ...base, filters: [{ column: 'c', op: 'like', value: 'a%b_c\\d' }] });
    expect(built.sql).toMatch(/"c" LIKE \? ESCAPE '\\'/);
    expect(built.sql).not.toContain('a%b');
    expect(built.params).toEqual(['%a\\%b\\_c\\\\d%', 10]);
    const notLike = buildSelect({ ...base, filters: [{ column: 'c', op: 'notLike', value: 'x' }] });
    expect(notLike.sql).toContain('NOT LIKE');
  });

  it('in/notIn：逐值占位符；空值列表 in → 1 = 0（notIn 恒真不产生条件）', () => {
    const inQ = buildSelect({ ...base, filters: [{ column: 'c', op: 'in', values: [1, 2] }] });
    expect(inQ.sql).toContain(`"c" IN (${q(2)})`);
    expect(inQ.sql).not.toContain('IN (1');
    expect(inQ.params).toEqual([1, 2, 10]);
    const emptyIn = buildSelect({ ...base, filters: [{ column: 'c', op: 'in', values: [] }] });
    expect(emptyIn.sql).toContain('1 = 0');
    const emptyNotIn = buildSelect({ ...base, filters: [{ column: 'c', op: 'notIn', values: [] }] });
    expect(emptyNotIn.sql).not.toContain('WHERE');
  });

  it('isNull/isNotNull：筛选条件无占位符（仅 LIMIT ?）', () => {
    const built = buildSelect({ ...base, filters: [{ column: 'c', op: 'isNull' }] });
    expect(built.sql).toContain('"c" IS NULL');
    expect(built.params).toEqual([10]);
  });

  it('between：两占位符', () => {
    const built = buildSelect({ ...base, filters: [{ column: 'c', op: 'between', values: [1, 9] }] });
    expect(built.sql).toContain('"c" BETWEEN ? AND ?');
    expect(built.params).toEqual([1, 9, 10]);
  });

  it('多条件 AND 连接', () => {
    const built = buildSelect({
      ...base,
      filters: [
        { column: 'a', op: 'eq', value: 1 },
        { column: 'b', op: 'eq', value: 2 },
      ],
    });
    expect(built.sql).toContain('WHERE "a" = ? AND "b" = ?');
    expect(built.params).toEqual([1, 2, 10]);
  });

  it('search：instr 子串形式，关键字参数化（含特殊字符不入语句）', () => {
    const built = buildSelect({ ...base, search: "100%_\\'", searchColumns: ['a', 'b'] });
    expect(built.sql).toContain('(instr("a", ?) > 0 OR instr("b", ?) > 0)');
    expect(built.sql).not.toContain('100%');
    expect(built.params).toEqual(["100%_\\'", "100%_\\'", 10]);
  });

  it('whereSql 原样拼接（用户自撰片段，括号包裹）', () => {
    const built = buildSelect({ ...base, whereSql: '1 = 1' });
    expect(built.sql).toContain('WHERE (1 = 1)');
  });

  it('排序：sorts → orderBySql → tailSorts 顺序；LIMIT/OFFSET 参数化', () => {
    const built = buildSelect({
      ...base,
      sorts: [{ column: 'a', dir: 'desc' }],
      orderBySql: 'a + b DESC',
      tailSorts: [{ column: 'id', dir: 'asc' }],
      offset: 4,
    });
    expect(built.sql).toContain('ORDER BY "a" DESC, a + b DESC, "id" ASC LIMIT ? OFFSET ?');
    expect(built.params).toEqual([10, 4]);
  });

  it('列投影：双引号引用', () => {
    const built = buildSelect({ ...base, columns: ['a', 'b"q'] });
    expect(built.sql).toContain('SELECT "a", "b""q" FROM "t"');
  });

  it('encodeParam 钩子只作用于列定位值（limit/offset/search 不经钩子）', () => {
    const built = buildSelect({
      ...base,
      filters: [{ column: 'bin', op: 'eq', value: 'QQ==' }],
      search: 'kw',
      searchColumns: ['s'],
      offset: 2,
      encodeParam: (col, v) => (col === 'bin' ? Buffer.from(String(v), 'base64') : v),
    });
    expect(built.params[0]).toBeInstanceOf(Buffer);
    expect(built.params).toContain('kw');
    expect(built.params).toContain(2);
  });
});

describe('normalizeSqliteType（§5.4 类型映射）', () => {
  it('按声明类型归一', () => {
    expect(normalizeSqliteType('INTEGER')).toBe('integer');
    expect(normalizeSqliteType('bigint')).toBe('integer');
    expect(normalizeSqliteType('REAL')).toBe('float');
    expect(normalizeSqliteType('DOUBLE PRECISION')).toBe('float');
    expect(normalizeSqliteType('NUMERIC(12,2)')).toBe('decimal');
    expect(normalizeSqliteType('varchar(64)')).toBe('string');
    expect(normalizeSqliteType('TEXT')).toBe('string');
    expect(normalizeSqliteType('BLOB')).toBe('binary');
    expect(normalizeSqliteType('BOOLEAN')).toBe('boolean');
    expect(normalizeSqliteType('json')).toBe('json');
    expect(normalizeSqliteType('DATETIME')).toBe('datetime');
    expect(normalizeSqliteType('TIMESTAMP')).toBe('datetime');
    expect(normalizeSqliteType('DATE')).toBe('date');
    expect(normalizeSqliteType('TIME')).toBe('time');
    expect(normalizeSqliteType('')).toBe('unknown');
  });

  it('DATETIME/TIMESTAMP 先于 TIME 判定（含 TIME 字样不误归 time）', () => {
    expect(normalizeSqliteType('DATETIME')).not.toBe('time');
  });
});

describe('encodeCell（§5.4 值编码）', () => {
  it('null 与 Uint8Array → base64', () => {
    expect(encodeCell(null, 'unknown')).toBeNull();
    expect(encodeCell(new Uint8Array([0, 1, 255]), 'binary')).toBe('AAH/');
  });

  it('BigInt 通道：安全转数值、超限保字符串（C-7）', () => {
    expect(encodeCell(42n, 'integer')).toBe(42);
    expect(encodeCell(9007199254740993n, 'integer')).toBe('9007199254740993');
  });

  it('boolean：0/1（含 BigInt 形态）→ false/true，其余透传', () => {
    expect(encodeCell(1n, 'boolean')).toBe(true);
    expect(encodeCell(0n, 'boolean')).toBe(false);
    expect(encodeCell(1, 'boolean')).toBe(true);
    expect(encodeCell(2, 'boolean')).toBe(2);
  });

  it('decimal：数值 → 字符串（C-7）；json：文本 → 解析对象，失败回落原文', () => {
    expect(encodeCell(42.42, 'decimal')).toBe('42.42');
    expect(encodeCell('{"k":1}', 'json')).toEqual({ k: 1 });
    expect(encodeCell('not json', 'json')).toBe('not json');
  });
});

describe('toNativeParam（§5 编辑回传 → 原生参数）', () => {
  const types = new Map<string, 'binary' | 'json'>([
    ['bin', 'binary'],
    ['js', 'json'],
  ]);

  it('null/undefined → null；boolean → 1/0', () => {
    expect(toNativeParam('x', null, types)).toBeNull();
    expect(toNativeParam('x', undefined, types)).toBeNull();
    expect(toNativeParam('x', true, types)).toBe(1);
    expect(toNativeParam('x', false, types)).toBe(0);
  });

  it('binary 列 base64 → Buffer；json 列对象 → 字符串；其余透传', () => {
    expect(toNativeParam('bin', 'AAEC/w==', types)).toEqual(Buffer.from([0, 1, 2, 255]));
    expect(toNativeParam('js', { k: 1 }, types)).toBe('{"k":1}');
    expect(toNativeParam('other', 'text', types)).toBe('text');
  });
});

describe('unquoteDdlDefault / valueToNormalizedType / fragmentHasColumn', () => {
  it('dflt_value 去引号与翻倍还原', () => {
    expect(unquoteDdlDefault("'anon'")).toBe('anon');
    expect(unquoteDdlDefault("'it''s'")).toBe("it's");
    expect(unquoteDdlDefault('"q"')).toBe('q');
    expect(unquoteDdlDefault('0')).toBe('0');
    expect(unquoteDdlDefault('CURRENT_TIMESTAMP')).toBe('CURRENT_TIMESTAMP');
    expect(unquoteDdlDefault(null)).toBeUndefined();
  });

  it('结果列类型按样本值判定', () => {
    expect(valueToNormalizedType(1n)).toBe('integer');
    expect(valueToNormalizedType(1.5)).toBe('float');
    expect(valueToNormalizedType('s')).toBe('string');
    expect(valueToNormalizedType(new Uint8Array(1))).toBe('binary');
    expect(valueToNormalizedType(null)).toBe('unknown');
  });

  it('片段整词匹配列名（字符串字面量剥除）', () => {
    expect(fragmentHasColumn('ORDER BY id DESC', 'id')).toBe(true);
    expect(fragmentHasColumn("ORDER BY 'id' DESC", 'id')).toBe(false);
    expect(fragmentHasColumn('ORDER BY idx DESC', 'id')).toBe(false);
  });
});
