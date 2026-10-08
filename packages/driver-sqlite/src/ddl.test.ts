import { describe, expect, it } from 'vitest';
import { DriverError, type TableSpec } from '@db-explorer/core';
import { buildAlterTableStatements, buildCreateTableStatements, escapeDdlLiteral } from './ddl';

/** DDL 生成单测（§5.4：AUTOINCREMENT 归一 INTEGER、fail-closed、表重建序列）。 */

function col(name: string, overrides: Partial<TableSpec['columns'][number]> = {}): TableSpec['columns'][number] {
  return { name, dataType: 'TEXT', nullable: true, isPrimaryKey: false, ordinal: 1, ...overrides };
}

describe('buildCreateTableStatements', () => {
  it('单列自增主键：声明类型归一 INTEGER + AUTOINCREMENT（SQLite 硬约束）', () => {
    const statements = buildCreateTableStatements('main', {
      name: 't',
      columns: [
        col('id', { dataType: 'bigint', nullable: false, isPrimaryKey: true, autoIncrement: true, ordinal: 1 }),
        col('uname', { dataType: 'varchar(64)', nullable: false, defaultValue: 'anon', ordinal: 2 }),
      ],
    });
    expect(statements).toHaveLength(1);
    expect(statements[0].sql).toBe(
      'CREATE TABLE "t" (\n  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,\n  "uname" varchar(64) NOT NULL DEFAULT \'anon\'\n)',
    );
  });

  it('复合主键：表级约束（AUTOINCREMENT 不可用于复合主键）', () => {
    const statements = buildCreateTableStatements('main', {
      name: 't',
      columns: [
        col('a', { dataType: 'INTEGER', nullable: false, isPrimaryKey: true, ordinal: 1 }),
        col('b', { dataType: 'TEXT', nullable: false, isPrimaryKey: true, ordinal: 2 }),
      ],
    });
    expect(statements[0].sql).toContain('PRIMARY KEY ("a", "b")');
    expect(statements[0].sql).not.toContain('AUTOINCREMENT');
  });

  it('非法标识符 fail-closed（E_VALIDATION）：分号注入与反引号', () => {
    for (const bad of ['cf_ddl_x; DROP TABLE t', 'cf`_ddl', 'a b', '名']) {
      expect(() =>
        buildCreateTableStatements('main', { name: bad, columns: [col('id')] }),
      ).toThrowError(expect.objectContaining({ code: 'E_VALIDATION' }));
    }
  });

  it('字面量转义：数值原样、引号翻倍、控制字符拒绝', () => {
    expect(escapeDdlLiteral('42')).toBe('42');
    expect(escapeDdlLiteral("it's")).toBe("'it''s'");
    expect(() => escapeDdlLiteral('a\nb')).toThrowError(DriverError);
  });
});

describe('buildAlterTableStatements', () => {
  const baseline: TableSpec = {
    name: 't',
    columns: [
      col('id', { dataType: 'INTEGER', nullable: false, isPrimaryKey: true, autoIncrement: true, ordinal: 1 }),
      col('uname', { dataType: 'varchar(64)', nullable: false, defaultValue: 'anon', ordinal: 2 }),
    ],
  };

  it('无结构差异 → 空数组', () => {
    expect(buildAlterTableStatements('main', 't', baseline, baseline)).toEqual([]);
  });

  it('仅加列 → 原地 ADD COLUMN（非 destructive）', () => {
    const target: TableSpec = { ...baseline, columns: [...baseline.columns, col('extra', { dataType: 'varchar(32)', ordinal: 3 })] };
    const statements = buildAlterTableStatements('main', 't', target, baseline);
    expect(statements).toHaveLength(1);
    expect(statements[0].sql).toBe('ALTER TABLE "t" ADD COLUMN "extra" varchar(32) NULL');
    expect(statements[0].destructive).toBeUndefined();
  });

  it('删列 → 表重建序列（§5.4：删列统一重建；序列含 DROP TABLE destructive）', () => {
    const target: TableSpec = { ...baseline, columns: baseline.columns.filter((c) => c.name !== 'uname') };
    const statements = buildAlterTableStatements('main', 't', target, baseline);
    expect(statements.map((s) => s.sql)).toEqual([
      'PRAGMA foreign_keys = OFF',
      'CREATE TABLE "t__dbx_rebuild" (\n  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT\n)',
      'INSERT INTO "t__dbx_rebuild" ("id") SELECT "id" FROM "t"',
      'DROP TABLE "t"',
      'ALTER TABLE "t__dbx_rebuild" RENAME TO "t"',
      'PRAGMA foreign_keys = ON',
    ]);
    expect(statements.some((s) => s.destructive === true)).toBe(true);
  });

  it('主键变更 → 表重建序列（PRAGMA OFF/ON + 回拷 + DROP destructive + RENAME）', () => {
    const target: TableSpec = {
      ...baseline,
      columns: baseline.columns.map((c) => (c.name === 'uname' ? { ...c, nullable: false, isPrimaryKey: true } : c)),
    };
    const statements = buildAlterTableStatements('main', 't', target, baseline);
    expect(statements.map((s) => s.sql)).toEqual([
      'PRAGMA foreign_keys = OFF',
      'CREATE TABLE "t__dbx_rebuild" (\n  "id" INTEGER NOT NULL,\n  "uname" varchar(64) NOT NULL DEFAULT \'anon\',\n  PRIMARY KEY ("id", "uname")\n)',
      'INSERT INTO "t__dbx_rebuild" ("id", "uname") SELECT "id", "uname" FROM "t"',
      'DROP TABLE "t"',
      'ALTER TABLE "t__dbx_rebuild" RENAME TO "t"',
      'PRAGMA foreign_keys = ON',
    ]);
    expect(statements.some((s) => s.destructive === true)).toBe(true);
  });

  it('改类型 → 表重建（SQLite 无 ALTER COLUMN）', () => {
    const target: TableSpec = {
      ...baseline,
      columns: baseline.columns.map((c) => (c.name === 'uname' ? { ...c, dataType: 'TEXT' } : c)),
    };
    const statements = buildAlterTableStatements('main', 't', target, baseline);
    expect(statements.some((s) => s.sql.includes('CREATE TABLE "t__dbx_rebuild"'))).toBe(true);
  });

  it('加非空列且无默认值 → 表重建（ADD COLUMN NOT NULL 需非空常量默认值）', () => {
    const target: TableSpec = { ...baseline, columns: [...baseline.columns, col('req', { nullable: false, ordinal: 3 })] };
    const statements = buildAlterTableStatements('main', 't', target, baseline);
    expect(statements.some((s) => s.sql.includes('CREATE TABLE "t__dbx_rebuild"'))).toBe(true);
  });

  it('仅重命名 → 单条 RENAME（非 destructive）', () => {
    const target: TableSpec = { ...baseline, name: 't2' };
    const statements = buildAlterTableStatements('main', 't', target, baseline);
    expect(statements).toHaveLength(1);
    expect(statements[0].sql).toBe('ALTER TABLE "t" RENAME TO "t2"');
  });

  it('重建 + 重命名：DROP 旧名、RENAME 到新名', () => {
    const target: TableSpec = {
      name: 't2',
      columns: baseline.columns.map((c) => (c.name === 'uname' ? { ...c, dataType: 'TEXT' } : c)),
    };
    const statements = buildAlterTableStatements('main', 't', target, baseline);
    expect(statements.some((s) => s.sql === 'DROP TABLE "t"')).toBe(true);
    expect(statements.some((s) => s.sql === 'ALTER TABLE "t__dbx_rebuild" RENAME TO "t2"')).toBe(true);
  });
});
