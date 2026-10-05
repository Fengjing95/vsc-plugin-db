import { describe, expect, it } from 'vitest';
import { DriverError } from '@db-explorer/core';
import type { TableSpec } from '@db-explorer/core';
import { buildAlterTableStatements, buildCreateTableStatements, escapeDdlLiteral } from './ddl';

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

  it('非法标识符 fail-closed（E_VALIDATION）：表名/列名引号分号注入', () => {
    expect(() => buildCreateTableStatements('myapp', baseSpec({ name: 'x; DROP TABLE t' }))).toThrow(DriverError);
    expect(() =>
      buildCreateTableStatements('myapp', baseSpec({ columns: [{ name: 'a`b', dataType: 'int', nullable: true, isPrimaryKey: false, ordinal: 1 }] })),
    ).toThrow(DriverError);
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

  it('主键变更：先 DROP PRIMARY KEY（destructive）后 ADD PRIMARY KEY', () => {
    const current = baseSpec();
    const target: TableSpec = {
      ...current,
      columns: current.columns.map((c) => (c.name === 'uname' ? { ...c, nullable: false, isPrimaryKey: true } : c)),
    };
    const stmts = buildAlterTableStatements('myapp', 'users', target, current);
    expect(stmts.map((s) => s.sql)).toEqual([
      'ALTER TABLE `myapp`.`users` DROP PRIMARY KEY',
      'ALTER TABLE `myapp`.`users` ADD PRIMARY KEY (`id`, `uname`)',
    ]);
    expect(stmts[0].destructive).toBe(true);
    expect(stmts[1].destructive).toBeUndefined();
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

  it('删主键列：先 DROP PRIMARY KEY 再 DROP COLUMN（MySQL 顺序约束）', () => {
    const current = baseSpec();
    const target: TableSpec = { ...current, columns: current.columns.slice(1) };
    const stmts = buildAlterTableStatements('myapp', 'users', target, current);
    expect(stmts.map((s) => s.sql)).toEqual([
      'ALTER TABLE `myapp`.`users` DROP PRIMARY KEY',
      'ALTER TABLE `myapp`.`users` DROP COLUMN `id`',
    ]);
    expect(stmts.every((s) => s.destructive === true)).toBe(true);
  });
});
