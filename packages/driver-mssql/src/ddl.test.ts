import { describe, expect, it } from 'vitest';
import { DriverError } from '@db-explorer/core';
import {
  buildAlterTableStatements,
  buildCreateSchemaStatements,
  buildCreateTableStatements,
  buildDropSchemaStatements,
  escapeDdlLiteral,
} from './ddl';

const col = (name: string, overrides: Record<string, unknown> = {}) => ({
  name,
  dataType: 'nvarchar(64)',
  nullable: true,
  isPrimaryKey: false,
  ordinal: 1,
  ...overrides,
});

describe('buildCreateTableStatements（M8-MSSQL）', () => {
  it('基础：方括号标识符、IDENTITY(1,1)、NOT NULL、N 前缀字面量、PRIMARY KEY CLUSTERED', () => {
    const stmts = buildCreateTableStatements('dbo', {
      name: 'users',
      columns: [
        col('id', { dataType: 'bigint', nullable: false, isPrimaryKey: true, autoIncrement: true, ordinal: 1 }),
        col('uname', { nullable: false, defaultValue: 'anon', ordinal: 2 }),
        col('amount', { dataType: 'int', ordinal: 3 }),
      ],
    });
    expect(stmts).toHaveLength(1);
    expect(stmts[0].sql).toBe(
      [
        'CREATE TABLE [dbo].[users] (',
        '  [id] bigint IDENTITY(1,1) NOT NULL,',
        '  [uname] nvarchar(64) NOT NULL DEFAULT N\'anon\',',
        '  [amount] int NULL,',
        '  PRIMARY KEY CLUSTERED ([id] ASC)',
        ') ON [PRIMARY]',
      ].join('\n'),
    );
    expect(stmts[0].destructive).toBeUndefined();
  });

  it('自增列必须主键（SQL Server 约束前置校验）', () => {
    expect(() =>
      buildCreateTableStatements('dbo', {
        name: 't',
        columns: [col('a', { dataType: 'int', autoIncrement: true })],
      }),
    ).toThrowError(/E_VALIDATION|自增/);
  });

  it('标识符校验（危险字符黑名单，E_VALIDATION，驱动规范 §10）', () => {
    const bad = (name: string): void => {
      expect(() =>
        buildCreateTableStatements('dbo', {
          name,
          columns: [col('id', { dataType: 'bigint', nullable: false, isPrimaryKey: true })],
        }),
      ).toThrowError(DriverError);
    };
    bad('cf\nddl'); // 控制字符
    bad('cf]ddl'); // 方言引号字符（防逃逸）
    // 分号/反引号/连字符由 [ ] 双写转义安全承载；连字符回归 test-api 类真实名曾被白名单误拒
    const stmts = buildCreateTableStatements('dbo', {
      name: 'cf-ddl_t;--x',
      columns: [col('id', { dataType: 'bigint', nullable: false, isPrimaryKey: true })],
    });
    expect(stmts[0].sql).toContain('[dbo].[cf-ddl_t;--x]');
  });

  it('字面量 fail-closed：控制字符拒绝；数值/函数原样', () => {
    expect(escapeDdlLiteral('42')).toBe('42');
    expect(escapeDdlLiteral('getdate()')).toBe('getdate()');
    expect(escapeDdlLiteral('a\'b')).toBe("N'a''b'");
    expect(() => escapeDdlLiteral('a\nb')).toThrowError(DriverError);
  });
});

describe('buildAlterTableStatements（M8-MSSQL）', () => {
  const base = (): { spec: Parameters<typeof buildAlterTableStatements>[2]; current: Parameters<typeof buildAlterTableStatements>[3] } => ({
    current: {
      name: 't',
      columns: [
        col('id', { dataType: 'bigint', nullable: false, isPrimaryKey: true, autoIncrement: true, ordinal: 1 }),
        col('uname', { nullable: false, defaultValue: 'anon', ordinal: 2 }),
      ],
    },
    spec: {
      name: 't',
      columns: [
        col('id', { dataType: 'bigint', nullable: false, isPrimaryKey: true, autoIncrement: true, ordinal: 1 }),
        col('uname', { nullable: false, defaultValue: 'anon', ordinal: 2 }),
      ],
    },
  });

  it('加列：ALTER TABLE ADD（非 destructive）', () => {
    const { spec, current } = base();
    spec.columns.push(col('extra', { dataType: 'varchar(32)', nullable: true, ordinal: 3 }));
    const stmts = buildAlterTableStatements('dbo', 't', spec, current);
    expect(stmts).toHaveLength(1);
    expect(stmts[0].sql).toBe('ALTER TABLE [dbo].[t] ADD [extra] varchar(32) NULL');
    expect(stmts[0].destructive).toBeUndefined();
  });

  it('删列：DROP COLUMN 标 destructive；自增主键列被删时先删主键约束', () => {
    const { spec, current } = base();
    spec.columns = current.columns.filter((c) => c.name !== 'uname');
    const stmts = buildAlterTableStatements('dbo', 't', spec, current, {
      pkConstraintName: 'PK__t__ABC',
      defaultConstraints: new Map([['uname', 'DF__t__uname']]),
    });
    expect(stmts.map((s) => s.sql)).toEqual([
      'ALTER TABLE [dbo].[t] DROP CONSTRAINT [DF__t__uname]',
      'ALTER TABLE [dbo].[t] DROP COLUMN [uname]',
    ]);
    expect(stmts[1].destructive).toBe(true);
  });

  it('改类型：先删默认值约束再 ALTER COLUMN 再加回，标 destructive', () => {
    const { spec, current } = base();
    spec.columns[1] = { ...spec.columns[1], dataType: 'nvarchar(128)' };
    const stmts = buildAlterTableStatements('dbo', 't', spec, current, {
      pkConstraintName: 'PK__t__ABC',
      defaultConstraints: new Map([['uname', 'DF__t__uname']]),
    });
    expect(stmts.map((s) => s.sql)).toEqual([
      'ALTER TABLE [dbo].[t] DROP CONSTRAINT [DF__t__uname]',
      'ALTER TABLE [dbo].[t] ALTER COLUMN [uname] nvarchar(128) NOT NULL',
      "ALTER TABLE [dbo].[t] ADD CONSTRAINT [DF__t__uname] DEFAULT N'anon' FOR [uname]",
    ]);
    expect(stmts[1].destructive).toBe(true);
  });

  it('改 nullable：ALTER COLUMN 携带全量类型与 NOT NULL/NULL', () => {
    const { spec, current } = base();
    spec.columns[1] = { ...spec.columns[1], nullable: true };
    const stmts = buildAlterTableStatements('dbo', 't', spec, current, {
      pkConstraintName: 'PK__t__ABC',
      defaultConstraints: new Map(),
    });
    expect(stmts.map((s) => s.sql)).toEqual(['ALTER TABLE [dbo].[t] ALTER COLUMN [uname] nvarchar(64) NULL']);
  });

  it('主键变更：DROP CONSTRAINT（按查询到的约束名，destructive）→ ADD PRIMARY KEY', () => {
    const { spec, current } = base();
    spec.columns = current.columns.map((c) => (c.name === 'uname' ? { ...c, nullable: false, isPrimaryKey: true } : c));
    const stmts = buildAlterTableStatements('dbo', 't', spec, current, {
      pkConstraintName: 'PK__t__ABC',
      defaultConstraints: new Map([['uname', 'DF__t__uname']]),
    });
    expect(stmts.map((s) => s.sql)).toEqual([
      'ALTER TABLE [dbo].[t] DROP CONSTRAINT [PK__t__ABC]',
      'ALTER TABLE [dbo].[t] ADD PRIMARY KEY CLUSTERED ([id] ASC, [uname] ASC)',
    ]);
    expect(stmts[0].destructive).toBe(true);
  });

  it('默认值变更：DROP CONSTRAINT + ADD CONSTRAINT（destructive 仅限删约束语义时）', () => {
    const { spec, current } = base();
    spec.columns[1] = { ...spec.columns[1], defaultValue: 'x' };
    const stmts = buildAlterTableStatements('dbo', 't', spec, current, {
      pkConstraintName: 'PK__t__ABC',
      defaultConstraints: new Map([['uname', 'DF__t__uname']]),
    });
    expect(stmts.map((s) => s.sql)).toEqual([
      'ALTER TABLE [dbo].[t] DROP CONSTRAINT [DF__t__uname]',
      "ALTER TABLE [dbo].[t] ADD CONSTRAINT [DF__t__uname] DEFAULT N'x' FOR [uname]",
    ]);
  });

  it('identity 差异不支持原地变更（E_UNSUPPORTED，README 声明）', () => {
    const { spec, current } = base();
    spec.columns[1] = { ...spec.columns[1], autoIncrement: true };
    expect(() => buildAlterTableStatements('dbo', 't', spec, current, { defaultConstraints: new Map() })).toThrowError(
      DriverError,
    );
  });

  it('表重命名：sp_rename（SQL Server 无 RENAME TO；obj = 旧名口径）', () => {
    const { spec, current } = base();
    spec.name = 't2';
    const stmts = buildAlterTableStatements('dbo', 't', spec, current, { defaultConstraints: new Map() });
    expect(stmts[0].sql).toBe("EXEC sp_rename N'dbo.t', N't2'");
  });

  it('无结构差异返回空数组', () => {
    const { spec, current } = base();
    expect(buildAlterTableStatements('dbo', 't', spec, current, { defaultConstraints: new Map() })).toEqual([]);
  });
});

describe('库级 DDL（M8-DBDDL / D-19：schema 建删，ADR D-21）', () => {
  it('CREATE SCHEMA；DROP SCHEMA 标 destructive（非空 schema 由服务端拒绝）', () => {
    expect(buildCreateSchemaStatements({ name: 'appdata' })).toEqual([{ sql: 'CREATE SCHEMA [appdata]' }]);
    expect(buildDropSchemaStatements('appdata')).toEqual([{ sql: 'DROP SCHEMA [appdata]', destructive: true }]);
    // 黑名单口径：控制字符/右方括号拒绝；连字符等由 [ ] 引用承载（回归 test-api 类真实名）
    expect(() => buildCreateSchemaStatements({ name: 'a\nb' })).toThrowError(DriverError);
    expect(() => buildDropSchemaStatements('a]b')).toThrowError(DriverError);
    expect(buildCreateSchemaStatements({ name: 'app-data' })[0].sql).toBe('CREATE SCHEMA [app-data]');
  });
});
