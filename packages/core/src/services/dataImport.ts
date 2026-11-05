/**
 * 数据导入纯函数层（概要设计 §5.13 / ADR D-32）。零 vscode / 零 node 依赖，便于单测。
 *
 * 管线：文件文本 → 解析（CSV / JSON 数组 / NDJSON；XLSX 读侧在 extension 经 exceljs
 * 转为同形 records）→ 列映射建议 → 按列 normalizedType 转换（错行收集，不写入）。
 * 写入侧由 extension 分批构造 inserts-only ChangeSet 调 driver.applyChanges（P-53 红线：
 * 禁止导入管线自拼 SQL）。
 *
 * 值编码契约（概要 §4.4 / C-7）：NULL=null 与 ''=空串严格区分；decimal=字符串透传；
 * json=已解析对象；CSV 表达力限制——空字段默认按 NULL 解释（与导出「NULL→空串」互逆，
 * 往返一致），开关 emptyAsNull=false 时空=空串；JSON/NDJSON 的 null 恒为 NULL。
 */

import type { NormalizedType } from '../model/meta';

/** 单次导入行数上限（ADR D-32 定值）：解析期计数超限 → E_VALIDATION 提示分文件 */
export const MAX_IMPORT_ROWS = 50_000;

/** 映射建议 / 错行报告可回传的采样上限（全量计数另算，样本防载荷爆炸） */
export const IMPORT_ERROR_SAMPLE_LIMIT = 20;
export const IMPORT_PREVIEW_ROWS = 10;

export type ImportFileFormat = 'csv' | 'json' | 'ndjson' | 'xlsx';

export interface ImportRowError {
  /** 1-based 数据行号（表头行不计；NDJSON = 行号） */
  row: number;
  message: string;
}

/** 行数超限（结构化错误码，Host 转 DriverError） */
export class ImportRowCountError extends Error {
  readonly code = 'E_VALIDATION' as const;
  constructor(
    public readonly limit: number,
    public readonly count: number,
  ) {
    super(`导入行数 ${count} 超过单次上限 ${limit}，请分文件导入`);
    this.name = 'ImportRowCountError';
  }
}

/** CSV 结构错误（未闭合引号等，无法可靠续解析） */
export class CsvStructuralError extends Error {
  constructor(
    message: string,
    public readonly row: number,
  ) {
    super(message);
    this.name = 'CsvStructuralError';
  }
}

export function stripBom(text: string): string {
  return text.startsWith('\uFEFF') ? text.slice(1) : text;
}

/** 分隔符嗅探：样本内统计三种候选出现次数（引号外），最多者胜出；并列/无命中回落逗号 */
export function sniffDelimiter(sample: string): ',' | ';' | '\t' {
  const head = stripBom(sample).slice(0, 4096);
  const count = (ch: string): number => {
    let n = 0;
    let inQuotes = false;
    for (let i = 0; i < head.length; i++) {
      const c = head[i];
      if (c === '"') {
        inQuotes = !inQuotes;
      } else if (c === ch && !inQuotes) {
        n++;
      }
    }
    return n;
  };
  const comma = count(',');
  const semicolon = count(';');
  const tab = count('\t');
  const max = Math.max(comma, semicolon, tab);
  if (max === 0) {
    return ',';
  }
  if (max === tab) {
    return '\t';
  }
  return max === semicolon ? ';' : ',';
}

/**
 * RFC 4180 CSV 解析：引号字段支持逗号/引号（双写转义）/换行；CRLF 与 LF 行尾；
 * BOM 剥离；尾部换行不产生空行，中间整行空行跳过；短行以空串补齐。
 * 未闭合引号抛 CsvStructuralError（携带行号）——结构破坏后续字段不可靠，整体拒绝。
 */
export function parseCsv(text: string, delimiter?: string): string[][] {
  const delim = delimiter ?? sniffDelimiter(text.slice(0, 4096));
  const src = stripBom(text);
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;
  let fieldQuoted = false;
  let line = 1;
  let rowLine = 1;
  let anyField = false;

  const endField = (): void => {
    row.push(field);
    field = '';
    fieldQuoted = false;
    anyField = true;
  };
  const endRow = (): void => {
    if (!anyField && row.length === 0 && field === '') {
      return; // 整行空行（含尾换行）不产生记录
    }
    endField();
    rows.push(row);
    row = [];
    anyField = false;
  };

  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        if (c === '\n') {
          line++;
        }
        field += c;
      }
      continue;
    }
    if (c === '"' && field === '' && !fieldQuoted) {
      inQuotes = true;
      fieldQuoted = true;
      continue;
    }
    if (c === delim) {
      endField();
      continue;
    }
    if (c === '\r') {
      if (src[i + 1] === '\n') {
        i++;
      }
      endRow();
      line++;
      rowLine = line;
      continue;
    }
    if (c === '\n') {
      endRow();
      line++;
      rowLine = line;
      continue;
    }
    field += c;
  }
  if (inQuotes) {
    // 报告行所在行号（field 起始行），不是流末尾行号
    throw new CsvStructuralError('CSV 引号字段未闭合', rowLine);
  }
  if (field !== '' || row.length > 0) {
    endRow();
  }
  // 短行按最大宽度补齐空串（缺列单元格 → 转换层按空字段语义解释）
  const width = rows.reduce((w, r) => Math.max(w, r.length), 0);
  for (const r of rows) {
    while (r.length < width) {
      r.push('');
    }
  }
  return rows;
}

export interface JsonParseResult {
  format: 'json' | 'ndjson';
  records: Array<Record<string, unknown>>;
  rowErrors: ImportRowError[];
}

/**
 * JSON 记录解析（双形态自动识别）：首字符 `[` = 数组整体 JSON.parse（非法整体拒绝）；
 * 否则按 NDJSON 逐行解析（坏行进错行报告不中断）。数组元素/行必须为对象。
 * row 编号：数组 = 元素序（1-based）；NDJSON = 物理行号（坏行报告可定位到行）。
 */
export function parseJsonRecords(text: string): JsonParseResult {
  const src = stripBom(text).trim();
  if (src.startsWith('[')) {
    let arr: unknown;
    try {
      arr = JSON.parse(src);
    } catch {
      throw new Error('JSON 数组解析失败：文件不是合法 JSON');
    }
    if (!Array.isArray(arr)) {
      throw new Error('JSON 文件顶层必须是数组');
    }
    const records: Array<Record<string, unknown>> = [];
    const rowErrors: ImportRowError[] = [];
    arr.forEach((item, i) => {
      if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
        records.push(item as Record<string, unknown>);
      } else {
        rowErrors.push({ row: i + 1, message: `数组元素 ${i + 1} 不是对象` });
      }
    });
    return { format: 'json', records, rowErrors };
  }
  const records: Array<Record<string, unknown>> = [];
  const rowErrors: ImportRowError[] = [];
  const lines = src.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].trim();
    if (raw === '') {
      continue;
    }
    let item: unknown;
    try {
      item = JSON.parse(raw);
    } catch {
      rowErrors.push({ row: i + 1, message: '行不是合法 JSON' });
      continue;
    }
    if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
      records.push(item as Record<string, unknown>);
    } else {
      rowErrors.push({ row: i + 1, message: '行内容不是 JSON 对象' });
    }
  }
  return { format: 'ndjson', records, rowErrors };
}

/** 格式判定：扩展名优先（xlsx/xlsx 必须经 exceljs），未知扩展名按内容嗅探 */
export function detectImportFormat(fileName: string, contentHead: string): ImportFileFormat {
  const ext = fileName.toLowerCase().split('.').pop() ?? '';
  if (ext === 'csv') {
    return 'csv';
  }
  if (ext === 'xlsx') {
    return 'xlsx';
  }
  if (ext === 'json') {
    return 'json';
  }
  if (ext === 'ndjson') {
    return 'ndjson';
  }
  const head = stripBom(contentHead).trimStart();
  if (head.startsWith('[')) {
    return 'json';
  }
  const firstLine = head.split('\n')[0]?.trim() ?? '';
  if (firstLine.startsWith('{')) {
    return 'ndjson';
  }
  return 'csv';
}

/** 列映射：文件列 → 表列（null = 忽略该文件列）；type 为目标列 normalizedType（Host 填充） */
export interface ColumnMapping {
  fileColumn: string;
  tableColumn: string | null;
  type: NormalizedType;
}

export interface ImportTableColumn {
  name: string;
  type: NormalizedType;
  isPrimaryKey: boolean;
  autoIncrement: boolean;
  nullable: boolean;
}

/**
 * 映射建议：按名精确对齐优先，其次大小写不敏感兜底；autoIncrement 列不参与映射
 * （驱动生成主键，导入值会被拒绝）；未对齐文件列 = 忽略（null）。
 */
export function suggestMapping(fileColumns: string[], tableColumns: ImportTableColumn[]): ColumnMapping[] {
  const candidates = tableColumns.filter((c) => !c.autoIncrement);
  const used = new Set<string>();
  const mappings: ColumnMapping[] = [];
  for (const fileColumn of fileColumns) {
    const exact = candidates.find((c) => c.name === fileColumn && !used.has(c.name));
    const loose = exact ?? candidates.find((c) => !used.has(c.name) && c.name.toLowerCase() === fileColumn.toLowerCase());
    if (loose) {
      used.add(loose.name);
      mappings.push({ fileColumn, tableColumn: loose.name, type: loose.type });
    } else {
      mappings.push({ fileColumn, tableColumn: null, type: 'unknown' });
    }
  }
  return mappings;
}

export interface ConvertOptions {
  /** true（默认）= 空字段写 NULL；false = 空字段按空串写入（仅 string 列可承载空串） */
  emptyAsNull: boolean;
}

export type ConvertResult = { ok: true; value: unknown } | { ok: false; reason: string };

const pad = (n: number, w = 2): string => String(n).padStart(w, '0');

/** xlsx Date 单元格 → C-7 形态文本（本地时区组件；精度按目标列类型） */
function dateToText(d: Date, type: NormalizedType): string {
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  if (type === 'date') {
    return date;
  }
  if (type === 'time') {
    return time;
  }
  return `${date} ${time}.${pad(d.getMilliseconds(), 3)}`;
}

/**
 * 单元格类型转换（CSV 全字符串 → 按 normalizedType；JSON 值自带类型）。
 * null/undefined 恒为 NULL；'' 按 emptyAsNull 语义；数字/布尔严格解析（失败拒绝 → 错行）；
 * date/time/datetime 文本透传（库校验兜底）；json 列尝试解析（失败拒绝）；
 * decimal 字符串透传（C-7）；binary 期望 base64 字符串；unknown 原样。
 */
export function convertCell(raw: unknown, type: NormalizedType, opts: ConvertOptions): ConvertResult {
  if (raw === null || raw === undefined) {
    return { ok: true, value: null };
  }
  if (typeof raw === 'string' && raw === '') {
    if (opts.emptyAsNull) {
      return { ok: true, value: null };
    }
    if (type === 'string' || type === 'unknown' || type === 'binary' || type === 'uuid') {
      return { ok: true, value: '' };
    }
    return { ok: false, reason: `空串不能写入 ${type} 列（可开启「空 = NULL」）` };
  }
  if (raw instanceof Date) {
    if (type === 'date' || type === 'time' || type === 'datetime') {
      return { ok: true, value: dateToText(raw, type) };
    }
    return { ok: false, reason: `日期单元格需要 ${type} 以外的处理，列类型不符` };
  }

  // 以下按「字符串 / 数字 / 布尔 / 其它」显式收窄（unknown 经 typeof else 分支会落 {}，不可直接调用方法）
  switch (type) {
    case 'string':
    case 'uuid': {
      if (typeof raw === 'object') {
        return { ok: true, value: JSON.stringify(raw) };
      }
      return { ok: true, value: String(raw) };
    }
    case 'integer': {
      if (typeof raw === 'boolean') {
        return { ok: true, value: raw ? 1 : 0 };
      }
      if (typeof raw === 'number') {
        if (!Number.isInteger(raw)) {
          return { ok: false, reason: `"${String(raw)}" 不是整数` };
        }
        return { ok: true, value: raw };
      }
      if (typeof raw === 'string') {
        const n = Number(raw.trim());
        if (!Number.isInteger(n)) {
          return { ok: false, reason: `"${raw}" 不是整数` };
        }
        return { ok: true, value: n };
      }
      return { ok: false, reason: `"${String(raw)}" 不是整数` };
    }
    case 'decimal': {
      // C-7：decimal 以字符串承载（超限精度不失真）；数字转文本，非数字串拒绝
      const text = typeof raw === 'number' ? String(raw) : typeof raw === 'string' ? raw.trim() : '';
      if (text === '' || Number.isNaN(Number(text))) {
        return { ok: false, reason: `"${String(raw)}" 不是数值` };
      }
      return { ok: true, value: text };
    }
    case 'float': {
      if (typeof raw === 'number') {
        return { ok: true, value: raw };
      }
      if (typeof raw === 'string') {
        const n = Number(raw.trim());
        if (Number.isNaN(n)) {
          return { ok: false, reason: `"${raw}" 不是数值` };
        }
        return { ok: true, value: n };
      }
      return { ok: false, reason: `"${String(raw)}" 不是数值` };
    }
    case 'boolean': {
      if (typeof raw === 'boolean') {
        return { ok: true, value: raw };
      }
      const text = String(raw).trim().toLowerCase();
      if (text === 'true' || text === '1') {
        return { ok: true, value: true };
      }
      if (text === 'false' || text === '0') {
        return { ok: true, value: false };
      }
      return { ok: false, reason: `"${String(raw)}" 不是布尔值` };
    }
    case 'date':
    case 'time':
    case 'datetime': {
      if (typeof raw === 'string') {
        return { ok: true, value: raw.trim() };
      }
      return { ok: false, reason: `"${String(raw)}" 不是时间文本` };
    }
    case 'json': {
      if (typeof raw === 'object') {
        return { ok: true, value: raw }; // 已解析对象/数组，C-7 同形透传
      }
      if (typeof raw === 'number' || typeof raw === 'boolean') {
        return { ok: true, value: raw }; // JSON 列可承载标量
      }
      if (typeof raw === 'string') {
        try {
          return { ok: true, value: JSON.parse(raw) };
        } catch {
          return { ok: false, reason: `"${raw}" 不是合法 JSON` };
        }
      }
      return { ok: false, reason: `"${String(raw)}" 不是合法 JSON` };
    }
    case 'binary': {
      if (typeof raw === 'string') {
        return { ok: true, value: raw }; // base64 原样（C-7）
      }
      return { ok: false, reason: '二进制列期望 base64 文本' };
    }
    case 'unknown':
    default:
      return { ok: true, value: raw };
  }
}

export type RecordConvertResult =
  | { ok: true; values: Record<string, unknown> }
  | { ok: false; reason: string };

/** 整行转换：按映射逐列转换，忽略列跳过；首个失败列即拒绝（reason 含列名） */
export function convertRecord(
  cells: Record<string, unknown>,
  mapping: ColumnMapping[],
  opts: ConvertOptions,
): RecordConvertResult {
  const values: Record<string, unknown> = {};
  for (const m of mapping) {
    if (m.tableColumn === null) {
      continue;
    }
    const r = convertCell(cells[m.fileColumn], m.type, opts);
    if (!r.ok) {
      return { ok: false, reason: `列 ${m.tableColumn}：${r.reason}` };
    }
    values[m.tableColumn] = r.value;
  }
  return { ok: true, values };
}

/** 批次切分（500 行/批 = 单事务/批，ADR D-32） */
export function planBatches<T>(items: T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    batches.push(items.slice(i, i + size));
  }
  return batches;
}

/**
 * 表头归一：空表头/纯空白 → `col<序>` 兜底（fileColumn 是映射键，协议要求非空）；
 * 重名追加 `.2`/`.3` 后缀防键碰撞（映射建议按名匹配，重名本就无法区分）。
 */
export function normalizeHeaders(headers: string[]): string[] {
  const seen = new Map<string, number>();
  return headers.map((h, i) => {
    const base = h.trim() === '' ? `col${i + 1}` : h.trim();
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return n === 0 ? base : `${base}.${n + 1}`;
  });
}
