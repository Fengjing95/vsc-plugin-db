import { DriverError, type ChangeSet, type PreviewItem } from '@db-explorer/core';
import { quoteMysqlIdentifier } from './sql';

/**
 * 变更集 → 参数化语句（驱动开发规范 §8，previewChanges/applyChanges 同源，预览即执行）：
 * - UPDATE 的 WHERE = RowKey（主键值）+ 变更列 original 原值（字段级乐观锁，D-03）；
 *   原值为 NULL 的列必须生成 IS NULL（col = NULL 永不匹配，会使乐观锁失效）
 * - 无主键表（allowNoPrimaryKey 全列匹配模式）：Webview 以全行原值作 RowKey，
 *   WHERE 自然覆盖全部列
 * - DELETE 的 WHERE 仅按 RowKey（无主键模式 RowKey 即全行原值，符合 D-03）
 * - 所有标识符经反引号引用，值一律参数化占位
 */
export function buildChangeStatements(db: string, obj: string, cs: ChangeSet): PreviewItem[] {
  const table = `${quoteMysqlIdentifier(db)}.${quoteMysqlIdentifier(obj)}`;
  const items: PreviewItem[] = [];

  for (const ins of cs.inserts) {
    const cols = Object.keys(ins.values);
    if (cols.length === 0) {
      throw new DriverError('E_VALIDATION', '新增行没有任何列值', {
        meta: { kind: 'insert', tempId: ins.tempId },
      });
    }
    items.push({
      kind: 'insert',
      tempId: ins.tempId,
      sql: `INSERT INTO ${table} (${cols.map(quoteMysqlIdentifier).join(', ')}) VALUES (${cols
        .map(() => '?')
        .join(', ')})`,
      params: cols.map((c) => toMysqlParam(ins.values[c])),
    });
  }

  for (const upd of cs.updates) {
    const setCols = Object.keys(upd.changes);
    if (setCols.length === 0) {
      continue;
    }
    const where: string[] = [];
    const whereParams: unknown[] = [];
    appendWhereParts(where, whereParams, upd.rowKey);
    for (const col of setCols) {
      if (col in upd.rowKey) {
        continue; // 全列匹配模式下 RowKey 已覆盖该列
      }
      appendWhereValue(where, whereParams, col, upd.changes[col].old);
    }
    if (where.length === 0) {
      throw new DriverError('E_VALIDATION', 'UPDATE 缺少定位条件（无主键且无原值）', {
        meta: { kind: 'update', rowKey: upd.rowKey },
      });
    }
    items.push({
      kind: 'update',
      rowKey: upd.rowKey,
      sql: `UPDATE ${table} SET ${setCols
        .map((c) => `${quoteMysqlIdentifier(c)} = ?`)
        .join(', ')} WHERE ${where.join(' AND ')}`,
      params: [...setCols.map((c) => toMysqlParam(upd.changes[c].new)), ...whereParams],
    });
  }

  for (const del of cs.deletes) {
    const where: string[] = [];
    const params: unknown[] = [];
    appendWhereParts(where, params, del.rowKey);
    if (where.length === 0) {
      throw new DriverError('E_VALIDATION', 'DELETE 缺少主键定位条件', {
        meta: { kind: 'delete', rowKey: del.rowKey },
      });
    }
    items.push({
      kind: 'delete',
      rowKey: del.rowKey,
      sql: `DELETE FROM ${table} WHERE ${where.join(' AND ')}`,
      params,
    });
  }

  return items;
}

function appendWhereValue(where: string[], params: unknown[], col: string, value: unknown): void {
  if (value === null || value === undefined) {
    where.push(`${quoteMysqlIdentifier(col)} IS NULL`);
  } else {
    where.push(`${quoteMysqlIdentifier(col)} = ?`);
    params.push(toMysqlParam(value));
  }
}

/**
 * JS 对象/数组 → JSON 文本（C-7 的 JSON=已解析对象在 mysql 绑定边界收口）：
 * 对象参数原样交给 mysql2 会被 sqlstring `.toString()` 成 '[object Object]'，
 * JSON 列服务端报 ER_INVALID_JSON_TEXT（契约 sql-value-encoding/changeset 组 CI 实跑暴露）。
 * Buffer 透传（JSON 化会破坏二进制语义；二进制列本就不走编辑，D-03 口径）。
 */
function toMysqlParam(value: unknown): unknown {
  if (value !== null && typeof value === 'object' && !Buffer.isBuffer(value)) {
    return JSON.stringify(value);
  }
  return value;
}

/** RowKey → WHERE 片段（值经 toMysqlParam；NULL 生成 IS NULL）。
 *  fetchCell（ADR D-30）与变更语句同源复用，保证定位语义一致 */
export function appendWhereParts(where: string[], params: unknown[], rowKey: Record<string, unknown>): void {
  for (const col of Object.keys(rowKey)) {
    appendWhereValue(where, params, col, rowKey[col]);
  }
}
