import {
  DriverError,
  diffKeyEntries,
  foreignKeyActionSuffix,
  generateKeyName,
  type ColumnMeta,
  type DdlStatement,
  type ForeignKeySpec,
  type IndexMeta,
  type KeyMeta,
  type NormalizedType,
  type TableSpec,
} from '@db-explorer/core';

/**
 * mock 驱动的表结构编辑（M8-B2，概要 §5.9 / 驱动规范 §3 @since v0.1.2）：
 * - builder 生成 MySQL 方言 DDL（与 driver-mysql 同一套纪律：标识符 fail-closed 校验、
 *   字面量转义、destructive 标记）——DDL 不可参数化（驱动规范 §10）
 * - executor 只解析本模块生成的语句形状（CREATE/ALTER/DROP TABLE），经注入的注册表句柄
 *   对 tableDefs/store 就地变更（P-18 共享物化存储语义）；query() 经 isMockDdlStatement 路由
 * 纯函数 + 显式注册表句柄注入，有单测。
 */

/** 标识符校验（白名单 → 危险字符黑名单，与 driver-mysql 同口径）：拒绝反引号（防逃逸，执行器
 *  解析依赖该前提）与控制字符；连字符/点/空格/中文等真实合法名交由反引号引用承载 */
// eslint-disable-next-line no-control-regex -- 刻意匹配控制字符：拒绝它们正是本校验的职责（escapeDdlLiteral 同款豁免）
const IDENT_DANGEROUS_RE = /[\u0000-\u001F\u007F`]/;

function assertIdentifier(kind: string, name: string): string {
  if (!name || name.length > 128 || IDENT_DANGEROUS_RE.test(name)) {
    throw new DriverError('E_VALIDATION', `${kind} "${name}" 含非法字符（方言引号字符与控制字符不允许）`);
  }
  return name;
}

/** 字面量转义：数值与 CURRENT_TIMESTAMP 原样；其余按字符串字面量单引号包裹；控制字符拒绝 */
export function escapeDdlLiteral(value: string): string {
  if (/^-?\d+(\.\d+)?$/.test(value) || /^CURRENT_TIMESTAMP$/i.test(value.trim())) {
    return value.trim();
  }
  // eslint-disable-next-line no-control-regex -- 刻意拒绝控制字符（驱动规范 §10 fail-closed）
  if (/[\r\n\x00]/.test(value)) {
    throw new DriverError('E_VALIDATION', '默认值/注释不允许包含换行或控制字符');
  }
  return `'${value.replace(/'/g, "''")}'`;
}

/** 注释/字符串文本转义（包裹单引号，内部 ' 翻倍；控制字符 fail-closed） */
function escapeText(value: string): string {
  // eslint-disable-next-line no-control-regex -- 刻意拒绝控制字符（驱动规范 §10 fail-closed）
  if (/[\r\n\x00]/.test(value)) {
    throw new DriverError('E_VALIDATION', '注释不允许包含换行或控制字符');
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
    parts.push(`COMMENT ${escapeText(col.comment)}`);
  }
  if (col.autoIncrement) {
    parts.push('AUTO_INCREMENT');
  }
  return parts.join(' ');
}

/** 列名清单字面量（`\`a\`, \`b\``） */
function columnListLit(columns: readonly string[]): string {
  if (columns.length === 0) {
    throw new DriverError('E_VALIDATION', '键/索引至少需要一列');
  }
  return columns.map((c) => `\`${assertIdentifier('列名', c)}\``).join(', ');
}

export function buildMockCreateTable(db: string, spec: TableSpec): DdlStatement[] {
  assertIdentifier('表名', spec.name);
  assertIdentifier('库名', db);
  if (spec.columns.length === 0) {
    throw new DriverError('E_VALIDATION', '表至少需要一列');
  }
  const cols = spec.columns.map(columnDefSql);
  const pk = spec.columns.filter((c) => c.isPrimaryKey).map((c) => `\`${c.name}\``);
  if (pk.length > 0) {
    cols.push(`PRIMARY KEY (${pk.join(', ')})`);
  }
  appendKeySpecClauses(cols, spec);
  const tail = spec.comment ? ` COMMENT=${escapeText(spec.comment)}` : '';
  return [{ sql: `CREATE TABLE \`${db}\`.\`${spec.name}\` (\n  ${cols.join(',\n  ')}\n)${tail}` }];
}

/** CREATE TABLE 内联键/外键/索引子句（表设计器批次 B）：命名 fail-closed，外键引用列数须与本地一致 */
function appendKeySpecClauses(cols: string[], spec: TableSpec): void {
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
    assertIdentifier('引用表名', fk.refTable);
    cols.push(
      `CONSTRAINT \`${name}\` FOREIGN KEY (${columnListLit(fk.columns)}) REFERENCES \`${fk.refTable}\` (${columnListLit(fk.refColumns)})${foreignKeyActionSuffix(fk)}`,
    );
  }
  for (const idx of spec.indexes ?? []) {
    const name = assertIdentifier('索引名', idx.name ?? generateKeyName('idx', spec.name, taken));
    taken.add(name);
    cols.push(`${idx.unique ? 'UNIQUE INDEX' : 'INDEX'} \`${name}\` (${columnListLit(idx.columns)})`);
  }
}

/** 列定义差异判定：类型/nullable/自增/默认值/注释任一变化即需 MODIFY（类型变化标 destructive） */
function columnDiffers(a: TableSpec['columns'][number], b: TableSpec['columns'][number]): boolean {
  return (
    a.dataType.trim() !== b.dataType.trim() ||
    a.nullable !== b.nullable ||
    Boolean(a.autoIncrement) !== Boolean(b.autoIncrement) ||
    (a.defaultValue ?? '') !== (b.defaultValue ?? '') ||
    (a.comment ?? '') !== (b.comment ?? '')
  );
}

export function buildMockAlterTable(
  db: string,
  obj: string,
  spec: TableSpec,
  current: TableSpec,
): DdlStatement[] {
  assertIdentifier('表名', spec.name);
  assertIdentifier('表名', obj);
  assertIdentifier('库名', db);
  for (const c of spec.columns) {
    assertIdentifier('列名', c.name);
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
  const droppingPkColumn = current.columns.some((c) => c.isPrimaryKey && !tgtByName.has(c.name));
  // 主键变化且没有删主键列时（如给现有列加/减主键），同样需要先 DROP PRIMARY KEY
  if (pkChanged && (droppingPkColumn || curPk.length > 0)) {
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

  // 加列（行数据不丢 → 非 destructive）
  for (const tgt of spec.columns) {
    if (!curByName.has(tgt.name)) {
      statements.push({ sql: `ALTER TABLE ${alterPrefix} ADD COLUMN ${columnDefSql(tgt)}` });
    }
  }

  // 改列（MODIFY 全量定义；类型变化标 destructive——可能截断/丢数据）
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

  // 主键重建（DROP 已在上文；此处补加）
  if (pkChanged && tgtPk.length > 0) {
    statements.push({
      sql: `ALTER TABLE ${alterPrefix} ADD PRIMARY KEY (${tgtPk.map((n) => `\`${n}\``).join(', ')})`,
    });
  }

  // 键/外键/索引 diff（表设计器批次 B，§12.7 红线）：按名对齐——同形状跳过、异形 DROP+ADD，
  // DROP 只由「基线存在且 spec 移除」生成；基线未携带（字段缺省）时只增不删
  const taken = new Set<string>();
  for (const k of [...(current.uniqueKeys ?? []), ...(current.foreignKeys ?? []), ...(current.indexes ?? [])]) {
    if (k.name) {
      taken.add(k.name);
    }
  }
  const alterBase = `ALTER TABLE ${alterPrefix}`;
  const ukDiff = diffKeyEntries(spec.uniqueKeys, current.uniqueKeys);
  for (const k of [...ukDiff.added, ...ukDiff.changed]) {
    const name = assertIdentifier('唯一键名', k.name ?? generateKeyName('uk', spec.name, taken));
    taken.add(name);
    statements.push({ sql: `${alterBase} ADD UNIQUE KEY \`${name}\` (${columnListLit(k.columns)})` });
  }
  for (const k of [...ukDiff.dropped, ...ukDiff.changed]) {
    statements.push({ sql: `${alterBase} DROP KEY \`${assertIdentifier('唯一键名', k.name!)}\`` });
  }
  const idxDiff = diffKeyEntries(spec.indexes, current.indexes);
  for (const k of [...idxDiff.added, ...idxDiff.changed]) {
    const name = assertIdentifier('索引名', k.name ?? generateKeyName('idx', spec.name, taken));
    taken.add(name);
    statements.push({ sql: `${alterBase} ADD ${k.unique ? 'UNIQUE ' : ''}INDEX \`${name}\` (${columnListLit(k.columns)})` });
  }
  for (const k of [...idxDiff.dropped, ...idxDiff.changed]) {
    statements.push({ sql: `${alterBase} DROP INDEX \`${assertIdentifier('索引名', k.name!)}\`` });
  }
  const fkDiff = diffKeyEntries<ForeignKeySpec>(spec.foreignKeys, current.foreignKeys);
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
  for (const k of [...fkDiff.dropped, ...fkDiff.changed]) {
    statements.push({ sql: `${alterBase} DROP FOREIGN KEY \`${assertIdentifier('外键名', k.name!)}\`` });
  }

  // 表注释
  if ((spec.comment ?? '') !== (current.comment ?? '') && spec.comment) {
    statements.push({ sql: `ALTER TABLE ${alterPrefix} COMMENT=${escapeText(spec.comment)}` });
  }

  return statements;
}

// ── 语句解析与内存执行（只认本模块生成的形状）────────────────────────────

export function isMockDdlStatement(text: string): boolean {
  return /^\s*(CREATE TABLE|ALTER TABLE|DROP TABLE)\b/i.test(text);
}

interface ParsedColumnRest {
  dataType: string;
  nullable: boolean;
  autoIncrement?: boolean;
  defaultValue?: string;
  comment?: string;
}

/** 从列定义片段解析属性（列名已剥离；首个 token 为类型，其后为 NOT NULL/DEFAULT/COMMENT/AUTO_INCREMENT） */
function parseColumnRest(rest: string): ParsedColumnRest {
  const tokens = rest.trim();
  const kwMatch = /\s(NOT NULL|NULL|DEFAULT |COMMENT |AUTO_INCREMENT)\b/i.exec(tokens);
  const dataType = (kwMatch ? tokens.slice(0, kwMatch.index) : tokens).trim();
  if (!dataType) {
    throw new DriverError('E_VALIDATION', `无法解析列类型：${tokens}`);
  }
  const parsed: ParsedColumnRest = { dataType, nullable: true };
  let restAfterType = kwMatch ? tokens.slice(kwMatch.index) : '';
  while (restAfterType.length > 0) {
    const m = /^\s*(NOT NULL|NULL|AUTO_INCREMENT|DEFAULT\b|COMMENT\b)\s*/i.exec(restAfterType);
    if (!m) {
      throw new DriverError('E_VALIDATION', `列定义含无法解析的片段：${restAfterType}`);
    }
    const kw = m[1].toUpperCase();
    restAfterType = restAfterType.slice(m[0].length);
    if (kw === 'NOT NULL') {
      parsed.nullable = false;
    } else if (kw === 'AUTO_INCREMENT') {
      parsed.autoIncrement = true;
    } else if (kw === 'DEFAULT') {
      const val = /^'(?:[^']|'')*'/.exec(restAfterType) ?? /^\S+/.exec(restAfterType);
      if (!val) {
        throw new DriverError('E_VALIDATION', 'DEFAULT 缺少值');
      }
      const raw = val[0];
      parsed.defaultValue = raw.startsWith("'") ? raw.slice(1, -1).replace(/''/g, "'") : raw;
      restAfterType = restAfterType.slice(raw.length);
    } else if (kw === 'COMMENT') {
      const val = /^'(?:[^']|'')*'/.exec(restAfterType);
      if (!val) {
        throw new DriverError('E_VALIDATION', 'COMMENT 缺少字符串值');
      }
      parsed.comment = val[0].slice(1, -1).replace(/''/g, "'");
      restAfterType = restAfterType.slice(val[0].length);
    }
  }
  return parsed;
}

/** 顶层逗号切分（括号/单引号字符串感知） */
function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let inStr = false;
  let cur = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      cur += ch;
      if (ch === "'") {
        if (text[i + 1] === "'") {
          cur += "'";
          i++;
        } else {
          inStr = false;
        }
      }
      continue;
    }
    if (ch === "'") {
      inStr = true;
      cur += ch;
    } else if (ch === '(') {
      depth++;
      cur += ch;
    } else if (ch === ')') {
      depth--;
      cur += ch;
    } else if (ch === ',' && depth === 0) {
      parts.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) {
    parts.push(cur);
  }
  return parts;
}

function unquoteIdent(text: string): string {
  const m = /^\s*`([^`]+)`\s*$/.exec(text) ?? /^\s*([A-Za-z0-9_$]+)\s*$/.exec(text);
  if (!m) {
    throw new DriverError('E_VALIDATION', `无法解析标识符：${text}`);
  }
  return m[1];
}

/** 数据类型 → NormalizedType（mock 存储需要；仅覆盖常见前缀，其余 unknown） */
export function inferNormalizedType(dataType: string): NormalizedType {
  const t = dataType.toLowerCase();
  if (/^(bigint|int|integer|smallint|tinyint|mediumint)\b/.test(t)) {
    return 'integer';
  }
  if (/^(decimal|numeric)\b/.test(t)) {
    return 'decimal';
  }
  if (/^(float|double|real)\b/.test(t)) {
    return 'float';
  }
  if (/^(bool|boolean)\b/.test(t)) {
    return 'boolean';
  }
  if (/^(datetime|timestamp)\b/.test(t)) {
    return 'datetime';
  }
  if (/^date\b/.test(t)) {
    return 'date';
  }
  if (/^time\b/.test(t)) {
    return 'time';
  }
  if (/^json\b/.test(t)) {
    return 'json';
  }
  if (/(blob|binary|bytea)/.test(t)) {
    return 'binary';
  }
  if (/^(varchar|char|text|enum|set)/.test(t)) {
    return 'string';
  }
  return 'unknown';
}

/** DDL 执行器对注册表的最小操作面（index.ts 注入；columns/primaryKey/keys/indexes 为活对象可就地变更，
 *  行数据宽度经 appendColumnCells/spliceColumnCells 同步维护） */
export interface MockDdlRegistry {
  databases(): readonly string[];
  getTable(db: string, obj: string): MockTableShape | undefined;
  createTable(db: string, obj: string, def: MockTableShape): void;
  dropTable(db: string, obj: string): void;
  renameTable(db: string, obj: string, newDb: string, newObj: string): void;
  /** ADD COLUMN 后：为所有已物化行补 null 单元（保持行宽 == 列数） */
  appendColumnCells(db: string, obj: string): void;
  /** DROP COLUMN 后：从所有已物化行裁掉该下标单元 */
  spliceColumnCells(db: string, obj: string, index: number): void;
}

/** 注册表表形状（表设计器批次 B 扩展 keys/indexes——listKeys/listIndexes 数据源） */
export interface MockTableShape {
  comment?: string;
  columns: ColumnMeta[];
  primaryKey: string[];
  keys: KeyMeta[];
  indexes: IndexMeta[];
}

function toColumnMeta(name: string, rest: ParsedColumnRest, ordinal: number): ColumnMeta {
  return {
    name,
    dataType: rest.dataType,
    normalizedType: inferNormalizedType(rest.dataType),
    nullable: rest.nullable,
    isPrimaryKey: false,
    autoIncrement: rest.autoIncrement,
    defaultValue: rest.defaultValue,
    comment: rest.comment,
    ordinal,
  };
}

/** 解析外键约束子句（CREATE 内联与 ALTER ADD CONSTRAINT 同形）；
 *  非外键子句返回 undefined */
function parseForeignKeyClause(text: string): KeyMeta | undefined {
  const m =
    /^CONSTRAINT `([^`]+)` FOREIGN KEY \(([\s\S]+)\) REFERENCES `([^`]+)` \(([\s\S]+)\)(?: ON DELETE (RESTRICT|CASCADE|SET NULL|NO ACTION))?(?: ON UPDATE (RESTRICT|CASCADE|SET NULL|NO ACTION))?$/i.exec(
      text.trim(),
    );
  if (!m) {
    return undefined;
  }
  return {
    name: m[1],
    kind: 'FK',
    columns: splitTopLevel(m[2]).map(unquoteIdent),
    refTable: m[3],
    refColumns: splitTopLevel(m[4]).map(unquoteIdent),
    // 动作透传（@since v0.9.0 / D-28）：子句未携带时保持 undefined（内存引擎无默认 NO ACTION 形态）
    ...(m[5] ? { onDelete: m[5] } : {}),
    ...(m[6] ? { onUpdate: m[6] } : {}),
  };
}

/** 键/外键引用目标存在性 fail-closed（对齐 MySQL：引用表/列必须存在）。
 *  self 供建表路径传入在建表（真实引擎允许 CREATE 时自引用——引用列对本表在建列校验） */
function assertKeySpecTargets(
  registry: MockDdlRegistry,
  db: string,
  keys: KeyMeta[],
  self?: { name: string; columns: ColumnMeta[] },
): void {
  for (const k of keys) {
    if (k.kind !== 'FK') {
      continue;
    }
    if (self && k.refTable === self.name) {
      for (const c of k.refColumns ?? []) {
        if (!self.columns.some((x) => x.name === c)) {
          throw new DriverError('E_VALIDATION', `外键 "${k.name}" 引用列 "${k.refTable}.${c}" 不存在`);
        }
      }
      continue;
    }
    const ref = registry.getTable(db, k.refTable!);
    if (!ref) {
      throw new DriverError('E_VALIDATION', `外键 "${k.name}" 引用表 "${k.refTable}" 不存在`);
    }
    for (const c of k.refColumns ?? []) {
      if (!ref.columns.some((x) => x.name === c)) {
        throw new DriverError('E_VALIDATION', `外键 "${k.name}" 引用列 "${k.refTable}.${c}" 不存在`);
      }
    }
  }
}

/** 本表键/索引列存在性 fail-closed */
function assertColumnExist(def: { columns: ColumnMeta[] }, names: readonly string[]): void {
  for (const n of names) {
    if (!def.columns.some((c) => c.name === n)) {
      throw new DriverError('E_VALIDATION', `列 "${n}" 不存在`);
    }
  }
}

/** 执行单条 mock DDL 语句（对注册表就地变更） */
export function executeMockDdlSql(registry: MockDdlRegistry, sql: string): void {
  const text = sql.trim().replace(/;\s*$/, '');

  const drop = /^DROP TABLE (?:IF EXISTS )?`([A-Za-z0-9_$]+)`\.`([A-Za-z0-9_$]+)`$/i.exec(text);
  if (drop) {
    registry.dropTable(drop[1], drop[2]);
    return;
  }

  const create = /^CREATE TABLE `([^`]+)`\.`([^`]+)` \(([\s\S]*)\)(\s+COMMENT='(?:[^']|'')*')?$/i.exec(text);
  if (create) {
    const db = create[1];
    if (!registry.databases().includes(db)) {
      throw new DriverError('E_NOT_FOUND', `库 "${db}" 不存在`);
    }
    const items = splitTopLevel(create[3]);
    const columns: ColumnMeta[] = [];
    const primaryKey: string[] = [];
    const keys: KeyMeta[] = [];
    const indexes: IndexMeta[] = [];
    let tableComment: string | undefined;
    if (create[4]) {
      tableComment = create[4].trim().slice("COMMENT='".length, -1).replace(/''/g, "'");
    }
    for (const item of items) {
      const trimmed = item.trim();
      const pk = /^PRIMARY KEY \(([\s\S]+)\)$/i.exec(trimmed);
      if (pk) {
        for (const part of splitTopLevel(pk[1])) {
          primaryKey.push(unquoteIdent(part));
        }
        continue;
      }
      const uk = /^UNIQUE KEY `([^`]+)` \(([\s\S]+)\)$/i.exec(trimmed);
      if (uk) {
        const cols = splitTopLevel(uk[2]).map(unquoteIdent);
        keys.push({ name: uk[1], kind: 'UNIQUE', columns: cols });
        indexes.push({ name: uk[1], columns: cols, unique: true });
        continue;
      }
      const fk = parseForeignKeyClause(trimmed);
      if (fk) {
        keys.push(fk);
        continue;
      }
      const idx = /^(UNIQUE )?(?:INDEX|KEY) `([^`]+)` \(([\s\S]+)\)$/i.exec(trimmed);
      if (idx) {
        indexes.push({ name: idx[2], columns: splitTopLevel(idx[3]).map(unquoteIdent), unique: Boolean(idx[1]) });
        continue;
      }
      const colMatch = /^`([^`]+)`\s+([\s\S]+)$/.exec(trimmed);
      if (!colMatch) {
        throw new DriverError('E_VALIDATION', `无法解析列定义：${trimmed}`);
      }
      columns.push(toColumnMeta(colMatch[1], parseColumnRest(colMatch[2]), columns.length + 1));
    }
    for (const name of primaryKey) {
      const c = columns.find((x) => x.name === name);
      if (!c) {
        throw new DriverError('E_VALIDATION', `PRIMARY KEY 引用了不存在的列 "${name}"`);
      }
      c.isPrimaryKey = true;
      c.nullable = false;
    }
    if (primaryKey.length > 0) {
      keys.unshift({ name: 'PRIMARY', kind: 'PK', columns: [...primaryKey] });
    }
    assertKeySpecTargets(registry, db, keys, { name: create[2], columns });
    registry.createTable(db, create[2], { comment: tableComment, columns, primaryKey, keys, indexes });
    return;
  }

  const alter = /^ALTER TABLE `([^`]+)`\.`([^`]+)` ([\s\S]+)$/i.exec(text);
  if (alter) {
    const db = alter[1];
    const obj = alter[2];
    if (!registry.databases().includes(db)) {
      throw new DriverError('E_NOT_FOUND', `库 "${db}" 不存在`);
    }
    const def = registry.getTable(db, obj);
    if (!def) {
      throw new DriverError('E_NOT_FOUND', `表 "${db}.${obj}" 不存在`);
    }
    const action = alter[3].trim();

    const rename = /^RENAME TO `([^`]+)`(\.`([^`]+)`)?$/i.exec(action);
    if (rename) {
      registry.renameTable(db, obj, rename[3] ? rename[1] : db, rename[3] ?? rename[1]);
      return;
    }

    const addPk = /^ADD PRIMARY KEY \(([\s\S]+)\)$/i.exec(action);
    if (addPk) {
      const names = splitTopLevel(addPk[1]).map(unquoteIdent);
      for (const c of def.columns) {
        c.isPrimaryKey = names.includes(c.name);
        if (c.isPrimaryKey) {
          c.nullable = false;
        }
      }
      for (const name of names) {
        if (!def.columns.some((x) => x.name === name)) {
          throw new DriverError('E_VALIDATION', `PRIMARY KEY 引用了不存在的列 "${name}"`);
        }
      }
      def.primaryKey = names;
      return;
    }

    if (/^DROP PRIMARY KEY$/i.test(action)) {
      for (const c of def.columns) {
        c.isPrimaryKey = false;
      }
      def.primaryKey = [];
      return;
    }

    const addCol = /^ADD COLUMN `([^`]+)`\s+([\s\S]+)$/i.exec(action);
    if (addCol) {
      def.columns.push(toColumnMeta(addCol[1], parseColumnRest(addCol[2]), def.columns.length + 1));
      registry.appendColumnCells(db, obj);
      return;
    }

    const dropCol = /^DROP COLUMN `([^`]+)`$/i.exec(action);
    if (dropCol) {
      const idx = def.columns.findIndex((c) => c.name === dropCol[1]);
      if (idx < 0) {
        throw new DriverError('E_NOT_FOUND', `列 "${dropCol[1]}" 不存在`);
      }
      def.columns.splice(idx, 1);
      def.columns.forEach((c, i) => {
        c.ordinal = i + 1;
      });
      def.primaryKey = def.primaryKey.filter((n) => n !== dropCol[1]);
      // 含该列的键/索引随删（对齐 MySQL）；外键本地列被删同样移除——原地收缩（理由同 DROP KEY）
      const keepKeys = def.keys.filter((k) => !k.columns.includes(dropCol[1]));
      def.keys.splice(0, def.keys.length, ...keepKeys);
      const keepIndexes = def.indexes.filter((i) => !i.columns.includes(dropCol[1]));
      def.indexes.splice(0, def.indexes.length, ...keepIndexes);
      registry.spliceColumnCells(db, obj, idx);
      return;
    }

    const modify = /^MODIFY COLUMN `([^`]+)`\s+([\s\S]+)$/i.exec(action);
    if (modify) {
      const col = def.columns.find((c) => c.name === modify[1]);
      if (!col) {
        throw new DriverError('E_NOT_FOUND', `列 "${modify[1]}" 不存在`);
      }
      Object.assign(col, toColumnMeta(col.name, parseColumnRest(modify[2]), col.ordinal));
      return;
    }

    const addUk = /^ADD UNIQUE KEY `([^`]+)` \(([\s\S]+)\)$/i.exec(action);
    if (addUk) {
      const cols = splitTopLevel(addUk[2]).map(unquoteIdent);
      assertColumnExist(def, cols);
      def.keys.push({ name: addUk[1], kind: 'UNIQUE', columns: cols });
      def.indexes.push({ name: addUk[1], columns: cols, unique: true });
      return;
    }

    const addFkClause = /^ADD CONSTRAINT /i.test(action) ? parseForeignKeyClause(action.replace(/^ADD /i, '')) : undefined;
    if (addFkClause) {
      assertKeySpecTargets(registry, db, [addFkClause]);
      assertColumnExist(def, addFkClause.columns);
      def.keys.push(addFkClause);
      return;
    }

    const addIdx = /^ADD (UNIQUE )?INDEX `([^`]+)` \(([\s\S]+)\)$/i.exec(action);
    if (addIdx) {
      const cols = splitTopLevel(addIdx[3]).map(unquoteIdent);
      assertColumnExist(def, cols);
      def.indexes.push({ name: addIdx[2], columns: cols, unique: Boolean(addIdx[1]) });
      return;
    }

    const dropKey = /^DROP KEY `([^`]+)`$/i.exec(action);
    if (dropKey) {
      // 原地收缩——getTable 返回的是重建形状，重新赋值不会写回注册表
      const keepKeys = def.keys.filter((k) => !(k.kind === 'UNIQUE' && k.name === dropKey[1]));
      def.keys.splice(0, def.keys.length, ...keepKeys);
      const keepIdx = def.indexes.filter((i) => i.name !== dropKey[1]);
      def.indexes.splice(0, def.indexes.length, ...keepIdx);
      return;
    }

    const dropFk = /^DROP FOREIGN KEY `([^`]+)`$/i.exec(action);
    if (dropFk) {
      const keepKeys = def.keys.filter((k) => !(k.kind === 'FK' && k.name === dropFk[1]));
      def.keys.splice(0, def.keys.length, ...keepKeys);
      return;
    }

    const dropIdx = /^DROP INDEX `([^`]+)`$/i.exec(action);
    if (dropIdx) {
      const keepIdx = def.indexes.filter((i) => i.name !== dropIdx[1]);
      def.indexes.splice(0, def.indexes.length, ...keepIdx);
      return;
    }

    const comment = /^COMMENT='((?:[^']|'')*)'$/i.exec(action);
    if (comment) {
      def.comment = comment[1].replace(/''/g, "'");
      return;
    }

    throw new DriverError('E_VALIDATION', `mock 驱动不支持的 ALTER 动作：${action}`);
  }

  throw new DriverError('E_VALIDATION', `mock 驱动无法识别的 DDL 语句：${text.slice(0, 120)}`);
}
