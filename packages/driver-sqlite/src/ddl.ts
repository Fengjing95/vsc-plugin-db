import { DriverError, type DdlStatement, type TableSpec } from '@db-explorer/core';
import { quoteIdentifier } from './sql';

/**
 * SQLite 表结构编辑语句生成（M8-B2/M8-SQLite，概要 §5.9 / 驱动规范 §3 @since v0.1.2）：
 * - DDL 不可参数化（驱动规范 §10）：标识符 fail-closed 校验（非法字符直接 E_VALIDATION，不靠转义兜底）
 *   + 双引号引用；字面量转义，控制字符拒绝
 * - SQLite ALTER 能力受限（驱动规范 §5.4）：仅加列（ADD COLUMN，且要求可空或带非空常量默认值）
 *   与删列（DROP COLUMN ≥ 3.35）可原地执行；**改类型/改默认值/改主键必须表重建**——
 *   PRAGMA foreign_keys=OFF → CREATE 新表 → INSERT…SELECT 回拷公共列 → DROP 旧表 → RENAME →
 *   PRAGMA foreign_keys=ON，整序列含 DROP TABLE（destructive）
 * - 自增主键 = INTEGER PRIMARY KEY（rowid 别名，单列）：AUTOINCREMENT 仅允许 INTEGER 类型
 *   （SQLite 硬约束，其余声明类型归一为 INTEGER）；复合主键不可 AUTOINCREMENT
 * - SQLite 无列/表注释语法：comment 差异不生成语句（结构编辑器中注释项对 SQLite 无效）
 * - 已知限制：表重建不迁移索引/触发器（纯函数层无索引自省输入，README 声明）
 * 纯函数，有单测。
 */

const IDENT_RE = /^[A-Za-z0-9_$]+$/;

const REBUILD_SUFFIX = '__dbx_rebuild';

function assertIdentifier(kind: string, name: string): string {
  if (!IDENT_RE.test(name) || name.length > 128) {
    throw new DriverError('E_VALIDATION', `${kind} "${name}" 含非法字符（字母/数字/_/$ 之外不允许）`);
  }
  return name;
}

/** 字面量转义：数值原样；字符串字面量单引号包裹（'' 翻倍）；控制字符拒绝（fail-closed） */
export function escapeDdlLiteral(value: string): string {
  if (/^-?\d+(\.\d+)?$/.test(value)) {
    return value.trim();
  }
  // eslint-disable-next-line no-control-regex -- 刻意拒绝控制字符（驱动规范 §10 fail-closed）
  if (/[\r\n\x00]/.test(value)) {
    throw new DriverError('E_VALIDATION', '默认值不允许包含换行或控制字符');
  }
  return `'${value.replace(/'/g, "''")}'`;
}

/** 单列自增主键（rowid 别名）：AUTOINCREMENT 仅允许 INTEGER，声明类型归一 */
function singleAutoIncrementPk(spec: TableSpec): string | undefined {
  const pks = spec.columns.filter((c) => c.isPrimaryKey);
  if (pks.length !== 1) {
    return undefined;
  }
  const col = spec.columns.find((c) => c.autoIncrement && c.name === pks[0].name);
  return col?.name;
}

function defaultSql(col: TableSpec['columns'][number]): string | undefined {
  return col.defaultValue !== undefined && col.defaultValue !== ''
    ? `DEFAULT ${escapeDdlLiteral(col.defaultValue)}`
    : undefined;
}

function columnDefSql(col: TableSpec['columns'][number], autoIncPk: string | undefined): string {
  assertIdentifier('列名', col.name);
  if (col.name === autoIncPk) {
    const def = defaultSql(col);
    return [`"${col.name}"`, 'INTEGER', 'NOT NULL', 'PRIMARY KEY AUTOINCREMENT', def].filter(Boolean).join(' ');
  }
  const parts = [`"${col.name}"`, col.dataType.trim(), col.nullable ? 'NULL' : 'NOT NULL', defaultSql(col)];
  return parts.filter(Boolean).join(' ');
}

function createTableSql(spec: TableSpec, tableName: string): string {
  const autoIncPk = singleAutoIncrementPk(spec);
  const cols = spec.columns.map((c) => columnDefSql(c, autoIncPk));
  const pks = spec.columns.filter((c) => c.isPrimaryKey).map((c) => `"${c.name}"`);
  // 复合主键（或非自增单列主键）走表级约束；单列自增主键已内联（AUTOINCREMENT 要求内联）
  if (pks.length > 0 && !(pks.length === 1 && autoIncPk !== undefined)) {
    cols.push(`PRIMARY KEY (${pks.join(', ')})`);
  }
  return `CREATE TABLE ${quoteIdentifier(tableName)} (\n  ${cols.join(',\n  ')}\n)`;
}

export function buildCreateTableStatements(db: string, spec: TableSpec): DdlStatement[] {
  void db; // 单文件单库（D-16）：db 恒 'main'，SQL 内为裸名
  assertIdentifier('表名', spec.name);
  if (spec.columns.length === 0) {
    throw new DriverError('E_VALIDATION', '表至少需要一列');
  }
  return [{ sql: createTableSql(spec, spec.name) }];
}

export function buildAlterTableStatements(
  db: string,
  obj: string,
  spec: TableSpec,
  current: TableSpec,
): DdlStatement[] {
  void db;
  assertIdentifier('表名', spec.name);
  assertIdentifier('表名', obj);
  for (const c of spec.columns) {
    assertIdentifier('列名', c.name);
  }

  const curByName = new Map(current.columns.map((c) => [c.name, c]));
  const tgtByName = new Map(spec.columns.map((c) => [c.name, c]));

  const curPk = current.columns.filter((c) => c.isPrimaryKey).map((c) => c.name).join(',');
  const tgtPk = spec.columns.filter((c) => c.isPrimaryKey).map((c) => c.name).join(',');
  const pkChanged = curPk !== tgtPk;

  const added = spec.columns.filter((c) => !curByName.has(c.name));
  const dropped = current.columns.filter((c) => !tgtByName.has(c.name));
  // 逐属性不可原地 ALTER 的差异：类型 / 可空性 / 默认值 / 自增（SQLite 无 ALTER COLUMN）
  const changed = spec.columns.filter((c) => {
    const cur = curByName.get(c.name);
    if (!cur) return false;
    return (
      cur.dataType.trim() !== c.dataType.trim() ||
      cur.nullable !== c.nullable ||
      (cur.defaultValue ?? '') !== (c.defaultValue ?? '') ||
      Boolean(cur.autoIncrement) !== Boolean(c.autoIncrement)
    );
  });
  // 加列但 SQLite ADD COLUMN 约束不满足（非空列需非空常量默认值；自增列不可 ADD）→ 表重建
  const addedNeedRebuild = added.filter(
    (c) =>
      Boolean(c.autoIncrement) ||
      (!c.nullable && (!c.defaultValue || c.defaultValue === '' || /^current_/i.test(c.defaultValue.trim()))),
  );

  const renamed = spec.name !== obj;
  const needsRebuild = pkChanged || changed.length > 0 || dropped.length + addedNeedRebuild.length > 0;

  // 无需重建：加列（原地 ADD COLUMN）+ 重命名（最后执行，后续语句引用旧名）
  if (!needsRebuild) {
    const statements: DdlStatement[] = added.map((c) => ({
      sql: `ALTER TABLE ${quoteIdentifier(obj)} ADD COLUMN ${columnDefSql(c, undefined)}`,
    }));
    if (renamed) {
      statements.push({
        sql: `ALTER TABLE ${quoteIdentifier(obj)} RENAME TO ${quoteIdentifier(spec.name)}`,
      });
    }
    return statements;
  }

  // 表重建序列（驱动规范 §5.4；整序列含 DROP TABLE → destructive 确认分级）
  const statements: DdlStatement[] = [];
  const tmpName = `${obj}${REBUILD_SUFFIX}`;
  statements.push({ sql: 'PRAGMA foreign_keys = OFF' });
  statements.push({ sql: createTableSql(spec, tmpName) });
  const common = current.columns.filter((c) => tgtByName.has(c.name)).map((c) => `"${c.name}"`);
  if (common.length > 0) {
    statements.push({
      sql: `INSERT INTO ${quoteIdentifier(tmpName)} (${common.join(', ')}) SELECT ${common.join(', ')} FROM ${quoteIdentifier(obj)}`,
    });
  }
  statements.push({ sql: `DROP TABLE ${quoteIdentifier(obj)}`, destructive: true });
  statements.push({ sql: `ALTER TABLE ${quoteIdentifier(tmpName)} RENAME TO ${quoteIdentifier(spec.name)}` });
  statements.push({ sql: 'PRAGMA foreign_keys = ON' });
  return statements;
}
