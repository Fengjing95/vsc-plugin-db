import { DriverError, type ColumnMeta, type DdlStatement, type NormalizedType, type TableSpec } from '@db-explorer/core';

/**
 * mock 驱动的表结构编辑（M8-B2，概要 §5.9 / 驱动规范 §3 @since v0.1.2）：
 * - builder 生成 MySQL 方言 DDL（与 driver-mysql 同一套纪律：标识符 fail-closed 校验、
 *   字面量转义、destructive 标记）——DDL 不可参数化（驱动规范 §10）
 * - executor 只解析本模块生成的语句形状（CREATE/ALTER/DROP TABLE），经注入的注册表句柄
 *   对 tableDefs/store 就地变更（P-18 共享物化存储语义）；query() 经 isMockDdlStatement 路由
 * 纯函数 + 显式注册表句柄注入，有单测。
 */

/** 标识符字符合法性（fail-closed，不依赖转义兜底）：引号/分号/注释符等直接拒绝 */
const IDENT_RE = /^[A-Za-z0-9_$]+$/;

function assertIdentifier(kind: string, name: string): string {
  if (!IDENT_RE.test(name) || name.length > 128) {
    throw new DriverError('E_VALIDATION', `${kind} "${name}" 含非法字符（字母/数字/_/$ 之外不允许）`);
  }
  return name;
}

/** 字面量转义：数值与 CURRENT_TIMESTAMP 原样；其余按字符串字面量单引号包裹；控制字符拒绝 */
export function escapeDdlLiteral(value: string): string {
  if (/^-?\d+(\.\d+)?$/.test(value) || /^CURRENT_TIMESTAMP$/i.test(value.trim())) {
    return value.trim();
  }
  if (/[\r\n\x00]/.test(value)) {
    throw new DriverError('E_VALIDATION', '默认值/注释不允许包含换行或控制字符');
  }
  return `'${value.replace(/'/g, "''")}'`;
}

/** 注释/字符串文本转义（包裹单引号，内部 ' 翻倍；控制字符 fail-closed） */
function escapeText(value: string): string {
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
  const tail = spec.comment ? ` COMMENT=${escapeText(spec.comment)}` : '';
  return [{ sql: `CREATE TABLE \`${db}\`.\`${spec.name}\` (\n  ${cols.join(',\n  ')}\n)${tail}` }];
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

/** DDL 执行器对注册表的最小操作面（index.ts 注入；columns/primaryKey 为活对象可就地变更，
 *  行数据宽度经 appendColumnCells/spliceColumnCells 同步维护） */
export interface MockDdlRegistry {
  databases(): readonly string[];
  getTable(db: string, obj: string): { comment?: string; columns: ColumnMeta[]; primaryKey: string[] } | undefined;
  createTable(db: string, obj: string, def: { comment?: string; columns: ColumnMeta[]; primaryKey: string[] }): void;
  dropTable(db: string, obj: string): void;
  renameTable(db: string, obj: string, newDb: string, newObj: string): void;
  /** ADD COLUMN 后：为所有已物化行补 null 单元（保持行宽 == 列数） */
  appendColumnCells(db: string, obj: string): void;
  /** DROP COLUMN 后：从所有已物化行裁掉该下标单元 */
  spliceColumnCells(db: string, obj: string, index: number): void;
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
    registry.createTable(db, create[2], { comment: tableComment, columns, primaryKey });
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

    const comment = /^COMMENT='((?:[^']|'')*)'$/i.exec(action);
    if (comment) {
      def.comment = comment[1].replace(/''/g, "'");
      return;
    }

    throw new DriverError('E_VALIDATION', `mock 驱动不支持的 ALTER 动作：${action}`);
  }

  throw new DriverError('E_VALIDATION', `mock 驱动无法识别的 DDL 语句：${text.slice(0, 120)}`);
}
