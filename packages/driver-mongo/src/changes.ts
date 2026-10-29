import { ObjectId } from 'mongodb';
import { DriverError, type ChangeSet, type NormalizedType, type RowKey } from '@db-explorer/core';
import { toBsonValue, type ColumnTypes, type Filter } from './filter';

/**
 * ChangeSet → Mongo 变更计划（D-18）：previewChanges/applyChanges 同源生成（§8-6）。
 * - update = 字段级 `$set`，乐观锁 = `_id + 变更列原值`（D-03 同构；原值 null/缺失统一 `{f: null}`）；
 *   matchedCount ≠ 1 → E_CONFLICT（applyChanges 侧判定）
 * - 清空（新值 = null）→ `$set { f: null }`（不引入 $unset）
 * - insert：_id 缺省由服务器生成（applyChanges 回填 rowKey）；非法 hex 容错降级字符串（schema-free）
 * - sql 为 mongosh 伪语句（`?` 占位符 + params 等长，P-22——params 保持 §5 编码形态供 Webview 回填，
 *   执行值经列类型转回 BSON 原生）
 */

export interface MongoChangeOp {
  kind: 'insert' | 'update' | 'delete';
  tempId?: string;
  rowKey?: RowKey;
  /** mongosh 伪语句（? 占位符） */
  sql: string;
  /** 与 ? 等长（§5 编码形态） */
  params: unknown[];
  /** 执行计划（值已转 BSON 原生） */
  exec:
    | { type: 'insertOne'; doc: Filter }
    | { type: 'updateOne'; filter: Filter; update: { $set: Filter } }
    | { type: 'deleteOne'; filter: Filter };
}

/** 编辑值转换（schema-free 容错）：objectId 列非法 hex 降级字符串；类型转换失败（如 salt 过的
 *  decimal 字符串）按原样存储——Mongo 文档字段接受任意 BSON 类型，编辑不得因形态不合法拒绝写入 */
function editValue(
  type: { normalizedType: NormalizedType; dataType: string } | undefined,
  value: unknown,
): unknown {
  if (value === null || value === undefined) {
    return null;
  }
  if (type?.dataType === 'objectId' && typeof value === 'string') {
    if (/^[0-9a-f]{24}$/i.test(value)) {
      return new ObjectId(value);
    }
    return value;
  }
  try {
    return toBsonValue(type, value);
  } catch (err) {
    if (DriverError.is(err) && err.code === 'E_VALIDATION') {
      return value;
    }
    throw err;
  }
}

/** RowKey 的 _id 值（来自单元格读取：ObjectId 文档为 hex，字符串 _id 文档为原文）。
 *  fetchCell（ADR D-30）与变更语句同源复用 */
export function rowKeyFilter(rowKey: RowKey): { id: unknown; encodedId: unknown } {
  const raw = rowKey._id;
  return { id: editValue({ normalizedType: 'string', dataType: 'objectId' }, raw), encodedId: raw };
}

function quoteKey(k: string): string {
  return JSON.stringify(k);
}

export function buildChangeOps(obj: string, cs: ChangeSet, types: ColumnTypes): MongoChangeOp[] {
  const ops: MongoChangeOp[] = [];
  const colType = (c: string) => types.get(c);

  for (const ins of cs.inserts) {
    const doc: Filter = {};
    const params: unknown[] = [];
    const parts: string[] = [];
    for (const [k, v] of Object.entries(ins.values)) {
      doc[k] = editValue(colType(k), v);
      params.push(v);
      parts.push(`${quoteKey(k)}: ?`);
    }
    if (parts.length === 0) {
      continue; // 空插入无意义，跳过
    }
    ops.push({
      kind: 'insert',
      tempId: ins.tempId,
      rowKey: ins.values._id !== undefined ? { _id: ins.values._id } : undefined,
      sql: `db.${obj}.insertOne({ ${parts.join(', ')} })`,
      params,
      exec: { type: 'insertOne', doc },
    });
  }

  for (const upd of cs.updates) {
    const changed = Object.keys(upd.changes);
    if (changed.length === 0) {
      continue; // 无字段变更 → 无操作
    }
    const { id, encodedId } = rowKeyFilter(upd.rowKey);
    const filter: Filter = { _id: id };
    const set: Filter = {};
    const fParams: unknown[] = [encodedId];
    const sParams: unknown[] = [];
    const fParts: string[] = ['"_id": ?'];
    const sParts: string[] = [];
    for (const field of changed) {
      const ch = upd.changes[field]!;
      filter[field] = editValue(colType(field), ch.old);
      set[field] = editValue(colType(field), ch.new);
      fParams.push(ch.old);
      sParams.push(ch.new);
      fParts.push(`${quoteKey(field)}: ?`);
      sParts.push(`${quoteKey(field)}: ?`);
    }
    ops.push({
      kind: 'update',
      rowKey: upd.rowKey,
      sql: `db.${obj}.updateOne({ ${fParts.join(', ')} }, { $set: { ${sParts.join(', ')} } })`,
      params: [...fParams, ...sParams],
      exec: { type: 'updateOne', filter, update: { $set: set } },
    });
  }

  for (const del of cs.deletes) {
    const { id, encodedId } = rowKeyFilter(del.rowKey);
    ops.push({
      kind: 'delete',
      rowKey: del.rowKey,
      sql: `db.${obj}.deleteOne({ "_id": ? })`,
      params: [encodedId],
      exec: { type: 'deleteOne', filter: { _id: id } },
    });
  }

  return ops;
}
