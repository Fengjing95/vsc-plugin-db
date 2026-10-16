import {
  DriverError,
  diffKeyEntries,
  foreignKeyActionSuffix,
  generateKeyName,
  type DatabaseMeta,
  type DatabaseSpec,
  type DdlStatement,
  type ForeignKeySpec,
  type TableSpec,
} from '@db-explorer/core';

/**
 * MySQL 表结构编辑语句生成（M8-B2，概要 §5.9 / 驱动规范 §3 @since v0.1.2）：
 * - DDL 不可参数化（MySQL PREPARE 不支持多数 DDL 形状，驱动规范 §10）：
 *   标识符 fail-closed 校验（非法字符直接 E_VALIDATION，不靠转义兜底）+ 反引号引用；
 *   字面量（默认值/注释）转义，控制字符拒绝
 * - 与 previewChanges/applyChanges 同源原则对应：ddl.preview 与 ddl.execute 都经
 *   Host 重新调用本模块生成语句（extension ddlService 保证），此处只做纯生成
 * 纯函数，有单测。
 */

/** 标识符校验（白名单 → 危险字符黑名单）：只拒绝方言引号字符（反引号，防逃逸）与控制字符
 *  （无法安全承载）；连字符/点/空格/中文等真实合法名交由 quoteMysqlIdentifier 双写转义承载——
 *  DDL 不可参数化的 fail-closed 口径不变（注入面即引号逃逸，已从源头封死） */
// eslint-disable-next-line no-control-regex -- 刻意匹配控制字符：拒绝它们正是本校验的职责（escapeDdlLiteral 同款豁免）
const IDENT_DANGEROUS_RE = /[\u0000-\u001F\u007F`]/;

function assertIdentifier(kind: string, name: string): string {
  if (!name || name.length > 128 || IDENT_DANGEROUS_RE.test(name)) {
    throw new DriverError('E_VALIDATION', `${kind} "${name}" 含非法字符（方言引号字符与控制字符不允许）`);
  }
  return name;
}

/** 关键字面量校验（字符集/排序规则）：语句中原样拼接、不可引用——保持严格白名单
 *  （标识符黑名单口径不适用于此类非引用插值） */
const KEYWORD_RE = /^[A-Za-z0-9_$]+$/;

function assertKeyword(kind: string, value: string): string {
  if (!KEYWORD_RE.test(value) || value.length > 64) {
    throw new DriverError('E_VALIDATION', `${kind} "${value}" 含非法字符（字母/数字/_/$ 之外不允许）`);
  }
  return value;
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

/** 列名清单字面量（键/外键/索引共用，表设计器批次 B） */
function columnListLit(columns: readonly string[]): string {
  if (columns.length === 0) {
    throw new DriverError('E_VALIDATION', '键/索引至少需要一列');
  }
  return columns.map((c) => `\`${assertIdentifier('列名', c)}\``).join(', ');
}

/** CREATE TABLE 内联键/外键/索引子句（表设计器批次 B，交互稿 §12.4~12.6）：
 *  命名 fail-closed（未命名自动 uk_/fk_/idx_ 表名_序号），外键引用列数须与本地一致 */
function appendCreateKeyClauses(cols: string[], spec: TableSpec): void {
  const taken = new Set<string>();
  for (const k of [...(spec.uniqueKeys ?? []), ...(spec.foreignKeys ?? []), ...(spec.indexes ?? [])]) {
    if (k.name) {
      taken.add(k.name);
    }
  }
  for (const uk of spec.uniqueKeys ?? []) {
    const name = assertIdentifier('唯一键名', uk.name ?? generateKeyName('uk', spec.name, taken));
    taken.add(name);
    cols.push(`UNIQUE KEY \`${name}\` (${columnListLit(uk.columns)})`);
  }
  for (const fk of spec.foreignKeys ?? []) {
    if (fk.refColumns.length !== fk.columns.length) {
      throw new DriverError('E_VALIDATION', `外键 "${fk.name ?? '(未命名)'}" 引用列数须与本地列数一致`);
    }
    const name = assertIdentifier('外键名', fk.name ?? generateKeyName('fk', spec.name, taken));
    taken.add(name);
    cols.push(
      `CONSTRAINT \`${name}\` FOREIGN KEY (${columnListLit(fk.columns)}) REFERENCES \`${assertIdentifier('引用表名', fk.refTable)}\` (${columnListLit(fk.refColumns)})${foreignKeyActionSuffix(fk)}`,
    );
  }
  for (const idx of spec.indexes ?? []) {
    const name = assertIdentifier('索引名', idx.name ?? generateKeyName('idx', spec.name, taken));
    taken.add(name);
    const using = idx.type ? ` USING ${assertIdentifier('索引类型', idx.type)}` : '';
    cols.push(`${idx.unique ? 'UNIQUE INDEX' : 'INDEX'} \`${name}\` (${columnListLit(idx.columns)})${using}`);
  }
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
  appendCreateKeyClauses(cols, spec);
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
  // 主键变更：DROP PRIMARY KEY 必须与 ADD PRIMARY KEY / 自增列的 DROP COLUMN 合并**单句**——
  // 表含 AUTO_INCREMENT 列时，单独 DROP PRIMARY KEY（瞬时自增列无键）被 MySQL 拒绝
  // （there can be only one auto column...，契约主键变更 check CI 实跑暴露）；合并句按语句
  // 末状态校验，合法
  if (pkChanged && curPk.length > 0) {
    const clauses = ['DROP PRIMARY KEY'];
    if (tgtPk.length > 0) {
      clauses.push(`ADD PRIMARY KEY (${tgtPk.map((n) => `\`${n}\``).join(', ')})`);
    }
    for (const c of current.columns) {
      if (c.autoIncrement && !tgtByName.has(c.name)) {
        clauses.push(`DROP COLUMN \`${c.name}\``);
      }
    }
    statements.push({ sql: `ALTER TABLE ${alterPrefix} ${clauses.join(', ')}`, destructive: true });
  }

  // ── 键/外键/索引 diff（表设计器批次 B，§12.7 红线：DROP 只由「基线存在且 spec 移除」生成）──
  // 拆两半段：**删除半段在列删除之前**（外键/索引可能依赖将删的列，MySQL 对在用外键的删列直接拒绝）；
  // 添加半段在列变更之后（外键/索引可引用新加列）
  const taken = new Set<string>();
  for (const k of [...(current.uniqueKeys ?? []), ...(current.foreignKeys ?? []), ...(current.indexes ?? [])]) {
    if (k.name) {
      taken.add(k.name);
    }
  }
  const alterBase = `ALTER TABLE ${alterPrefix}`;
  const ukDiff = diffKeyEntries(spec.uniqueKeys, current.uniqueKeys);
  const idxDiff = diffKeyEntries(spec.indexes, current.indexes);
  const fkDiff = diffKeyEntries<ForeignKeySpec>(spec.foreignKeys, current.foreignKeys);
  for (const k of [...ukDiff.dropped, ...ukDiff.changed]) {
    statements.push({ sql: `${alterBase} DROP KEY \`${assertIdentifier('唯一键名', k.name!)}\`` });
  }
  for (const k of [...idxDiff.dropped, ...idxDiff.changed]) {
    statements.push({ sql: `${alterBase} DROP INDEX \`${assertIdentifier('索引名', k.name!)}\`` });
  }
  for (const k of [...fkDiff.dropped, ...fkDiff.changed]) {
    statements.push({ sql: `${alterBase} DROP FOREIGN KEY \`${assertIdentifier('外键名', k.name!)}\`` });
  }

  // 删列（可能丢数据 → destructive；自增列若已并入上方主键变更单句则跳过）
  for (const cur of current.columns) {
    if (!tgtByName.has(cur.name) && !(pkChanged && curPk.length > 0 && cur.autoIncrement)) {
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

  // 主键重建：已并入上方主键变更单句（此处不再重复生成）

  // ── 键/外键/索引 diff 添加半段（列变更之后：外键/索引可引用新加列）
  for (const k of [...ukDiff.added, ...ukDiff.changed]) {
    const name = assertIdentifier('唯一键名', k.name ?? generateKeyName('uk', spec.name, taken));
    taken.add(name);
    statements.push({ sql: `${alterBase} ADD UNIQUE KEY \`${name}\` (${columnListLit(k.columns)})` });
  }
  for (const k of [...idxDiff.added, ...idxDiff.changed]) {
    const name = assertIdentifier('索引名', k.name ?? generateKeyName('idx', spec.name, taken));
    taken.add(name);
    const using = k.type ? ` USING ${assertIdentifier('索引类型', k.type)}` : '';
    statements.push({ sql: `${alterBase} ADD ${k.unique ? 'UNIQUE ' : ''}INDEX \`${name}\` (${columnListLit(k.columns)})${using}` });
  }
  for (const k of [...fkDiff.added, ...fkDiff.changed]) {
    if (k.refColumns.length !== k.columns.length) {
      throw new DriverError('E_VALIDATION', `外键 "${k.name ?? '(未命名)'}" 引用列数须与本地列数一致`);
    }
    const name = assertIdentifier('外键名', k.name ?? generateKeyName('fk', spec.name, taken));
    taken.add(name);
    statements.push({
      sql: `${alterBase} ADD CONSTRAINT \`${name}\` FOREIGN KEY (${columnListLit(k.columns)}) REFERENCES \`${assertIdentifier('引用表名', k.refTable)}\` (${columnListLit(k.refColumns)})${foreignKeyActionSuffix(k)}`,
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
    parts.push(`CHARACTER SET ${assertKeyword('字符集', spec.charset)}`);
  }
  if (spec.collation) {
    parts.push(`COLLATE ${assertKeyword('排序规则', spec.collation)}`);
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
    parts.push(`CHARACTER SET ${assertKeyword('字符集', spec.charset)}`);
  }
  if (spec.collation && spec.collation !== current.collation) {
    parts.push(`COLLATE ${assertKeyword('排序规则', spec.collation)}`);
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
