/**
 * 复制为多种格式（概要设计 §6 #6 P1）：选中行 × 可见列 → IN 列表 / JSON / Markdown / TS 类型 / INSERT。
 * 纯函数层（webview 内联生成：选区 ≤ 单页 5000 行，C-13 的"重活"边界内）。
 * 值语义遵循值编码契约（概要 §4.4）：null = NULL、DECIMAL 已是字符串、json 已解析对象。
 */

export type CopyFormat = 'inList' | 'json' | 'markdown' | 'tsType' | 'insert';

export interface CopyColumn {
  name: string;
  type: string; // NormalizedType（ResultSet.columns 原样字符串）
}

/** SQL 字面量（IN 列表 / INSERT 共用；NULL 严格区分空串，C-7） */
export function toSqlLiteral(v: unknown): string {
  if (v === null || v === undefined) {
    return 'NULL';
  }
  if (typeof v === 'number' && Number.isFinite(v)) {
    return String(v);
  }
  if (typeof v === 'boolean') {
    return v ? 'TRUE' : 'FALSE';
  }
  return `'${String(v).replace(/'/g, "''")}'`;
}

/** IN 列表：选中行某列的值 → ('a','b',NULL)。IN 查询高频复用（§6 #6） */
export function rowsToInList(values: unknown[]): string {
  return `(${values.map(toSqlLiteral).join(', ')})`;
}

/** JSON 数组（对象数组，列名 → 值；json 类型列已是解析对象，原样保留） */
export function rowsToJson(columns: string[], rows: unknown[][]): string {
  return JSON.stringify(
    rows.map((row) => {
      const obj: Record<string, unknown> = {};
      columns.forEach((name, i) => {
        obj[name] = row[i] ?? null;
      });
      return obj;
    }),
    null,
    2,
  );
}

/** Markdown 表格：管道转义，NULL 显式标注（复制到文档/IM 可读） */
export function rowsToMarkdown(columns: string[], rows: unknown[][]): string {
  const esc = (v: unknown): string =>
    v === null || v === undefined ? 'NULL' : String(v).replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const head = `| ${columns.map(esc).join(' | ')} |`;
  const sep = `| ${columns.map(() => '---').join(' | ')} |`;
  const body = rows.map((row) => `| ${row.map((v) => esc(v)).join(' | ')} |`).join('\n');
  return body ? `${head}\n${sep}\n${body}` : `${head}\n${sep}`;
}

/** NormalizedType → TS 类型（DECIMAL=string 与值编码契约一致，注释标注精度语义） */
export function tsTypeOf(t: string): string {
  switch (t) {
    case 'integer':
    case 'float':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'json':
      return 'unknown';
    default:
      // string / decimal（C-7：超限整数与 DECIMAL 传字符串）/ date/time/datetime / binary(base64) / uuid / unknown
      return 'string';
  }
}

/** TS 类型定义（§6 #6/#7 的行内版：interface from 结果列类型） */
export function rowsToTsType(tableName: string, columns: CopyColumn[]): string {
  const lines = columns.map((c) => `  /** ${c.type} */\n  ${safeIdent(c.name)}: ${tsTypeOf(c.type)};`);
  return `interface ${pascalIdent(tableName)} {\n${lines.join('\n')}\n}`;
}

/** INSERT 语句（多行单语句；标识符用反引号——MySQL 口径，跨库复制场景以 MySQL 为默认方言） */
export function rowsToInsert(tableName: string, columns: string[], rows: unknown[][]): string {
  if (rows.length === 0) {
    return '';
  }
  const cols = columns.map((c) => `\`${c.replace(/`/g, '``')}\``).join(', ');
  const values = rows.map((row) => `  (${row.map((v) => toSqlLiteral(v)).join(', ')})`).join(',\n');
  return `INSERT INTO \`${tableName.replace(/`/g, '``')}\` (${cols}) VALUES\n${values};`;
}

/** 列名 → 安全 TS 标识符（Unicode 字母/数字保留——TS 标识符允许；其余替换下划线，首字符数字加前缀） */
function safeIdent(name: string): string {
  const ident = name.replace(/[^\p{L}\p{N}_$]/gu, '_');
  return /^[0-9]/.test(ident) ? `_${ident}` : ident || '_col';
}

/** 表名 → Pascal 风格 interface 名（中文等 Unicode 保留） */
function pascalIdent(name: string): string {
  const ident = name.replace(/[^\p{L}\p{N}_$]/gu, '_');
  return /^[0-9]/.test(ident) ? `T_${ident}` : ident || 'Row';
}
