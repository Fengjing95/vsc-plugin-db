import { Binary, Code, Decimal128, Long, ObjectId } from 'mongodb';
import { DriverError, type ColumnMeta, type NormalizedType } from '@db-explorer/core';

/**
 * BSON ↔ §5 值编码契约（驱动规范 §5.5 映射表）与动态列采样推断。
 * 编码方向（读出）：BSON 原生值 → §5 JSON 安全形态；
 * 嵌套文档/数组按 C-7 传已解析对象（内嵌 BSON 类型深度转换）。
 */

const MAX_SAFE = Number.MAX_SAFE_INTEGER;

export function formatDateTimeUtc(d: Date): string {
  const p = (n: number, w = 2): string => String(n).padStart(w, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}.${p(d.getUTCMilliseconds(), 3)}`;
}

const DATETIME_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?)?$/;

/** C-7 datetime 文本 → Date（按 UTC 解析，不受本机时区影响）；越界字段 → E_VALIDATION */
export function parseDateTimeUtc(text: string): Date {
  const m = DATETIME_RE.exec(text.trim());
  if (!m) {
    throw new DriverError('E_VALIDATION', `无法解析日期时间："${text}"（期望 YYYY-MM-DD HH:mm:ss.SSS）`);
  }
  const [, y, mo, d, h = '0', mi = '0', s = '0', ms = '0'] = m;
  const date = new Date(
    Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s), Number(ms.padEnd(3, '0'))),
  );
  // Date 对越界字段静默进位（如 2024-13-01）——回验年月日
  if (
    date.getUTCFullYear() !== Number(y) ||
    date.getUTCMonth() !== Number(mo) - 1 ||
    date.getUTCDate() !== Number(d)
  ) {
    throw new DriverError('E_VALIDATION', `日期时间字段越界："${text}"`);
  }
  return date;
}

/** BSON 原生值 → §5 编码形态 */
export function encodeValue(v: unknown): unknown {
  if (v === null || v === undefined) {
    return null;
  }
  switch (typeof v) {
    case 'string':
    case 'boolean':
      return v;
    case 'number':
      return Number.isFinite(v) ? v : String(v); // NaN/Infinity 非 JSON 安全 → 字符串
    case 'bigint':
      return v <= BigInt(MAX_SAFE) && v >= -BigInt(MAX_SAFE) ? Number(v) : String(v);
    case 'object':
      break;
    default:
      return String(v); // symbol 等
  }
  if (v instanceof Date) {
    return formatDateTimeUtc(v);
  }
  if (v instanceof ObjectId) {
    return v.toHexString();
  }
  if (v instanceof Decimal128) {
    return v.toString();
  }
  if (v instanceof Long) {
    return v.greaterThanOrEqual(Long.fromNumber(-MAX_SAFE)) && v.lessThanOrEqual(Long.fromNumber(MAX_SAFE))
      ? v.toNumber()
      : v.toString();
  }
  if (v instanceof Binary) {
    return Buffer.from(v.buffer.subarray(0, v.length())).toString('base64');
  }
  if (v instanceof Code) {
    return v.code;
  }
  if (Array.isArray(v)) {
    return v.map(encodeValue);
  }
  const ctor = (v as object).constructor;
  if (ctor === Object || ctor === undefined || ctor === null) {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[k] = encodeValue(val);
    }
    return out;
  }
  return String(v); // Timestamp / RegExp / MinKey / MaxKey / Symbol 等字符串化
}

/** 采样列类型标注（dataType 承载 BSON 原生类型名） */
export function bsonDataTypeOf(v: unknown): string {
  if (v === null || v === undefined) {
    return 'null';
  }
  if (v instanceof ObjectId) return 'objectId';
  if (v instanceof Date) return 'date';
  if (v instanceof Decimal128) return 'decimal';
  if (v instanceof Long) return 'long';
  if (v instanceof Binary) return 'binary';
  switch (typeof v) {
    case 'string': return 'string';
    case 'boolean': return 'boolean';
    case 'number': return Number.isInteger(v) ? 'int' : 'double';
    default: break;
  }
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'object') return 'object';
  return 'unknown';
}

export function normalizedOf(dataType: string): NormalizedType {
  switch (dataType) {
    case 'objectId':
    case 'string':
      return 'string';
    case 'int':
    case 'long':
      return 'integer';
    case 'double':
      return 'float';
    case 'decimal':
      return 'decimal';
    case 'boolean':
      return 'boolean';
    case 'date':
      return 'datetime';
    case 'object':
    case 'array':
      return 'json';
    case 'binary':
      return 'binary';
    default:
      return 'unknown';
  }
}

/**
 * 动态列（D-17）：采样推断顶层字段并集——_id 恒为首列（ordinal 1），其余按首见序；
 * 列类型取首个非 null 样本，全 null 列 → unknown；缺失字段按 NULL 语义（单元格编码 null）。
 */
export function columnsFromDocs(docs: Array<Record<string, unknown>>): ColumnMeta[] {
  const order: string[] = [];
  const typeOf = new Map<string, { dataType: string; normalizedType: NormalizedType }>();
  const record = (k: string, v: unknown): void => {
    if (!typeOf.has(k)) {
      order.push(k);
      const dataType = bsonDataTypeOf(v);
      typeOf.set(k, { dataType, normalizedType: normalizedOf(dataType) });
    } else if (typeOf.get(k)!.dataType === 'null' && v !== null && v !== undefined) {
      const dataType = bsonDataTypeOf(v);
      typeOf.set(k, { dataType, normalizedType: normalizedOf(dataType) });
    }
  };
  for (const doc of docs) {
    for (const [k, v] of Object.entries(doc)) {
      record(k, v);
    }
  }
  const names = order.filter((k) => k !== '_id');
  if (order.includes('_id')) {
    names.unshift('_id');
  }
  return names.map((name, i) => {
    const t = typeOf.get(name)!;
    const isPk = name === '_id';
    return {
      name,
      dataType: t.dataType === 'null' ? 'unknown' : t.dataType,
      normalizedType: t.normalizedType,
      nullable: !isPk,
      isPrimaryKey: isPk,
      ordinal: i + 1,
    };
  });
}
