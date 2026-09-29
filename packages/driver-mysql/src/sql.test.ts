import { describe, expect, it } from 'vitest';
import {
  buildSelect,
  encodeValue,
  escapeLike,
  normalizeMysqlType,
  quoteMysqlIdentifier,
  toDriverError,
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
