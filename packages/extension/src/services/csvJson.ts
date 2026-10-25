/**
 * 导出序列化纯函数（概要设计 5.7）。零 vscode 依赖，便于单测。
 * CSV 遵循 RFC 4180：字段含逗号/引号/换行时加引号，内部引号翻倍。
 */

/** RFC 4180 字段转义；值编码契约（概要设计 4.4）：NULL → 空串，JSON → 原文，二进制 → base64 原样 */
export function csvEscapeField(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  let s: string;
  if (typeof value === 'object') {
    s = JSON.stringify(value);
  } else {
    s = String(value);
  }
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export function csvRow(fields: unknown[]): string {
  return fields.map(csvEscapeField).join(',') + '\r\n';
}

/** 行式数组 → 对象（JSON 导出格式：列名 → 值） */
export function toJsonObject(columns: string[], row: unknown[]): Record<string, unknown> {
  const obj: Record<string, unknown> = {};
  columns.forEach((name, i) => {
    obj[name] = row[i] ?? null;
  });
  return obj;
}

/**
 * SQL 字面量（INSERT 导出值；MySQL 方言，与 webview copyFormats 同口径）。
 * NULL 严格区分空串（C-7）；JSON 对象 → JSON 文本字面量——对象经 String() 会落
 * '[object Object]'（mysql2/sqlstring 同款坑，P-53），必须 stringify 后再引号转义。
 */
export function sqlLiteral(v: unknown): string {
  if (v === null || v === undefined) {
    return 'NULL';
  }
  if (typeof v === 'number' && Number.isFinite(v)) {
    return String(v);
  }
  if (typeof v === 'boolean') {
    return v ? 'TRUE' : 'FALSE';
  }
  const text = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return `'${text.replace(/'/g, "''")}'`;
}

/** NDJSON 行（每行一个独立 JSON 对象 + LF；无头无尾，任意前缀均合法，取消天然安全） */
export function ndjsonRow(columns: string[], row: unknown[]): string {
  return JSON.stringify(toJsonObject(columns, row)) + '\n';
}

/** Markdown 单元格：NULL 显式标注；JSON 对象序列化原文；管道/换行转义 */
function mdEscape(v: unknown): string {
  if (v === null || v === undefined) {
    return 'NULL';
  }
  const text = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return text.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

/** Markdown 表头 + 分隔行（首个批量写一次） */
export function markdownHeader(columns: string[]): string {
  return `| ${columns.map(mdEscape).join(' | ')} |\n| ${columns.map(() => '---').join(' | ')} |\n`;
}

export function markdownRow(row: unknown[]): string {
  return `| ${row.map(mdEscape).join(' | ')} |\n`;
}

const backtick = (ident: string): string => `\`${ident.replace(/`/g, '``')}\``;

/**
 * SQL INSERT 导出（MySQL 方言，同 webview「复制为 INSERT」口径）：限定 `db`.`obj`，
 * 标识符反引号翻倍转义；每批一条完整多值语句（行数受 chunkRows 约束，
 * 规避 max_allowed_packet），空批返回空串不写语句头。
 */
export function insertStatement(db: string, obj: string, columns: string[], rows: unknown[][]): string {
  if (rows.length === 0) {
    return '';
  }
  const cols = columns.map(backtick).join(', ');
  const values = rows.map((row) => `  (${row.map(sqlLiteral).join(', ')})`).join(',\n');
  return `INSERT INTO ${backtick(db)}.${backtick(obj)} (${cols}) VALUES\n${values};\n`;
}

/** 导出文件名清理：非法字符替换为下划线 */
export function safeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '_');
}
