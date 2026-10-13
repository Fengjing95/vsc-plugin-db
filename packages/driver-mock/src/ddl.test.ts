import { describe, expect, it } from 'vitest';
import { DriverError } from '@db-explorer/core';
import type { TableSpec } from '@db-explorer/core';
import {
  buildMockAlterTable,
  buildMockCreateTable,
  executeMockDdlSql,
  inferNormalizedType,
  isMockDdlStatement,
  type MockDdlRegistry,
  type MockTableShape,
} from './ddl';

function baseSpec(overrides: Partial<TableSpec> = {}): TableSpec {
  return {
    name: 'cf_t',
    comment: '测试表',
    columns: [
      { name: 'id', dataType: 'bigint', nullable: false, isPrimaryKey: true, autoIncrement: true, ordinal: 1 },
      { name: 'uname', dataType: 'varchar(64)', nullable: false, isPrimaryKey: false, defaultValue: 'anon', comment: '名称', ordinal: 2 },
      { name: 'amount', dataType: 'int', nullable: true, isPrimaryKey: false, ordinal: 3 },
    ],
    ...overrides,
  };
}

/** 可断言的内存注册表桩：记录变更调用 + 活对象 */
function fakeRegistry(): MockDdlRegistry & { created: string[]; dropped: string[]; renamed: string[] } {
  const tables = new Map<string, MockTableShape>();
  const rows = new Map<string, unknown[][]>();
  const created: string[] = [];
  const dropped: string[] = [];
  const renamed: string[] = [];
  return {
    created,
    dropped,
    renamed,
    databases: () => ['demo'],
    getTable: (db, obj) => tables.get(`${db}.${obj}`),
    createTable: (db, obj, def) => {
      tables.set(`${db}.${obj}`, def);
      rows.set(`${db}.${obj}`, []);
      created.push(`${db}.${obj}`);
    },
    dropTable: (db, obj) => {
      tables.delete(`${db}.${obj}`);
      rows.delete(`${db}.${obj}`);
      dropped.push(`${db}.${obj}`);
    },
    renameTable: (db, obj, newDb, newObj) => {
      const def = tables.get(`${db}.${obj}`);
      if (!def) {
        return;
      }
      tables.delete(`${db}.${obj}`);
      tables.set(`${newDb}.${newObj}`, def);
      renamed.push(`${db}.${obj}→${newDb}.${newObj}`);
    },
    appendColumnCells: (db, obj) => {
      for (const row of rows.get(`${db}.${obj}`) ?? []) {
        row.push(null);
      }
    },
    spliceColumnCells: (db, obj, index) => {
      for (const row of rows.get(`${db}.${obj}`) ?? []) {
        row.splice(index, 1);
      }
    },
  };
}

describe('buildMockCreateTable（M8-B2）', () => {
  it('生成与 driver-mysql 同纪律的 CREATE TABLE', () => {
    const [stmt] = buildMockCreateTable('demo', baseSpec());
    expect(stmt.sql).toContain('CREATE TABLE `demo`.`cf_t` (');
    expect(stmt.sql).toContain('`id` bigint NOT NULL AUTO_INCREMENT');
    expect(stmt.sql).toContain("`uname` varchar(64) NOT NULL DEFAULT 'anon' COMMENT '名称'");
    expect(stmt.sql).toContain('PRIMARY KEY (`id`)');
    expect(stmt.sql.endsWith(") COMMENT='测试表'")).toBe(true);
  });

  it('非法标识符 fail-closed：表名/列名引号分号拒绝', () => {
    expect(() => buildMockCreateTable('demo', baseSpec({ name: 'a;b' }))).toThrow(DriverError);
    expect(() =>
      buildMockCreateTable('demo', baseSpec({ columns: [{ name: 'x y', dataType: 'int', nullable: true, isPrimaryKey: false, ordinal: 1 }] })),
    ).toThrow(DriverError);
  });

  it('默认值控制字符拒绝（fail-closed）', () => {
    const spec = baseSpec({
      columns: [{ name: 'a', dataType: 'int', nullable: true, isPrimaryKey: false, defaultValue: '1\nDROP TABLE t', ordinal: 1 }],
    });
    expect(() => buildMockCreateTable('demo', spec)).toThrow(DriverError);
  });
});

describe('buildMockAlterTable（M8-B2）', () => {
  it('删列标 destructive；无差异返回空数组', () => {
    const current = baseSpec();
    const target: TableSpec = { ...current, columns: current.columns.slice(0, 2) };
    const stmts = buildMockAlterTable('demo', 'cf_t', target, current);
    expect(stmts).toEqual([{ sql: 'ALTER TABLE `demo`.`cf_t` DROP COLUMN `amount`', destructive: true }]);
    expect(buildMockAlterTable('demo', 'cf_t', current, current)).toEqual([]);
  });

  it('重命名：RENAME TO 首条', () => {
    const current = baseSpec();
    const stmts = buildMockAlterTable('demo', 'cf_t', { ...current, name: 'cf_t2' }, current);
    expect(stmts[0].sql).toBe('ALTER TABLE `demo`.`cf_t` RENAME TO `demo`.`cf_t2`');
  });
});

describe('executeMockDdlSql（内存执行）', () => {
  it('CREATE → 注册表新增（PK 标记/默认值/注释归位），DROP → 移除', () => {
    const reg = fakeRegistry();
    const [create] = buildMockCreateTable('demo', baseSpec());
    executeMockDdlSql(reg, create.sql);
    expect(reg.created).toEqual(['demo.cf_t']);
    const def = reg.getTable('demo', 'cf_t');
    expect(def?.primaryKey).toEqual(['id']);
    expect(def?.columns[1].defaultValue).toBe('anon');
    expect(def?.columns[1].nullable).toBe(false);
    expect(def?.comment).toBe('测试表');

    executeMockDdlSql(reg, 'DROP TABLE `demo`.`cf_t`');
    expect(reg.dropped).toEqual(['demo.cf_t']);
  });

  it('CREATE 库不存在 → E_NOT_FOUND；未识别语句 → E_VALIDATION', () => {
    const reg = fakeRegistry();
    expect(() => executeMockDdlSql(reg, 'CREATE TABLE `nodb`.`t` (`a` int NULL)')).toThrow(DriverError);
    expect(() => executeMockDdlSql(reg, 'TRUNCATE TABLE `demo`.`t`')).toThrow(DriverError);
  });

  it('ALTER 全动作往返：加列补 null、删列裁行宽、PK 变更、MODIFY、RENAME', () => {
    const reg = fakeRegistry();
    executeMockDdlSql(reg, buildMockCreateTable('demo', baseSpec())[0].sql);

    // 加列
    executeMockDdlSql(reg, 'ALTER TABLE `demo`.`cf_t` ADD COLUMN `extra` varchar(32) NULL');
    expect(reg.getTable('demo', 'cf_t')?.columns.map((c) => c.name)).toEqual(['id', 'uname', 'amount', 'extra']);
    expect(reg.getTable('demo', 'cf_t')?.columns[3].ordinal).toBe(4);

    // 删列（含行宽裁剪语义由注入侧负责——桩的 spliceColumnCells 记录即可）
    executeMockDdlSql(reg, 'ALTER TABLE `demo`.`cf_t` DROP COLUMN `amount`');
    expect(reg.getTable('demo', 'cf_t')?.columns.map((c) => c.name)).toEqual(['id', 'uname', 'extra']);

    // PK 变更：DROP → ADD
    executeMockDdlSql(reg, 'ALTER TABLE `demo`.`cf_t` DROP PRIMARY KEY');
    expect(reg.getTable('demo', 'cf_t')?.primaryKey).toEqual([]);
    executeMockDdlSql(reg, 'ALTER TABLE `demo`.`cf_t` ADD PRIMARY KEY (`id`, `uname`)');
    expect(reg.getTable('demo', 'cf_t')?.primaryKey).toEqual(['id', 'uname']);
    expect(reg.getTable('demo', 'cf_t')?.columns.find((c) => c.name === 'uname')?.isPrimaryKey).toBe(true);

    // MODIFY 改类型
    executeMockDdlSql(reg, 'ALTER TABLE `demo`.`cf_t` MODIFY COLUMN `extra` bigint NULL DEFAULT 0');
    const extra = reg.getTable('demo', 'cf_t')?.columns.find((c) => c.name === 'extra');
    expect(extra?.dataType).toBe('bigint');
    expect(extra?.normalizedType).toBe('integer');
    expect(extra?.defaultValue).toBe('0');

    // RENAME
    executeMockDdlSql(reg, 'ALTER TABLE `demo`.`cf_t` RENAME TO `demo`.`cf_t2`');
    expect(reg.renamed).toEqual(['demo.cf_t→demo.cf_t2']);
    expect(reg.getTable('demo', 'cf_t')).toBeUndefined();
    expect(reg.getTable('demo', 'cf_t2')).toBeDefined();
  });
});

describe('辅助函数', () => {
  it('isMockDdlStatement 只认 CREATE/ALTER/DROP TABLE', () => {
    expect(isMockDdlStatement('CREATE TABLE `demo`.`t` (`a` int NULL)')).toBe(true);
    expect(isMockDdlStatement('alter table `demo`.`t` drop column `a`')).toBe(true);
    expect(isMockDdlStatement('DROP TABLE IF EXISTS `demo`.`t`')).toBe(true);
    expect(isMockDdlStatement('SELECT 1')).toBe(false);
    expect(isMockDdlStatement('TRUNCATE TABLE `demo`.`t`')).toBe(false);
  });

  it('inferNormalizedType 常见类型映射', () => {
    expect(inferNormalizedType('bigint')).toBe('integer');
    expect(inferNormalizedType('decimal(10,2)')).toBe('decimal');
    expect(inferNormalizedType('varchar(64)')).toBe('string');
    expect(inferNormalizedType('datetime')).toBe('datetime');
    expect(inferNormalizedType('json')).toBe('json');
    expect(inferNormalizedType('blob')).toBe('binary');
    expect(inferNormalizedType('weird_type')).toBe('unknown');
  });
});
