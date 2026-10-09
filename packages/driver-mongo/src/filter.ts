import { Binary, Decimal128, ObjectId } from 'mongodb';
import { DriverError, type FilterCondition, type NormalizedType } from '@db-explorer/core';
import { parseDateTimeUtc } from './document';

/**
 * FilterOp → Mongo 查询文档下推（驱动规范 §5.5）。P-9 口径：值为「绑定」语义——
 * 只出现在查询文档的值位置（按采样列类型转回 BSON 原生值），禁止任何字符串拼接。
 * NULL 语义与 SQL 三值逻辑基准（conformance sqlMatch）一致：ne/notIn 以 $nin 含 null
 * 同时排除缺失字段；isNull 命中显式 null 与缺失（文档模型口径，D-17）。
 */

export type ColumnTypes = Map<string, { normalizedType: NormalizedType; dataType: string }>;
export type Filter = Record<string, unknown>;

/** 正则特殊字符全转义（like/search 子串语义；用户输入中的 . * 等绝不解释为通配） */
export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 筛选值 → BSON 原生值（未采样列原样透传） */
export function toBsonValue(
  type: { normalizedType: NormalizedType; dataType: string } | undefined,
  value: unknown,
): unknown {
  if (value === null || value === undefined) {
    return null;
  }
  if (!type) {
    return value;
  }
  try {
    switch (type.dataType) {
      case 'objectId':
        return new ObjectId(String(value));
      case 'date':
        return parseDateTimeUtc(String(value));
      case 'decimal':
        return Decimal128.fromString(String(value));
      case 'binary':
        return new Binary(Buffer.from(String(value), 'base64'));
      case 'int':
      case 'long':
      case 'double': {
        const n = Number(value);
        if (!Number.isFinite(n)) {
          throw new Error(`非数值：${String(value)}`);
        }
        return n;
      }
      default:
        break;
    }
  } catch (err) {
    if (DriverError.is(err)) {
      throw err;
    }
    throw new DriverError('E_VALIDATION', `筛选值无法转换为列类型 ${type.dataType}：${String(value)}`);
  }
  switch (type.normalizedType) {
    case 'integer':
    case 'float': {
      const n = Number(value);
      return Number.isFinite(n) ? n : value;
    }
    case 'decimal':
      return Decimal128.fromString(String(value));
    case 'datetime':
    case 'date':
      return parseDateTimeUtc(String(value));
    case 'boolean':
      return value === true || value === 'true';
    default:
      return value;
  }
}

function columnType(types: ColumnTypes, column: string): { normalizedType: NormalizedType; dataType: string } {
  const t = types.get(column);
  if (!t) {
    throw new DriverError('E_VALIDATION', `未知筛选列 "${column}"（列集由采样推断，请刷新后重试）`);
  }
  return t;
}

/** like 条件（按列类型）：string 列 → 原生 $regex；objectId 列 → $toString + $regexMatch
 *  （$regex 不作用于 ObjectId 的 hex 串形态；浏览路径不走索引，语义与内存基准 includes 一致） */
function likeCondition(
  col: string,
  type: { dataType: string } | undefined,
  pattern: string,
): Filter {
  if (type?.dataType === 'objectId') {
    return { $expr: { $regexMatch: { input: { $toString: `$${col}` }, regex: pattern } } };
  }
  return { [col]: { $regex: pattern } };
}

function buildClause(f: FilterCondition, types: ColumnTypes): Filter {
  switch (f.op) {
    case 'isNull':
      return { [f.column]: null }; // 命中显式 null 与缺失字段（Mongo 原生语义即文档模型口径）
    case 'isNotNull':
      return { [f.column]: { $ne: null } };
    case 'like':
      // 子串语义：正则在「编码形态」（字符串）上匹配，不做列类型转换（如 objectId hex 前缀）
      return likeCondition(f.column, types.get(f.column), escapeRegex(String(f.value ?? '')));
    case 'notLike':
      return {
        $nor: [likeCondition(f.column, types.get(f.column), escapeRegex(String(f.value ?? '')))],
      };
    default:
      break;
  }
  const t = columnType(types, f.column);
  const v = toBsonValue(t, f.value);
  switch (f.op) {
    case 'eq':
      return { [f.column]: v };
    case 'ne':
      return { [f.column]: { $nin: [v, null] } }; // SQL 三值：NULL 行排除（$nin 含 null 同时排除缺失）
    case 'gt':
      return { [f.column]: { $gt: v } };
    case 'ge':
      return { [f.column]: { $gte: v } };
    case 'lt':
      return { [f.column]: { $lt: v } };
    case 'le':
      return { [f.column]: { $lte: v } };
    case 'in':
      return { [f.column]: { $in: (f.values ?? []).map((x) => toBsonValue(t, x)) } };
    case 'notIn':
      return { [f.column]: { $nin: [...(f.values ?? []).map((x) => toBsonValue(t, x)), null] } };
    case 'between': {
      const [lo, hi] = f.values ?? [];
      return { [f.column]: { $gte: toBsonValue(t, lo), $lte: toBsonValue(t, hi) } };
    }
    default:
      throw new DriverError('E_VALIDATION', `不支持的筛选操作符：${String(f.op)}`);
  }
}

/** 多条件 AND 语义；单条件不打 $and（同列多条件经 $and 天然支持） */
export function buildFilterDoc(filters: FilterCondition[], types: ColumnTypes): Filter {
  const clauses = filters.map((f) => buildClause(f, types));
  if (clauses.length === 1) {
    return clauses[0]!;
  }
  return { $and: clauses };
}

/** 排序：用户排序优先；_id:1 作末位 tiebreak 追加（P-10，不前置）；已含 _id 不重复 */
export function buildSortDoc(sorts?: Array<{ column: string; dir: 'asc' | 'desc' }>): Record<string, 1 | -1> {
  const sort: Record<string, 1 | -1> = {};
  for (const s of sorts ?? []) {
    sort[s.column] = s.dir === 'desc' ? -1 : 1;
  }
  if (!('_id' in sort)) {
    sort._id = 1;
  }
  return sort;
}

/** search 全局关键字：各 string 列转义子串 $or（与内存基准 includes 一致）；无 string 列 → undefined */
export function buildSearchDoc(
  search: string | undefined,
  stringColumns: Array<{ name: string; dataType: string }>,
): Filter | undefined {
  if (!search || stringColumns.length === 0) {
    return undefined;
  }
  return {
    $or: stringColumns.map((c) => likeCondition(c.name, c, escapeRegex(search))),
  };
}
