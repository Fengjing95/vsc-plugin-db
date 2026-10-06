import { DriverError, type ChangeSet, type PreviewItem } from '@db-explorer/core';
import { quotePgIdentifier } from './sql';

/**
 * 变更集 → 参数化语句（驱动开发规范 §8，previewChanges/applyChanges 同源，预览即执行）：
 * - UPDATE 的 WHERE = RowKey（主键值）+ 变更列 original 原值（字段级乐观锁，D-03）；
 *   原值为 NULL 的列必须生成 IS NULL（col = NULL 永不匹配，会使乐观锁失效）
 * - 无主键表（allowNoPrimaryKey 全列匹配模式）：Webview 以全行原值作 RowKey，
 *   WHERE 自然覆盖全部列
 * - DELETE 的 WHERE 仅按 RowKey
 * - 占位符为 PG 风格 $n（逐语句独立编号）；INSERT 携带 RETURNING 主键列（§8-3 回填），
 *   预览与执行同一语句形状
 */
export interface ChangeBuildOptions {
  /** 主键列名（listColumns 派生）；给出时 INSERT 生成 RETURNING */
  pkColumns?: string[];
  /** 值编码 → 原生参数转换（§5：编辑回传 base64 字符串，applyChanges 绑定前转 Buffer 等）；
   *  previewChanges 不传——预览 params 保持 §5 编码（Webview 回填展示依赖，P-22） */
  encodeParam?: (column: string, value: unknown) => unknown;
}

export function buildChangeStatements(
  db: string,
  obj: string,
  cs: ChangeSet,
  opts?: ChangeBuildOptions,
): PreviewItem[] {
  const table = `${quotePgIdentifier(db)}.${quotePgIdentifier(obj)}`;
  const enc = opts?.encodeParam ?? ((_column: string, value: unknown) => value);
  const items: PreviewItem[] = [];

  for (const ins of cs.inserts) {
    const cols = Object.keys(ins.values);
    if (cols.length === 0) {
      throw new DriverError('E_VALIDATION', '新增行没有任何列值', {
        meta: { kind: 'insert', tempId: ins.tempId },
      });
    }
    const returning = opts?.pkColumns?.length
      ? ` RETURNING ${opts.pkColumns.map(quotePgIdentifier).join(', ')}`
      : '';
    items.push({
      kind: 'insert',
      tempId: ins.tempId,
      sql: `INSERT INTO ${table} (${cols.map(quotePgIdentifier).join(', ')}) VALUES (${cols
        .map((_, i) => `$${i + 1}`)
        .join(', ')})${returning}`,
      params: cols.map((c) => enc(c, ins.values[c])),
    });
  }

  for (const upd of cs.updates) {
    const setCols = Object.keys(upd.changes);
    if (setCols.length === 0) {
      continue;
    }
    const params: unknown[] = [];
    const bind = (column: string, value: unknown): string => `$${params.push(enc(column, value))}`;
    // SET 先于 WHERE 绑定（占位符按语句阅读顺序编号）
    const setSql = setCols.map((c) => `${quotePgIdentifier(c)} = ${bind(c, upd.changes[c].new)}`).join(', ');
    const where: string[] = [];
    appendWhereParts(where, bind, upd.rowKey);
    for (const col of setCols) {
      if (col in upd.rowKey) {
        continue; // 全列匹配模式下 RowKey 已覆盖该列
      }
      appendWhereValue(where, bind, col, upd.changes[col].old);
    }
    if (where.length === 0) {
      throw new DriverError('E_VALIDATION', 'UPDATE 缺少定位条件（无主键且无原值）', {
        meta: { kind: 'update', rowKey: upd.rowKey },
      });
    }
    items.push({
      kind: 'update',
      rowKey: upd.rowKey,
      sql: `UPDATE ${table} SET ${setSql} WHERE ${where.join(' AND ')}`,
      params,
    });
  }

  for (const del of cs.deletes) {
    const where: string[] = [];
    const params: unknown[] = [];
    const bind = (column: string, value: unknown): string => `$${params.push(enc(column, value))}`;
    appendWhereParts(where, bind, del.rowKey);
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

function appendWhereValue(
  where: string[],
  bind: (column: string, value: unknown) => string,
  col: string,
  value: unknown,
): void {
  if (value === null || value === undefined) {
    where.push(`${quotePgIdentifier(col)} IS NULL`);
  } else {
    where.push(`${quotePgIdentifier(col)} = ${bind(col, value)}`);
  }
}

function appendWhereParts(
  where: string[],
  bind: (column: string, value: unknown) => string,
  rowKey: Record<string, unknown>,
): void {
  for (const col of Object.keys(rowKey)) {
    appendWhereValue(where, bind, col, rowKey[col]);
  }
}
