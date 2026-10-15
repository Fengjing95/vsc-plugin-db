import {
  DriverError,
  diffKeyEntries,
  foreignKeyActionSuffix,
  generateKeyName,
  type DatabaseSpec,
  type DdlStatement,
  type ForeignKeySpec,
  type TableSpec,
} from '@db-explorer/core';
import { quoteMssqlIdentifier } from './sql';

/**
 * SQL Server 表结构编辑语句生成（M8-MSSQL，概要 §5.9 / 驱动规范 §3 @since v0.1.2）：
 * - DDL 不可参数化（T-SQL 参数化不支持 DDL 形状，驱动规范 §10）：标识符 fail-closed 校验
 *   （非法字符直接 E_VALIDATION，不靠转义兜底）+ 方括号引用；字面量 N'' 转义，控制字符拒绝
 * - 自增 = IDENTITY(1,1)（SQL Server 单表单 identity 列；驱动按「自增必须主键」前置校验，
 *   对齐 mysql 口径）；**ALTER 无法原地增删 IDENTITY**（引擎限制）→ E_UNSUPPORTED，README 声明
 * - 主键/默认值约束名（PK__… 随机后缀）无法从 TableSpec 推导 → 连接层先查 sys.key_constraints/
 *   sys.default_constraints 再传入（constraintNames），纯函数层只做生成
 * - 与 previewChanges/applyChanges 同源原则对应：ddl.preview 与 ddl.execute 都经 Host 重新
 *   调用本模块生成语句，此处只做生成
 * 纯函数，有单测。
 */

/** 标识符校验（白名单 → 危险字符黑名单）：只拒绝方言引号字符（右方括号，防逃逸）与控制字符；
 *  连字符/点/空格/中文等真实合法名交由 quoteMssqlIdentifier 双写转义承载——DDL 不可参数化的
 *  fail-closed 口径不变（注入面即引号逃逸，已从源头封死） */
// eslint-disable-next-line no-control-regex -- 刻意匹配控制字符：拒绝它们正是本校验的职责（escapeDdlLiteral 同款豁免）
const IDENT_DANGEROUS_RE = /[\u0000-\u001F\u007F\]]/;

function assertIdentifier(kind: string, name: string): string {
  if (!name || name.length > 128 || IDENT_DANGEROUS_RE.test(name)) {
    throw new DriverError('E_VALIDATION', `${kind} "${name}" 含非法字符（方言引号字符与控制字符不允许）`);
  }
  return name;
}

/** 字面量转义：数值/函数原样；其余 N'' 字符串字面量（'' 翻倍，Unicode 安全）；控制字符拒绝 */
export function escapeDdlLiteral(value: string): string {
  const t = value.trim();
  if (/^-?\d+(\.\d+)?$/.test(t) || /^CURRENT_(TIMESTAMP|DATE|TIME)$/i.test(t) || /^[a-z_][a-z0-9_]*\s*\(/i.test(t)) {
    return t;
  }
  // eslint-disable-next-line no-control-regex -- 刻意拒绝控制字符（驱动规范 §10 fail-closed）
  if (/[\r\n\x00]/.test(value)) {
    throw new DriverError('E_VALIDATION', '默认值不允许包含换行或控制字符');
  }
  return `N'${value.replace(/'/g, "''")}'`;
}

/** 注释文本转义（MS_Description 扩展属性；控制字符拒绝） */
function escapeComment(value: string): string {
  // eslint-disable-next-line no-control-regex -- 刻意拒绝控制字符（驱动规范 §10 fail-closed）
  if (/[\r\n\x00]/.test(value)) {
    throw new DriverError('E_VALIDATION', '注释不允许包含换行或控制字符');
  }
  return `N'${value.replace(/'/g, "''")}'`;
}

/** 列定义片段：[name] type [IDENTITY(1,1)] [NOT NULL|NULL] [DEFAULT …] */
function columnDefSql(col: TableSpec['columns'][number]): string {
  const parts = [quoteMssqlIdentifier(assertIdentifier('列名', col.name)), col.dataType.trim()];
  if (col.autoIncrement) {
    parts.push('IDENTITY(1,1)');
  }
  parts.push(col.nullable ? 'NULL' : 'NOT NULL');
  if (col.defaultValue !== undefined && col.defaultValue !== '') {
    parts.push(`DEFAULT ${escapeDdlLiteral(col.defaultValue)}`);
  }
  return parts.join(' ');
}

/** MS_Description 扩展属性（表/列注释）：SQL Server 无内联 COMMENT 语法 */
function extendedPropertyStatements(
  db: string,
  tableName: string,
  comment: string,
  columnName?: string,
): string {
  const levels = columnName
    ? `, @level2type = N'COLUMN', @level2name = ${escapeComment(assertIdentifier('列名', columnName))}`
    : '';
  return (
    `EXEC sp_addextendedproperty @name = N'MS_Description', @value = ${escapeComment(comment)}` +
    `, @level0type = N'SCHEMA', @level0name = ${escapeComment(db)}` +
    `, @level1type = N'TABLE', @level1name = ${escapeComment(tableName)}${levels}`
  );
}

/** 列名清单字面量（键/外键/索引共用，表设计器批次 B） */
function columnListLit(columns: readonly string[]): string {
  if (columns.length === 0) {
    throw new DriverError('E_VALIDATION', '键/索引至少需要一列');
  }
  return columns.map((c) => quoteMssqlIdentifier(assertIdentifier('列名', c))).join(', ');
}

/** 索引类型前缀（T-SQL：CREATE [UNIQUE] [CLUSTERED|NONCLUSTERED] INDEX） */
function mssqlIndexTypePrefix(type: string | undefined): string {
  return type ? `${assertIdentifier('索引类型', type)} ` : '';
}

/** 唯一键/外键的 CREATE TABLE 内联 CONSTRAINT 子句（表设计器批次 B；索引走独立 CREATE INDEX） */
function appendCreateConstraintClauses(cols: string[], spec: TableSpec): void {
  const taken = new Set<string>();
  for (const k of [...(spec.uniqueKeys ?? []), ...(spec.foreignKeys ?? [])]) {
    if (k.name) {
      taken.add(k.name);
    }
  }
  for (const uk of spec.uniqueKeys ?? []) {
    const name = assertIdentifier('唯一键名', uk.name ?? generateKeyName('uk', spec.name, taken));
    taken.add(name);
    cols.push(`CONSTRAINT ${quoteMssqlIdentifier(name)} UNIQUE (${columnListLit(uk.columns)})`);
  }
  for (const fk of spec.foreignKeys ?? []) {
    if (fk.refColumns.length !== fk.columns.length) {
      throw new DriverError('E_VALIDATION', `外键 "${fk.name ?? '(未命名)'}" 引用列数须与本地列数一致`);
    }
    const name = assertIdentifier('外键名', fk.name ?? generateKeyName('fk', spec.name, taken));
    taken.add(name);
    cols.push(
      `CONSTRAINT ${quoteMssqlIdentifier(name)} FOREIGN KEY (${columnListLit(fk.columns)}) REFERENCES ${quoteMssqlIdentifier(assertIdentifier('引用表名', fk.refTable))} (${columnListLit(fk.refColumns)})${foreignKeyActionSuffix(fk)}`,
    );
  }
}

/** 二级索引独立语句（CREATE [UNIQUE] [type] INDEX；T-SQL 无内联索引语法） */
function createIndexStatements(db: string, spec: TableSpec): DdlStatement[] {
  const taken = new Set((spec.uniqueKeys ?? []).map((k) => k.name).filter(Boolean) as string[]);
  const qualified = `${quoteMssqlIdentifier(db)}.${quoteMssqlIdentifier(spec.name)}`;
  return (spec.indexes ?? []).map((idx) => {
    const name = assertIdentifier('索引名', idx.name ?? generateKeyName('idx', spec.name, taken));
    taken.add(name);
    return {
      sql: `CREATE ${idx.unique ? 'UNIQUE ' : ''}${mssqlIndexTypePrefix(idx.type)}INDEX ${quoteMssqlIdentifier(name)} ON ${qualified} (${columnListLit(idx.columns)})`,
    };
  });
}

export function buildCreateTableStatements(db: string, spec: TableSpec): DdlStatement[] {
  assertIdentifier('架构名', db);
  assertIdentifier('表名', spec.name);
  if (spec.columns.length === 0) {
    throw new DriverError('E_VALIDATION', '表至少需要一列');
  }
  const identities = spec.columns.filter((c) => c.autoIncrement);
  if (identities.length > 1) {
    throw new DriverError('E_VALIDATION', '一张表只允许一个自增列（SQL Server IDENTITY 约束）');
  }
  for (const c of spec.columns) {
    if (c.autoIncrement && !c.isPrimaryKey) {
      throw new DriverError('E_VALIDATION', `列 "${c.name}" 声明了自增但不是主键`);
    }
  }
  const cols = spec.columns.map(columnDefSql);
  const pk = spec.columns.filter((c) => c.isPrimaryKey).map((c) => `${quoteMssqlIdentifier(c.name)} ASC`);
  if (pk.length > 0) {
    cols.push(`PRIMARY KEY CLUSTERED (${pk.join(', ')})`);
  }
  appendCreateConstraintClauses(cols, spec);
  const statements: DdlStatement[] = [
    { sql: `CREATE TABLE ${quoteMssqlIdentifier(db)}.${quoteMssqlIdentifier(spec.name)} (\n  ${cols.join(',\n  ')}\n) ON [PRIMARY]` },
    ...createIndexStatements(db, spec),
  ];
  if (spec.comment) {
    statements.push({ sql: extendedPropertyStatements(db, spec.name, spec.comment) });
  }
  for (const c of spec.columns) {
    if (c.comment) {
      statements.push({ sql: extendedPropertyStatements(db, spec.name, c.comment, c.name) });
    }
  }
  return statements;
}

/** 连接层查询的约束名（PK__…/DF__… 为服务端随机名，纯函数层无法推导） */
export interface AlterConstraintNames {
  /** 当前主键约束名（主键变更时必需——T-SQL 无 DROP PRIMARY KEY 语法） */
  pkConstraintName?: string;
  /** 列名 → 默认值约束名 */
  defaultConstraints?: Map<string, string>;
}

export function buildAlterTableStatements(
  db: string,
  obj: string,
  spec: TableSpec,
  current: TableSpec,
  constraintNames?: AlterConstraintNames,
): DdlStatement[] {
  assertIdentifier('架构名', db);
  assertIdentifier('表名', spec.name);
  assertIdentifier('表名', obj);
  for (const c of spec.columns) {
    assertIdentifier('列名', c.name);
    if (c.autoIncrement && !c.isPrimaryKey) {
      throw new DriverError('E_VALIDATION', `列 "${c.name}" 声明了自增但不是主键`);
    }
  }
  const names = constraintNames ?? {};
  const defaults = names.defaultConstraints ?? new Map<string, string>();
  const statements: DdlStatement[] = [];
  const alterPrefix = `${quoteMssqlIdentifier(db)}.${quoteMssqlIdentifier(spec.name)}`;

  // 重命名（T-SQL 无 RENAME TO，sp_rename 系统存储过程；后续语句引用新名）
  if (spec.name !== obj) {
    statements.push({ sql: `EXEC sp_rename ${escapeComment(`${db}.${obj}`)}, ${escapeComment(spec.name)}` });
  }

  const curByName = new Map(current.columns.map((c) => [c.name, c]));
  const tgtByName = new Map(spec.columns.map((c) => [c.name, c]));

  const curPk = current.columns.filter((c) => c.isPrimaryKey).map((c) => c.name);
  const tgtPk = spec.columns.filter((c) => c.isPrimaryKey).map((c) => c.name);
  const pkChanged = curPk.join(',') !== tgtPk.join(',');

  const curPkChanged = (c: TableSpec['columns'][number]): boolean => Boolean(c.autoIncrement) !== Boolean(curByName.get(c.name)?.autoIncrement);
  for (const c of spec.columns) {
    if (curByName.has(c.name) && curPkChanged(c)) {
      // SQL Server 引擎限制：ALTER COLUMN 不能增删 IDENTITY（需表重建，D-16 同类取舍）
      throw new DriverError('E_UNSUPPORTED', `列 "${c.name}" 的自增（IDENTITY）不支持原地变更，需要重建表`);
    }
  }

  const droppedCols = current.columns.filter((c) => !tgtByName.has(c.name));
  const alteredCols = spec.columns.filter((c) => {
    const cur = curByName.get(c.name);
    return cur && (cur.dataType.trim() !== c.dataType.trim() || cur.nullable !== c.nullable);
  });
  const defaultChangedCols = spec.columns.filter((c) => {
    const cur = curByName.get(c.name);
    return cur && (cur.defaultValue ?? '') !== (c.defaultValue ?? '');
  });
  // ALTER COLUMN / DROP COLUMN 前必须先删该列的默认值约束（T-SQL：约束依赖即拒绝）
  const constraintDropCols = new Set([...alteredCols, ...defaultChangedCols, ...droppedCols].map((c) => c.name));

  // ① 主键约束先删（IDENTITY 列依赖主键约束时，删列/换键前置解除）
  if (pkChanged && curPk.length > 0) {
    if (!names.pkConstraintName) {
      throw new DriverError('E_VALIDATION', '主键约束名缺失（连接层未查询到 PK 约束）');
    }
    statements.push({
      sql: `ALTER TABLE ${alterPrefix} DROP CONSTRAINT ${quoteMssqlIdentifier(names.pkConstraintName)}`,
      destructive: true,
    });
  }

  // ② 默认值约束先删（约束依赖：ALTER COLUMN / DROP COLUMN 前置解除；删列无回填）
  for (const name of constraintDropCols) {
    const dfName = defaults.get(name);
    if (dfName) {
      statements.push({ sql: `ALTER TABLE ${alterPrefix} DROP CONSTRAINT ${quoteMssqlIdentifier(dfName)}` });
    }
  }

  // ②′ 键/外键/索引 diff 删除半段（表设计器批次 B，§12.7 红线：DROP 只由「基线存在且 spec 移除」
  // 生成）——必须在列删除之前：T-SQL 对被外键依赖的列拒绝 DROP COLUMN
  const keyTaken = new Set<string>();
  for (const k of [...(current.uniqueKeys ?? []), ...(current.foreignKeys ?? []), ...(current.indexes ?? [])]) {
    if (k.name) {
      keyTaken.add(k.name);
    }
  }
  const ukDiff = diffKeyEntries(spec.uniqueKeys, current.uniqueKeys);
  const fkDiff = diffKeyEntries<ForeignKeySpec>(spec.foreignKeys, current.foreignKeys);
  const idxDiff = diffKeyEntries(spec.indexes, current.indexes);
  for (const k of [...fkDiff.dropped, ...fkDiff.changed]) {
    statements.push({
      sql: `ALTER TABLE ${alterPrefix} DROP CONSTRAINT ${quoteMssqlIdentifier(assertIdentifier('外键名', k.name!))}`,
    });
  }
  for (const k of [...ukDiff.dropped, ...ukDiff.changed]) {
    statements.push({
      sql: `ALTER TABLE ${alterPrefix} DROP CONSTRAINT ${quoteMssqlIdentifier(assertIdentifier('唯一键名', k.name!))}`,
    });
  }
  for (const k of [...idxDiff.dropped, ...idxDiff.changed]) {
    statements.push({ sql: `DROP INDEX ${quoteMssqlIdentifier(assertIdentifier('索引名', k.name!))} ON ${alterPrefix}` });
  }

  // ③ 删列（可能丢数据 → destructive）
  for (const cur of droppedCols) {
    statements.push({
      sql: `ALTER TABLE ${alterPrefix} DROP COLUMN ${quoteMssqlIdentifier(cur.name)}`,
      destructive: true,
    });
  }

  // ④ 改列（ALTER COLUMN 全量类型 + NOT NULL；类型变化标 destructive——可能截断/丢数据）
  for (const tgt of alteredCols) {
    statements.push({
      sql: `ALTER TABLE ${alterPrefix} ALTER COLUMN ${quoteMssqlIdentifier(tgt.name)} ${tgt.dataType.trim()} ${tgt.nullable ? 'NULL' : 'NOT NULL'}`,
      destructive: curByName.get(tgt.name)!.dataType.trim() !== tgt.dataType.trim() || undefined,
    });
  }

  // ⑤ 加列（行数据不丢 → 非 destructive）
  for (const tgt of spec.columns) {
    if (!curByName.has(tgt.name)) {
      statements.push({ sql: `ALTER TABLE ${alterPrefix} ADD ${columnDefSql(tgt)}` });
    }
  }

  // ⑥ 默认值约束回填/新增：仅当该列的原约束已被本语句集删除（map 命中）或默认值本身变化时回填
  //   （沿用旧约束名；新默认值按 DF_<表>_<列> 命名）
  for (const tgt of [...alteredCols, ...defaultChangedCols]) {
    if (tgt.defaultValue === undefined || tgt.defaultValue === '') {
      continue;
    }
    const hadConstraint = defaults.has(tgt.name);
    const defaultChanged = defaultChangedCols.includes(tgt);
    if (!hadConstraint && !defaultChanged) {
      continue;
    }
    const dfName = defaults.get(tgt.name) ?? `DF_${spec.name}_${tgt.name}`;
    statements.push({
      sql: `ALTER TABLE ${alterPrefix} ADD CONSTRAINT ${quoteMssqlIdentifier(assertIdentifier('约束名', dfName))} DEFAULT ${escapeDdlLiteral(tgt.defaultValue)} FOR ${quoteMssqlIdentifier(tgt.name)}`,
    });
  }

  // ⑦ 主键重建（旧约束已在上文删除）
  if (pkChanged && tgtPk.length > 0) {
    statements.push({
      sql: `ALTER TABLE ${alterPrefix} ADD PRIMARY KEY CLUSTERED (${tgtPk.map((n) => `${quoteMssqlIdentifier(n)} ASC`).join(', ')})`,
    });
  }

  // ⑦′ 键/外键/索引 diff 添加半段（列变更之后：外键/索引可引用新加列）
  for (const k of [...ukDiff.added, ...ukDiff.changed]) {
    const name = assertIdentifier('唯一键名', k.name ?? generateKeyName('uk', spec.name, keyTaken));
    keyTaken.add(name);
    statements.push({
      sql: `ALTER TABLE ${alterPrefix} ADD CONSTRAINT ${quoteMssqlIdentifier(name)} UNIQUE (${columnListLit(k.columns)})`,
    });
  }
  for (const k of [...fkDiff.added, ...fkDiff.changed]) {
    if (k.refColumns.length !== k.columns.length) {
      throw new DriverError('E_VALIDATION', `外键 "${k.name ?? '(未命名)'}" 引用列数须与本地列数一致`);
    }
    const name = assertIdentifier('外键名', k.name ?? generateKeyName('fk', spec.name, keyTaken));
    keyTaken.add(name);
    statements.push({
      sql: `ALTER TABLE ${alterPrefix} ADD CONSTRAINT ${quoteMssqlIdentifier(name)} FOREIGN KEY (${columnListLit(k.columns)}) REFERENCES ${quoteMssqlIdentifier(assertIdentifier('引用表名', k.refTable))} (${columnListLit(k.refColumns)})${foreignKeyActionSuffix(k)}`,
    });
  }
  for (const k of [...idxDiff.added, ...idxDiff.changed]) {
    const name = assertIdentifier('索引名', k.name ?? generateKeyName('idx', spec.name, keyTaken));
    keyTaken.add(name);
    statements.push({
      sql: `CREATE ${k.unique ? 'UNIQUE ' : ''}${mssqlIndexTypePrefix(k.type)}INDEX ${quoteMssqlIdentifier(name)} ON ${alterPrefix} (${columnListLit(k.columns)})`,
    });
  }

  // ⑧ 表/列注释（MS_Description 扩展属性；current 有值 = 更新语义）
  if ((spec.comment ?? '') !== (current.comment ?? '') && spec.comment) {
    statements.push({
      sql: current.comment
        ? `EXEC sp_updateextendedproperty @name = N'MS_Description', @value = ${escapeComment(spec.comment)}, @level0type = N'SCHEMA', @level0name = ${escapeComment(db)}, @level1type = N'TABLE', @level1name = ${escapeComment(spec.name)}`
        : extendedPropertyStatements(db, spec.name, spec.comment),
    });
  }
  for (const tgt of spec.columns) {
    const cur = curByName.get(tgt.name);
    if (cur && (cur.comment ?? '') !== (tgt.comment ?? '') && tgt.comment) {
      statements.push({
        sql: cur.comment
          ? `EXEC sp_updateextendedproperty @name = N'MS_Description', @value = ${escapeComment(tgt.comment)}, @level0type = N'SCHEMA', @level0name = ${escapeComment(db)}, @level1type = N'TABLE', @level1name = ${escapeComment(spec.name)}, @level2type = N'COLUMN', @level2name = ${escapeComment(tgt.name)}`
          : extendedPropertyStatements(db, spec.name, tgt.comment, tgt.name),
      });
    }
  }

  return statements;
}

// ── 库级 DDL（M8-DBDDL / D-19）：SQL Server「库」= schema（ADR D-21，D-15 同构）——
//    CREATE / DROP SCHEMA（纯函数）。DROP SCHEMA 仅空 schema 可删（非空由服务端拒绝——
//    PG 的 CASCADE 在 T-SQL 不存在，destructive 红条 + 树删库名称确认承载）。

export function buildCreateSchemaStatements(spec: DatabaseSpec): DdlStatement[] {
  assertIdentifier('schema 名', spec.name);
  return [{ sql: `CREATE SCHEMA ${quoteMssqlIdentifier(spec.name)}` }];
}

export function buildDropSchemaStatements(db: string): DdlStatement[] {
  assertIdentifier('schema 名', db);
  return [{ sql: `DROP SCHEMA ${quoteMssqlIdentifier(db)}`, destructive: true }];
}
