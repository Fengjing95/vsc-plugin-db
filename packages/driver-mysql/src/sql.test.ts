import { describe, expect, it } from 'vitest';
import type { FilterCondition } from '@db-explorer/core';
import {
  buildSelect,
  fragmentHasColumn,
  encodeValue,
  escapeLike,
  normalizeMysqlType,
  quoteMysqlIdentifier,
  toDriverError,
  filterMysqlDatabases,
} from './sql';

describe('quoteMysqlIdentifier', () => {
  it('反引号包裹并转义内嵌反引号', () => {
    expect(quoteMysqlIdentifier('users')).toBe('`users`');
    expect(quoteMysqlIdentifier('we`ird')).toBe('`we``ird`');
  });
});

describe('escapeLike', () => {
  it('转义 \\ % _', () => {
    expect(escapeLike('100%')).toBe('100\\%');
    expect(escapeLike('a_b')).toBe('a\\_b');
    expect(escapeLike('a\\b')).toBe('a\\\\b');
  });
});

describe('fragmentHasColumn（判断用户片段是否引用某列）', () => {
  it('整词匹配、剥除字符串字面量、识别反引号引用', () => {
    expect(fragmentHasColumn('amount DESC', 'amount')).toBe(true);
    expect(fragmentHasColumn('`id` DESC', 'id')).toBe(true);
    expect(fragmentHasColumn("'id' DESC", 'id')).toBe(false); // 字符串字面量剥除
    expect(fragmentHasColumn('paid DESC', 'id')).toBe(false); // 整词边界
    expect(fragmentHasColumn('ID DESC', 'id')).toBe(true); // 忽略大小写
  });
});

describe('buildSelect', () => {
  it('基础 SELECT + LIMIT 参数化', () => {
    const built = buildSelect({
      db: 'demo',
      obj: 'users',
      searchColumns: [],
      limit: 10,
    });
    expect(built.sql).toBe('SELECT * FROM `demo`.`users` LIMIT ?');
    expect(built.params).toEqual([10]);
  });

  it('offset 追加 OFFSET', () => {
    const built = buildSelect({
      db: 'demo',
      obj: 'users',
      searchColumns: [],
      limit: 10,
      offset: 20,
    });
    expect(built.sql).toContain('LIMIT ? OFFSET ?');
    expect(built.params).toEqual([10, 20]);
  });

  it('whereSql 原样拼接且括号包裹（用户自撰片段不转义）', () => {
    const built = buildSelect({
      db: 'demo',
      obj: 'users',
      searchColumns: [],
      limit: 10,
      whereSql: "status = 'active' AND age > 18",
    });
    expect(built.sql).toContain("WHERE (status = 'active' AND age > 18) LIMIT ?");
    expect(built.params).toEqual([10]);
  });

  it('whereSql 与结构化筛选/search 同为 AND 语义', () => {
    const built = buildSelect({
      db: 'demo',
      obj: 'users',
      filters: [{ column: 'id', op: 'gt', value: 5 }],
      search: 'kw',
      searchColumns: ['name'],
      limit: 10,
      whereSql: '1 = 1',
    });
    expect(built.sql).toContain('WHERE `id` > ? AND (`name` LIKE ?) AND (1 = 1)');
    expect(built.params).toEqual([5, '%kw%', 10]);
  });

  it('tailSorts 追加在 orderBySql 之后（主键兜底）', () => {
    const built = buildSelect({
      db: 'demo',
      obj: 'users',
      searchColumns: [],
      limit: 10,
      orderBySql: 'amount DESC',
      tailSorts: [{ column: 'id', dir: 'asc' }],
    });
    expect(built.sql).toContain('ORDER BY amount DESC, `id` ASC');
  });

  it('orderBySql 追加在列头排序之后', () => {
    const withSorts = buildSelect({
      db: 'demo',
      obj: 'users',
      searchColumns: [],
      limit: 10,
      sorts: [{ column: 'id', dir: 'desc' }],
      orderBySql: 'created_at ASC, amount DESC',
    });
    expect(withSorts.sql).toContain('ORDER BY `id` DESC, created_at ASC, amount DESC');
    const noSorts = buildSelect({
      db: 'demo',
      obj: 'users',
      searchColumns: [],
      limit: 10,
      orderBySql: 'created_at ASC',
    });
    expect(noSorts.sql).toContain('ORDER BY created_at ASC');
  });

  it('列投影', () => {
    const built = buildSelect({
      db: 'demo',
      obj: 'users',
      columns: ['id', 'name'],
      searchColumns: [],
      limit: 5,
    });
    expect(built.sql).toBe('SELECT `id`, `name` FROM `demo`.`users` LIMIT ?');
  });

  it('筛选下推为参数化 WHERE（无值拼接）', () => {
    const built = buildSelect({
      db: 'demo',
      obj: 'users',
      filters: [
        { column: 'status', op: 'eq', value: 'active' },
        { column: 'email', op: 'like', value: '100%' },
        { column: 'age', op: 'between', values: [18, 30] },
        { column: 'tag', op: 'in', values: ['a', 'b'] },
        { column: 'deleted_at', op: 'isNull' },
      ],
      searchColumns: [],
      limit: 50,
    });
    expect(built.sql).toContain(
      '`status` = ? AND `email` LIKE ? AND `age` BETWEEN ? AND ? AND `tag` IN (?, ?) AND `deleted_at` IS NULL',
    );
    // like 值已含通配符与转义；末位是 LIMIT 参数
    expect(built.params).toEqual(['active', '%100\\%%', 18, 30, 'a', 'b', 50]);
  });

  it('全局搜索生成 OR 组', () => {
    const built = buildSelect({
      db: 'demo',
      obj: 'users',
      search: '张',
      searchColumns: ['name', 'email'],
      limit: 10,
    });
    expect(built.sql).toContain('WHERE (`name` LIKE ? OR `email` LIKE ?)');
    expect(built.params[0]).toBe('%张%');
  });

  it('排序下推', () => {
    const built = buildSelect({
      db: 'demo',
      obj: 'users',
      sorts: [
        { column: 'id', dir: 'desc' },
        { column: 'name', dir: 'asc' },
      ],
      searchColumns: [],
      limit: 10,
    });
    expect(built.sql).toContain('ORDER BY `id` DESC, `name` ASC');
  });

  it('契约 §12.2-4：每个 FilterOp 生成占位符，值不拼接进 SQL', () => {
    const literals = ['v"lue', '100%', "o'x", '18'];
    const filters: FilterCondition[] = [
      { column: 'c', op: 'eq', value: literals[0] },
      { column: 'c', op: 'ne', value: literals[0] },
      { column: 'c', op: 'gt', value: 18 },
      { column: 'c', op: 'ge', value: 18 },
      { column: 'c', op: 'lt', value: 18 },
      { column: 'c', op: 'le', value: 18 },
      { column: 'c', op: 'like', value: literals[1] },
      { column: 'c', op: 'notLike', value: literals[1] },
      { column: 'c', op: 'in', values: ['a', literals[2]] },
      { column: 'c', op: 'notIn', values: ['a', 'b'] },
      { column: 'c', op: 'between', values: [1, literals[3]] },
    ];
    for (const f of filters) {
      const built = buildSelect({ db: 'd', obj: 't', filters: [f], searchColumns: [], limit: 10 });
      const valuesInSql = [literals[0], literals[1], literals[2], literals[3], 'a']
        .filter((v) => v !== '18')
        .filter((v) => built.sql.includes(v));
      expect(valuesInSql, `op=${f.op} 的值被拼接进 SQL: ${built.sql}`).toEqual([]);
      expect(built.sql).toContain('?');
    }
    // isNull / isNotNull 无值参数
    for (const op of ['isNull', 'isNotNull'] as const) {
      const built = buildSelect({ db: 'd', obj: 't', filters: [{ column: 'c', op }], searchColumns: [], limit: 10 });
      expect(built.sql).toContain(`\`c\` IS ${op === 'isNull' ? 'NULL' : 'NOT NULL'}`);
    }
  });

  it('契约 §12.2-3：未指定排序时由调用方补主键排序（fetchRows 默认 ORDER BY）', () => {
    const built = buildSelect({
      db: 'demo',
      obj: 'users',
      sorts: [{ column: 'id', dir: 'asc' }],
      searchColumns: [],
      limit: 10,
    });
    expect(built.sql).toContain('ORDER BY `id` ASC');
  });
});

describe('normalizeMysqlType', () => {
  it('覆盖驱动规范 §5.1 的主要分组', () => {
    expect(normalizeMysqlType('bigint')).toBe('integer');
    expect(normalizeMysqlType('INT UNSIGNED')).toBe('integer');
    expect(normalizeMysqlType('decimal(10,2)')).toBe('decimal');
    expect(normalizeMysqlType('double')).toBe('float');
    expect(normalizeMysqlType('boolean')).toBe('boolean');
    expect(normalizeMysqlType('date')).toBe('date');
    expect(normalizeMysqlType('time')).toBe('time');
    expect(normalizeMysqlType('datetime')).toBe('datetime');
    expect(normalizeMysqlType('timestamp')).toBe('datetime');
    expect(normalizeMysqlType('json')).toBe('json');
    expect(normalizeMysqlType('longblob')).toBe('binary');
    expect(normalizeMysqlType('varbinary(16)')).toBe('binary');
    expect(normalizeMysqlType('varchar(64)')).toBe('string');
    expect(normalizeMysqlType('text')).toBe('string');
    expect(normalizeMysqlType('point')).toBe('binary'); // geometry 类
    expect(normalizeMysqlType('something_new')).toBe('unknown');
  });
});

describe('encodeValue', () => {
  it('Buffer → base64，其他值原样', () => {
    expect(encodeValue(Buffer.from('abc'))).toBe(Buffer.from('abc').toString('base64'));
    expect(encodeValue('plain')).toBe('plain');
    expect(encodeValue(42)).toBe(42);
    expect(encodeValue(null)).toBeNull();
  });
});

describe('toDriverError 映射（驱动规范 §6）', () => {
  it('ER_ACCESS_DENIED_ERROR → E_AUTH', () => {
    const err = toDriverError({ code: 'ER_ACCESS_DENIED_ERROR', sqlMessage: 'Access denied' });
    expect(err.code).toBe('E_AUTH');
    expect(err.retryable).toBe(false);
  });

  it('ER_NO_SUCH_TABLE → E_NOT_FOUND', () => {
    expect(toDriverError({ code: 'ER_NO_SUCH_TABLE' }).code).toBe('E_NOT_FOUND');
  });

  it('ER_DUP_ENTRY → E_CONSTRAINT', () => {
    expect(toDriverError({ code: 'ER_DUP_ENTRY', sqlMessage: 'Duplicate entry' }).code).toBe(
      'E_CONSTRAINT',
    );
  });

  it('连接层错误码 → E_CONN 且可重试', () => {
    const err = toDriverError({ code: 'ECONNREFUSED', message: 'connect ECONNREFUSED' });
    expect(err.code).toBe('E_CONN');
    expect(err.retryable).toBe(true);
  });

  it('未知错误 → E_INTERNAL，detail 保留原始信息', () => {
    const err = toDriverError({ code: 'ER_SOMETHING', sqlMessage: 'boom' });
    expect(err.code).toBe('E_INTERNAL');
    expect(err.detail).toContain('ER_SOMETHING');
    expect(err.detail).toContain('boom');
  });
});

describe('filterMysqlDatabases（表单列库建议，§3 @since v0.1.4）', () => {
  it('过滤系统库（大小写不敏感），业务库保留', () => {
    expect(
      filterMysqlDatabases(['information_schema', 'mysql', 'performance_schema', 'sys', 'myapp', 'MyApp_Prod']),
    ).toEqual(['myapp', 'MyApp_Prod']);
  });
});
