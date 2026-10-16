import { describe, expect, it } from 'vitest';
import { DriverError } from '@db-explorer/core';
import type { TableSpec } from '@db-explorer/core';
import {
  buildAlterDatabaseStatements,
  buildAlterTableStatements,
  buildCreateDatabaseStatements,
  buildCreateTableStatements,
  buildDropDatabaseStatements,
  escapeDdlLiteral,
} from './ddl';

function baseSpec(overrides: Partial<TableSpec> = {}): TableSpec {
  return {
    name: 'users',
    comment: '用户表',
    columns: [
      { name: 'id', dataType: 'bigint', nullable: false, isPrimaryKey: true, autoIncrement: true, ordinal: 1 },
      { name: 'uname', dataType: 'varchar(64)', nullable: false, isPrimaryKey: false, defaultValue: 'anon', comment: '名称', ordinal: 2 },
      { name: 'amount', dataType: 'int', nullable: true, isPrimaryKey: false, ordinal: 3 },
    ],
    ...overrides,
  };
}

describe('buildCreateTableStatements（M8-B2）', () => {
  it('生成 CREATE TABLE：反引号标识符、NOT NULL/DEFAULT/COMMENT/AUTO_INCREMENT、主键、表注释', () => {
    const [stmt] = buildCreateTableStatements('myapp', baseSpec());
    expect(stmt.destructive).toBeUndefined();
    expect(stmt.sql).toBe(
      [
        'CREATE TABLE `myapp`.`users` (',
        '  `id` bigint NOT NULL AUTO_INCREMENT,',
        "  `uname` varchar(64) NOT NULL DEFAULT 'anon' COMMENT '名称',",
        '  `amount` int NULL,',
        '  PRIMARY KEY (`id`)',
        ") COMMENT='用户表'",
      ].join('\n'),
    );
  });

  it('字面量转义：数值与 CURRENT_TIMESTAMP 原样，字符串引号翻倍', () => {
    expect(escapeDdlLiteral('0')).toBe('0');
    expect(escapeDdlLiteral('current_timestamp')).toBe('current_timestamp');
    expect(escapeDdlLiteral("it's")).toBe("'it''s'");
    expect(() => escapeDdlLiteral('a\nb')).toThrow(DriverError);
  });

  it('标识符校验（危险字符黑名单）：反引号/控制字符拒绝；连字符等真实合法名放行', () => {
    expect(() => buildCreateTableStatements('myapp', baseSpec({ name: 'x`y' }))).toThrow(DriverError);
    expect(() => buildCreateTableStatements('myapp', baseSpec({ name: 'x\ny' }))).toThrow(DriverError);
    // 分号/连字符由反引号双写转义安全承载（回归：test-api 类真实库名曾被白名单误拒）
    const stmts = buildCreateTableStatements('test-api', baseSpec({ name: 'cf-ddl_t;--x' }));
    expect(stmts[0].sql).toContain('`test-api`.`cf-ddl_t;--x`');
  });

  it('自增列必须为主键（MySQL 约束）', () => {
    const spec = baseSpec({
      columns: [{ name: 'id', dataType: 'bigint', nullable: false, isPrimaryKey: false, autoIncrement: true, ordinal: 1 }],
    });
    expect(() => buildCreateTableStatements('myapp', spec)).toThrow(DriverError);
  });
});

describe('buildAlterTableStatements（M8-B2）', () => {
  it('加列 / 改注释：非 destructive', () => {
    const current = baseSpec();
    const target: TableSpec = {
      ...current,
      columns: [...current.columns, { name: 'extra', dataType: 'varchar(32)', nullable: true, isPrimaryKey: false, ordinal: 4 }],
    };
    const stmts = buildAlterTableStatements('myapp', 'users', target, current);
    expect(stmts.map((s) => s.sql)).toEqual(['ALTER TABLE `myapp`.`users` ADD COLUMN `extra` varchar(32) NULL']);
    expect(stmts.every((s) => !s.destructive)).toBe(true);
  });

  it('删列：destructive', () => {
    const current = baseSpec();
    const target: TableSpec = { ...current, columns: current.columns.slice(0, 2) };
    const stmts = buildAlterTableStatements('myapp', 'users', target, current);
    expect(stmts).toEqual([
      { sql: 'ALTER TABLE `myapp`.`users` DROP COLUMN `amount`', destructive: true },
    ]);
  });

  it('改类型：MODIFY + destructive；仅改默认值：MODIFY 非 destructive', () => {
    const current = baseSpec();
    const typeChange: TableSpec = {
      ...current,
      columns: current.columns.map((c) => (c.name === 'amount' ? { ...c, dataType: 'bigint' } : c)),
    };
    expect(buildAlterTableStatements('myapp', 'users', typeChange, current)).toEqual([
      { sql: 'ALTER TABLE `myapp`.`users` MODIFY COLUMN `amount` bigint NULL', destructive: true },
    ]);
    const defaultValueChange: TableSpec = {
      ...current,
      columns: current.columns.map((c) => (c.name === 'amount' ? { ...c, defaultValue: '0' } : c)),
    };
    expect(buildAlterTableStatements('myapp', 'users', defaultValueChange, current)).toEqual([
      { sql: 'ALTER TABLE `myapp`.`users` MODIFY COLUMN `amount` int NULL DEFAULT 0' },
    ]);
  });

  it('主键变更：DROP PRIMARY KEY 与 ADD PRIMARY KEY 合并单句（表含自增列时单句 DROP 会被 MySQL 拒）', () => {
    const current = baseSpec();
    const target: TableSpec = {
      ...current,
      columns: current.columns.map((c) => (c.name === 'uname' ? { ...c, nullable: false, isPrimaryKey: true } : c)),
    };
    const stmts = buildAlterTableStatements('myapp', 'users', target, current);
    expect(stmts.map((s) => s.sql)).toEqual([
      'ALTER TABLE `myapp`.`users` DROP PRIMARY KEY, ADD PRIMARY KEY (`id`, `uname`)',
    ]);
    expect(stmts[0].destructive).toBe(true);
  });

  it('表重命名：RENAME TO 首条语句，后续变更用新名', () => {
    const current = baseSpec();
    const target: TableSpec = { ...current, name: 'users_new', columns: current.columns.slice(0, 2) };
    const stmts = buildAlterTableStatements('myapp', 'users', target, current);
    expect(stmts[0].sql).toBe('ALTER TABLE `myapp`.`users` RENAME TO `myapp`.`users_new`');
    expect(stmts[1].sql).toContain('`myapp`.`users_new` DROP COLUMN');
  });

  it('无结构差异返回空数组', () => {
    const current = baseSpec();
    expect(buildAlterTableStatements('myapp', 'users', current, current)).toEqual([]);
  });

  it('删自增主键列：DROP PRIMARY KEY 与 DROP COLUMN 合并单句（自增列瞬时无键会被 MySQL 拒）', () => {
    const current = baseSpec();
    const target: TableSpec = { ...current, columns: current.columns.slice(1) };
    const stmts = buildAlterTableStatements('myapp', 'users', target, current);
    expect(stmts.map((s) => s.sql)).toEqual([
      'ALTER TABLE `myapp`.`users` DROP PRIMARY KEY, DROP COLUMN `id`',
    ]);
    expect(stmts.every((s) => s.destructive === true)).toBe(true);
  });
});

describe('库级 DDL（M8-DBDDL / D-19）', () => {
  it('CREATE DATABASE：charset/collation 子句按需拼接', () => {
    expect(buildCreateDatabaseStatements({ name: 'mydb' })).toEqual([
      { sql: 'CREATE DATABASE `mydb`' },
    ]);
    expect(buildCreateDatabaseStatements({ name: 'mydb', charset: 'utf8mb4', collation: 'utf8mb4_general_ci' })).toEqual([
      { sql: 'CREATE DATABASE `mydb` CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci' },
    ]);
  });

  it('ALTER DATABASE：无差异空数组；差异仅含变化维度；重命名拒绝', () => {
    const current = { name: 'mydb', charset: 'utf8mb4', collation: 'utf8mb4_general_ci' };
    expect(buildAlterDatabaseStatements('mydb', { name: 'mydb', charset: 'utf8mb4', collation: 'utf8mb4_general_ci' }, current)).toEqual([]);
    expect(buildAlterDatabaseStatements('mydb', { name: 'mydb', charset: 'utf8', collation: 'utf8mb4_general_ci' }, current)).toEqual([
      { sql: 'ALTER DATABASE `mydb` CHARACTER SET utf8' },
    ]);
    expect(() =>
      buildAlterDatabaseStatements('mydb', { name: 'other' }, current),
    ).toThrowError(DriverError);
  });

  it('DROP DATABASE：destructive 标记', () => {
    expect(buildDropDatabaseStatements('mydb')).toEqual([
      { sql: 'DROP DATABASE `mydb`', destructive: true },
    ]);
  });

  it('库名/字符集校验（标识符黑名单 + 关键字白名单，E_VALIDATION）', () => {
    expect(() => buildCreateDatabaseStatements({ name: 'a\nb' })).toThrowError(DriverError);
    // 字符集是原样拼接的关键字（不可引用）——保持严格白名单
    expect(() => buildCreateDatabaseStatements({ name: 'mydb', charset: 'utf8; DROP DATABASE x' })).toThrowError(DriverError);
    expect(() => buildDropDatabaseStatements('cf`_db')).toThrowError(DriverError);
    // 连字符库名合法（回归：test-api 类真实库名曾被白名单误拒）
    expect(buildCreateDatabaseStatements({ name: 'test-api' })[0].sql).toBe('CREATE DATABASE `test-api`');
  });
});
