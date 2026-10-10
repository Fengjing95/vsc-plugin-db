import { DriverError, type DatabaseMeta, type DatabaseSpec, type DdlStatement, type TableSpec } from '@db-explorer/core';

/**
 * MySQL 表结构编辑语句生成（M8-B2，概要 §5.9 / 驱动规范 §3 @since v0.1.2）：
 * - DDL 不可参数化（MySQL PREPARE 不支持多数 DDL 形状，驱动规范 §10）：
 *   标识符 fail-closed 校验（非法字符直接 E_VALIDATION，不靠转义兜底）+ 反引号引用；
 *   字面量（默认值/注释）转义，控制字符拒绝
 * - 与 previewChanges/applyChanges 同源原则对应：ddl.preview 与 ddl.execute 都经
 *   Host 重新调用本模块生成语句（extension ddlService 保证），此处只做纯生成
 * 纯函数，有单测。
 */

const IDENT_RE = /^[A-Za-z0-9_$]+$/;

function assertIdentifier(kind: string, name: string): string {
  if (!IDENT_RE.test(name) || name.length > 128) {
    throw new DriverError('E_VALIDATION', `${kind} "${name}" 含非法字符（字母/数字/_/$ 之外不允许）`);
  }
  return name;
}

/** 字面量转义：数值与 CURRENT_TIMESTAMP 原样；其余字符串字面量单引号包裹（'' 翻倍，默认 sql_mode 下合法）；控制字符拒绝 */
export function escapeDdlLiteral(value: string): string {
  if (/^-?\d+(\.\d+)?$/.test(value) || /^CURRENT_TIMESTAMP$/i.test(value.trim())) {
    return value.trim();
  }
  // eslint-disable-next-line no-control-regex -- 刻意拒绝控制字符/反斜杠（驱动规范 §10 fail-closed）
  if (/[\r\n\x00\\]/.test(value)) {
    throw new DriverError('E_VALIDATION', '默认值不允许包含换行/反斜杠/控制字符');
  }
  return `'${value.replace(/'/g, "''")}'`;
}

/** 注释文本转义（COMMENT 子句；控制字符/反斜杠拒绝） */
function escapeComment(value: string): string {
  // eslint-disable-next-line no-control-regex -- 刻意拒绝控制字符/反斜杠（驱动规范 §10 fail-closed）
  if (/[\r\n\x00\\]/.test(value)) {
    throw new DriverError('E_VALIDATION', '注释不允许包含换行/反斜杠/控制字符');
  }
  return `'${value.replace(/'/g, "''")}'`;
}

function columnDefSql(col: TableSpec['columns'][number]): string {
  const parts = [`\`${assertIdentifier('列名', col.name)}\``, col.dataType.trim()];
  parts.push(col.nullable ? 'NULL' : 'NOT NULL');
  if (col.defaultValue !== undefined && col.defaultValue !== '') {
    parts.push(`DEFAULT ${escapeDdlLiteral(col.defaultValue)}`);
  }
  if (col.comment) {
    parts.push(`COMMENT ${escapeComment(col.comment)}`);
  }
  if (col.autoIncrement) {
    parts.push('AUTO_INCREMENT');
  }
  return parts.join(' ');
}

export function buildCreateTableStatements(db: string, spec: TableSpec): DdlStatement[] {
  assertIdentifier('库名', db);
  assertIdentifier('表名', spec.name);
  if (spec.columns.length === 0) {
    throw new DriverError('E_VALIDATION', '表至少需要一列');
  }
  for (const c of spec.columns) {
    if (c.autoIncrement && !c.isPrimaryKey) {
      // MySQL 约束：AUTO_INCREMENT 列必须为键（简化为必须主键）
      throw new DriverError('E_VALIDATION', `列 "${c.name}" 声明了自增但不是主键`);
    }
  }
  const cols = spec.columns.map(columnDefSql);
  const pk = spec.columns.filter((c) => c.isPrimaryKey).map((c) => `\`${c.name}\``);
  if (pk.length > 0) {
    cols.push(`PRIMARY KEY (${pk.join(', ')})`);
  }
  const tail = spec.comment ? ` COMMENT=${escapeComment(spec.comment)}` : '';
  return [{ sql: `CREATE TABLE \`${db}\`.\`${spec.name}\` (\n  ${cols.join(',\n  ')}\n)${tail}` }];
}

/** 列定义差异：类型/nullable/自增/默认值/注释任一变化即 MODIFY（类型变化标 destructive） */
function columnDiffers(a: TableSpec['columns'][number], b: TableSpec['columns'][number]): boolean {
  return (
    a.dataType.trim() !== b.dataType.trim() ||
    a.nullable !== b.nullable ||
    Boolean(a.autoIncrement) !== Boolean(b.autoIncrement) ||
    (a.defaultValue ?? '') !== (b.defaultValue ?? '') ||
    (a.comment ?? '') !== (b.comment ?? '')
  );
}

export function buildAlterTableStatements(
  db: string,
  obj: string,
  spec: TableSpec,
  current: TableSpec,
): DdlStatement[] {
  assertIdentifier('库名', db);
  assertIdentifier('表名', spec.name);
  assertIdentifier('表名', obj);
  for (const c of spec.columns) {
    assertIdentifier('列名', c.name);
    if (c.autoIncrement && !c.isPrimaryKey) {
      throw new DriverError('E_VALIDATION', `列 "${c.name}" 声明了自增但不是主键`);
    }
  }
  const statements: DdlStatement[] = [];
  const alterPrefix = `\`${db}\`.\`${spec.name}\``;

  if (spec.name !== obj) {
    statements.push({ sql: `ALTER TABLE \`${db}\`.\`${obj}\` RENAME TO ${alterPrefix}` });
  }

  const curByName = new Map(current.columns.map((c) => [c.name, c]));
  const tgtByName = new Map(spec.columns.map((c) => [c.name, c]));

  const curPk = current.columns.filter((c) => c.isPrimaryKey).map((c) => c.name);
  const tgtPk = spec.columns.filter((c) => c.isPrimaryKey).map((c) => c.name);
  const pkChanged = curPk.join(',') !== tgtPk.join(',');
  // 主键变化需先 DROP PRIMARY KEY（MySQL 语义：一个表只有一个主键索引；删主键列时必须先删键）
  if (pkChanged && curPk.length > 0) {
    statements.push({ sql: `ALTER TABLE ${alterPrefix} DROP PRIMARY KEY`, destructive: true });
  }

  // 删列（可能丢数据 → destructive）
  for (const cur of current.columns) {
    if (!tgtByName.has(cur.name)) {
      statements.push({
        sql: `ALTER TABLE ${alterPrefix} DROP COLUMN \`${cur.name}\``,
        destructive: true,
      });
    }
  }

  // 加列（非 destructive）
  for (const tgt of spec.columns) {
    if (!curByName.has(tgt.name)) {
      statements.push({ sql: `ALTER TABLE ${alterPrefix} ADD COLUMN ${columnDefSql(tgt)}` });
    }
  }

  // 改列（MODIFY 全量定义；类型变化标 destructive）
  for (const tgt of spec.columns) {
    const cur = curByName.get(tgt.name);
    if (!cur) {
      continue;
    }
    if (columnDiffers(cur, tgt)) {
      const typeChanged = cur.dataType.trim() !== tgt.dataType.trim();
      statements.push({
        sql: `ALTER TABLE ${alterPrefix} MODIFY COLUMN ${columnDefSql({ ...tgt, isPrimaryKey: false })}`,
        destructive: typeChanged || undefined,
      });
    }
  }

  // 主键重建（DROP 已在上文）
  if (pkChanged && tgtPk.length > 0) {
    statements.push({
      sql: `ALTER TABLE ${alterPrefix} ADD PRIMARY KEY (${tgtPk.map((n) => `\`${n}\``).join(', ')})`,
    });
  }

  // 表注释
  if ((spec.comment ?? '') !== (current.comment ?? '') && spec.comment) {
    statements.push({ sql: `ALTER TABLE ${alterPrefix} COMMENT=${escapeComment(spec.comment)}` });
  }

  return statements;
}

// ── 库级 DDL（M8-DBDDL / D-19）：CREATE / ALTER / DROP DATABASE（纯函数）──────────

export function buildCreateDatabaseStatements(spec: DatabaseSpec): DdlStatement[] {
  assertIdentifier('库名', spec.name);
  const parts = [`CREATE DATABASE \`${spec.name}\``];
  if (spec.charset) {
    parts.push(`CHARACTER SET ${assertIdentifier('字符集', spec.charset)}`);
  }
  if (spec.collation) {
    parts.push(`COLLATE ${assertIdentifier('排序规则', spec.collation)}`);
  }
  return [{ sql: parts.join(' ') }];
}

export function buildAlterDatabaseStatements(
  db: string,
  spec: DatabaseSpec,
  current: DatabaseMeta,
): DdlStatement[] {
  assertIdentifier('库名', db);
  if (spec.name !== db) {
    throw new DriverError('E_VALIDATION', '不支持重命名库（ALTER DATABASE 仅字符集/排序规则维度）');
  }
  const parts: string[] = [];
  if (spec.charset && spec.charset !== current.charset) {
    parts.push(`CHARACTER SET ${assertIdentifier('字符集', spec.charset)}`);
  }
  if (spec.collation && spec.collation !== current.collation) {
    parts.push(`COLLATE ${assertIdentifier('排序规则', spec.collation)}`);
  }
  if (parts.length === 0) {
    return []; // 无差异（契约组口径）
  }
  return [{ sql: `ALTER DATABASE \`${db}\` ${parts.join(' ')}` }];
}

export function buildDropDatabaseStatements(db: string): DdlStatement[] {
  assertIdentifier('库名', db);
  return [{ sql: `DROP DATABASE \`${db}\``, destructive: true }];
}
