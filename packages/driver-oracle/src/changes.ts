import { DriverError, type ChangeSet, type PreviewItem } from '@db-explorer/core';
import { quoteOracleIdentifier, toOracleParam } from './sql';

/**
 * 变更集 → 参数化语句（驱动规范 §8，previewChanges/applyChanges 同源，预览即执行）：
 * - UPDATE 的 WHERE = RowKey（主键值）+ 变更列 original 原值（字段级乐观锁，D-03）；
 *   原值为 NULL 的列必须生成 IS NULL。空串原值 ≡ NULL（Oracle 引擎语义，ADR D-23 岔口 4），
 *   '' 读不回 → original 恒非空串，无特化分支
 * - 无主键表（allowNoPrimaryKey 全列匹配模式）：Webview 以全行原值作 RowKey，WHERE 自然覆盖全部列
 * - DELETE 的 WHERE 仅按 RowKey
 * - 占位符为 Oracle 位置绑定 :N（逐语句独立编号）；INSERT 携带 RETURNING 主键列 INTO :k+1…:k+n
 *   （ADR D-23 回填机制，PG RETURNING 同构语义），预览与执行同一语句形状；
 *   PreviewItem.params 只含输入绑定（执行时连接层在尾部追加 out 绑定对象）
 */
export interface ChangeBuildOptions {
  /** 主键列名（listColumns 派生）；给出时 INSERT 生成 RETURNING…INTO（§8-3 回填） */
  pkColumns?: string[];
  /** 值编码 → 原生参数转换（§5：编辑回传 datetime 文本 → Date；applyChanges 传，preview 不传——P-22） */
  encodeParam?: (column: string, value: unknown) => unknown;
}

export function buildChangeStatements(
  db: string,
  obj: string,
  cs: ChangeSet,
  opts?: ChangeBuildOptions,
): PreviewItem[] {
  const table = `${quoteOracleIdentifier(db)}.${quoteOracleIdentifier(obj)}`;
  const enc = opts?.encodeParam ?? ((_column: string, value: unknown) => value);
  const items: PreviewItem[] = [];

  for (const ins of cs.inserts) {
    const cols = Object.keys(ins.values);
    if (cols.length === 0) {
      throw new DriverError('E_VALIDATION', '新增行没有任何列值', {
        meta: { kind: 'insert', tempId: ins.tempId },
      });
    }
    const params = cols.map((c) => enc(c, toOracleParam(ins.values[c])));
    // RETURNING 占位符从输入绑定数之后编号（执行时连接层在 binds 尾部追加 out 绑定对象）
    const outPlaceholders = opts?.pkColumns?.length
      ? ` RETURNING ${opts.pkColumns.map(quoteOracleIdentifier).join(', ')} INTO ${opts.pkColumns
          .map((_, i) => `:${params.length + 1 + i}`)
          .join(', ')}`
      : '';
    items.push({
      kind: 'insert',
      tempId: ins.tempId,
      sql: `INSERT INTO ${table} (${cols.map(quoteOracleIdentifier).join(', ')}) VALUES (${cols
        .map((_, i) => `:${i + 1}`)
        .join(', ')})${outPlaceholders}`,
      params,
    });
  }

  for (const upd of cs.updates) {
    const setCols = Object.keys(upd.changes);
    if (setCols.length === 0) {
      continue;
    }
    const params: unknown[] = [];
    const bind = (column: string, value: unknown): string =>
      `:${params.push(enc(column, toOracleParam(value)))}`;
    // SET 先于 WHERE 绑定（占位符按语句阅读顺序编号）
    const setSql = setCols.map((c) => `${quoteOracleIdentifier(c)} = ${bind(c, upd.changes[c].new)}`).join(', ');
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
    const bind = (column: string, value: unknown): string =>
      `:${params.push(enc(column, toOracleParam(value)))}`;
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
    where.push(`${quoteOracleIdentifier(col)} IS NULL`);
  } else {
    where.push(`${quoteOracleIdentifier(col)} = ${bind(col, value)}`);
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
