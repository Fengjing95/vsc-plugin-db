import {
  DriverError,
  diffKeyEntries,
  foreignKeyActionSuffix,
  generateKeyName,
  type DdlStatement,
  type ForeignKeySpec,
  type TableSpec,
} from '@db-explorer/core';
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

/** 列名清单字面量（键/外键/索引共用，表设计器批次 B） */
function columnListLit(columns: readonly string[]): string {
  if (columns.length === 0) {
    throw new DriverError('E_VALIDATION', '键/索引至少需要一列');
  }
  return columns.map((c) => quoteIdentifier(assertIdentifier('列名', c))).join(', ');
}

/** 唯一键/外键的 CREATE TABLE 内联 CONSTRAINT 子句（表设计器批次 B，交互稿 §12.4/§12.5）：
 *  SQLite 无 ALTER ADD/DROP CONSTRAINT——约束变更随表重建序列承载（§12.2 能力矩阵）；
 *  外键 alter 由 buildAlterTableStatements fail-closed（E_UNSUPPORTED） */
function appendInlineConstraintClauses(cols: string[], spec: TableSpec): void {
  const taken = new Set<string>();
  for (const k of [...(spec.uniqueKeys ?? []), ...(spec.foreignKeys ?? [])]) {
    if (k.name) {
      taken.add(k.name);
    }
  }
  for (const uk of spec.uniqueKeys ?? []) {
    const name = assertIdentifier('唯一键名', uk.name ?? generateKeyName('uk', spec.name, taken));
    taken.add(name);
    cols.push(`CONSTRAINT ${quoteIdentifier(name)} UNIQUE (${columnListLit(uk.columns)})`);
  }
  for (const fk of spec.foreignKeys ?? []) {
    if (fk.refColumns.length !== fk.columns.length) {
      throw new DriverError('E_VALIDATION', `外键 "${fk.name ?? '(未命名)'}" 引用列数须与本地列数一致`);
    }
    const name = assertIdentifier('外键名', fk.name ?? generateKeyName('fk', spec.name, taken));
    taken.add(name);
    cols.push(
      `CONSTRAINT ${quoteIdentifier(name)} FOREIGN KEY (${columnListLit(fk.columns)}) REFERENCES ${quoteIdentifier(assertIdentifier('引用表名', fk.refTable))} (${columnListLit(fk.refColumns)})${foreignKeyActionSuffix(fk)}`,
    );
  }
}

/** 二级索引独立语句（CREATE [UNIQUE] INDEX；SQLite 索引无类型选项——显式传入 fail-closed） */
function createIndexStatement(tableName: string, name: string, columns: readonly string[], unique?: boolean, type?: string): DdlStatement {
  if (type) {
    throw new DriverError('E_UNSUPPORTED', 'SQLite 索引无类型选项');
  }
  return {
    sql: `CREATE ${unique ? 'UNIQUE ' : ''}INDEX ${quoteIdentifier(assertIdentifier('索引名', name))} ON ${quoteIdentifier(tableName)} (${columnListLit(columns)})`,
  };
}

function createTableSql(spec: TableSpec, tableName: string): string {
  const autoIncPk = singleAutoIncrementPk(spec);
  const cols = spec.columns.map((c) => columnDefSql(c, autoIncPk));
  const pks = spec.columns.filter((c) => c.isPrimaryKey).map((c) => `"${c.name}"`);
  // 复合主键（或非自增单列主键）走表级约束；单列自增主键已内联（AUTOINCREMENT 要求内联）
  if (pks.length > 0 && !(pks.length === 1 && autoIncPk !== undefined)) {
    cols.push(`PRIMARY KEY (${pks.join(', ')})`);
  }
  appendInlineConstraintClauses(cols, spec);
  return `CREATE TABLE ${quoteIdentifier(tableName)} (\n  ${cols.join(',\n  ')}\n)`;
}

export function buildCreateTableStatements(db: string, spec: TableSpec): DdlStatement[] {
  void db; // 单文件单库（D-16）：db 恒 'main'，SQL 内为裸名
  assertIdentifier('表名', spec.name);
  if (spec.columns.length === 0) {
    throw new DriverError('E_VALIDATION', '表至少需要一列');
  }
  const statements: DdlStatement[] = [{ sql: createTableSql(spec, spec.name) }];
  // 索引不内联（SQLite CREATE TABLE 无 INDEX 子句）——独立语句随后执行
  const taken = new Set([...(spec.uniqueKeys ?? []).map((k) => k.name).filter(Boolean) as string[], ...(spec.foreignKeys ?? []).map((k) => k.name).filter(Boolean) as string[]]);
  for (const idx of spec.indexes ?? []) {
    const name = idx.name ?? generateKeyName('idx', spec.name, taken);
    taken.add(name);
    statements.push(createIndexStatement(spec.name, name, idx.columns, idx.unique, idx.type));
  }
  return statements;
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

  // 键/外键/索引 diff（表设计器批次 B，§12.7）：外键无原地 ALTER → E_UNSUPPORTED（§12.2 能力矩阵，
  // UI alter 态外键 Tab 只读兜底）；唯一键变更无 ALTER CONSTRAINT → 并入表重建序列；索引可原地 DDL
  const ukDiff = diffKeyEntries(spec.uniqueKeys, current.uniqueKeys);
  const fkDiff = diffKeyEntries<ForeignKeySpec>(spec.foreignKeys, current.foreignKeys);
  const idxDiff = diffKeyEntries(spec.indexes, current.indexes);
  if (fkDiff.added.length + fkDiff.dropped.length + fkDiff.changed.length > 0) {
    throw new DriverError('E_UNSUPPORTED', 'SQLite 不支持原地修改外键（需重建表）；请经 SQL Console 处理');
  }

  const renamed = spec.name !== obj;
  const needsRebuild =
    pkChanged || changed.length > 0 || dropped.length + addedNeedRebuild.length > 0 || ukDiff.added.length + ukDiff.dropped.length + ukDiff.changed.length > 0;

  // 无需重建：加列（原地 ADD COLUMN）+ 索引 diff（原地 DDL）+ 重命名（最后执行，后续语句引用旧名）
  if (!needsRebuild) {
    const statements: DdlStatement[] = [];
    for (const k of [...idxDiff.dropped, ...idxDiff.changed]) {
      statements.push({ sql: `DROP INDEX ${quoteIdentifier(assertIdentifier('索引名', k.name!))}` });
    }
    statements.push(
      ...added.map((c) => ({
        sql: `ALTER TABLE ${quoteIdentifier(obj)} ADD COLUMN ${columnDefSql(c, undefined)}`,
      })),
    );
    if (renamed) {
      statements.push({
        sql: `ALTER TABLE ${quoteIdentifier(obj)} RENAME TO ${quoteIdentifier(spec.name)}`,
      });
    }
    for (const k of [...idxDiff.added, ...idxDiff.changed]) {
      const name = k.name ?? generateKeyName('idx', spec.name, []);
      statements.push(createIndexStatement(spec.name, name, k.columns, k.unique, k.type));
    }
    return statements;
  }

  // 表重建序列（驱动规范 §5.4；整序列含 DROP TABLE → destructive 确认分级）。
  // 目标唯一键/外键随新表 CREATE 内联承载（appendInlineConstraintClauses）；旧表索引随
  // DROP TABLE 消失——目标索引集全量重建（此前「重建不迁移索引」已知限制就此收口）
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
  const idxTaken = new Set([...(spec.uniqueKeys ?? []).map((k) => k.name).filter(Boolean) as string[], ...(spec.foreignKeys ?? []).map((k) => k.name).filter(Boolean) as string[]]);
  for (const idx of spec.indexes ?? []) {
    const name = idx.name ?? generateKeyName('idx', spec.name, idxTaken);
    idxTaken.add(name);
    statements.push(createIndexStatement(spec.name, name, idx.columns, idx.unique, idx.type));
  }
  return statements;
}
