import type { ChangeSet, RowKey } from '../model/rows';

/**
 * 表格编辑变更集服务（概要设计 §4.5 / ADR D-06）：
 * 权威副本在 Extension Host（viewId → ChangeSet）；Webview 编辑操作经
 * debounce 上行在此合并。合并语义让"同一单元格反复编辑"始终只有一条记录，
 * 回改回原值自动消项，删行吞并同行的未提交 update。
 */

/** Webview → Host 的单条编辑操作（经 protocol EditOpSchema 双端校验后传入） */
export type EditOp =
  | { op: 'setCell'; rowKey: RowKey; column: string; old: unknown; new: unknown }
  | { op: 'addRow'; tempId: string; values: Record<string, unknown> }
  | { op: 'setInsertCell'; tempId: string; column: string; value: unknown }
  | { op: 'removeRow'; tempId: string }
  | { op: 'markDelete'; rowKey: RowKey }
  | { op: 'unmarkDelete'; rowKey: RowKey }
  | { op: 'revertRow'; rowKey: RowKey };

export interface ChangeCounts {
  inserts: number;
  updates: number;
  deletes: number;
}

export function emptyChangeSet(): ChangeSet {
  return { inserts: [], updates: [], deletes: [] };
}

/** 稳定键：RowKey → 字符串（键序无关），作为 updates/deletes 的合并主键 */
export function rowKeyString(rowKey: RowKey): string {
  const keys = Object.keys(rowKey).sort();
  return JSON.stringify(keys.map((k) => [k, rowKey[k]]));
}

/** 值相等：严格相等优先，对象按 JSON 比较（值编码契约下 JSON 传对象） */
export function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  if (typeof a === 'object' && typeof b === 'object' && a !== null && b !== null) {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return false;
}

function cloneChangeSet(cs: ChangeSet): ChangeSet {
  return JSON.parse(JSON.stringify(cs)) as ChangeSet;
}

export class ChangeSetService {
  private readonly views = new Map<string, ChangeSet>();
  private readonly listeners = new Set<(viewId: string, cs: ChangeSet, counts: ChangeCounts) => void>();

  /** 订阅变更（Host 侧用于推送 evt:changeset.updated）；返回退订函数 */
  subscribe(fn: (viewId: string, cs: ChangeSet, counts: ChangeCounts) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** 取视图变更集（无则返回空集；不复制，调用方不得改写） */
  get(viewId: string): ChangeSet {
    return this.views.get(viewId) ?? emptyChangeSet();
  }

  counts(viewId: string): ChangeCounts {
    const cs = this.get(viewId);
    return { inserts: cs.inserts.length, updates: cs.updates.length, deletes: cs.deletes.length };
  }

  isEmpty(viewId: string): boolean {
    const c = this.counts(viewId);
    return c.inserts + c.updates + c.deletes === 0;
  }

  /** 快照导出（深拷贝，用于握手回放） */
  snapshot(viewId: string): ChangeSet {
    return cloneChangeSet(this.get(viewId));
  }

  /** 快照恢复（Webview 重载 / 回放） */
  restore(viewId: string, cs: ChangeSet): void {
    this.views.set(viewId, cloneChangeSet(cs));
    this.emit(viewId);
  }

  /** 应用一条编辑操作并返回是否产生了实际变化 */
  applyOp(viewId: string, op: EditOp): boolean {
    const cs = this.getOrInit(viewId);
    let changed: boolean;
    switch (op.op) {
      case 'setCell':
        changed = this.mergeSetCell(cs, op);
        break;
      case 'addRow':
        changed = this.mergeAddRow(cs, op);
        break;
      case 'setInsertCell': {
        const insert = cs.inserts.find((i) => i.tempId === op.tempId);
        if (!insert) {
          throw new Error(`insert ${op.tempId} 不存在`);
        }
        changed = !valuesEqual(insert.values[op.column], op.value);
        insert.values[op.column] = op.value;
        break;
      }
      case 'removeRow': {
        const before = cs.inserts.length;
        cs.inserts = cs.inserts.filter((i) => i.tempId !== op.tempId);
        changed = cs.inserts.length !== before;
        break;
      }
      case 'markDelete':
        changed = this.mergeMarkDelete(cs, op);
        break;
      case 'unmarkDelete': {
        const before = cs.deletes.length;
        cs.deletes = cs.deletes.filter((d) => rowKeyString(d.rowKey) !== rowKeyString(op.rowKey));
        changed = cs.deletes.length !== before;
        break;
      }
      case 'revertRow': {
        const key = rowKeyString(op.rowKey);
        const updatesBefore = cs.updates.length;
        const deletesBefore = cs.deletes.length;
        cs.updates = cs.updates.filter((u) => rowKeyString(u.rowKey) !== key);
        cs.deletes = cs.deletes.filter((d) => rowKeyString(d.rowKey) !== key);
        changed = cs.updates.length !== updatesBefore || cs.deletes.length !== deletesBefore;
        break;
      }
      default: {
        const exhaustive: never = op;
        throw new Error(`未知编辑操作: ${JSON.stringify(exhaustive)}`);
      }
    }
    if (changed) {
      this.emit(viewId);
    }
    return changed;
  }

  /** 撤销全部 / 提交成功后清空 */
  clear(viewId: string): void {
    if (!this.views.delete(viewId)) {
      return;
    }
    this.emit(viewId);
  }

  /** 视图关闭且用户放弃变更后释放 */
  disposeView(viewId: string): void {
    this.views.delete(viewId);
  }

  // ── 合并语义 ────────────────────────────────────────────────

  private getOrInit(viewId: string): ChangeSet {
    let cs = this.views.get(viewId);
    if (!cs) {
      cs = emptyChangeSet();
      this.views.set(viewId, cs);
    }
    return cs;
  }

  private mergeSetCell(cs: ChangeSet, op: Extract<EditOp, { op: 'setCell' }>): boolean {
    const key = rowKeyString(op.rowKey);
    let entry = cs.updates.find((u) => rowKeyString(u.rowKey) === key);
    if (!entry) {
      entry = {
        rowKey: { ...op.rowKey },
        // original = 定位键 + 被改列原值（乐观锁 WHERE 的全部输入，P-7 基线由 Webview 保证全列时为全行）
        original: { ...op.rowKey, [op.column]: op.old },
        changes: {},
      };
      cs.updates.push(entry);
    }
    const colChange = entry.changes[op.column];
    // 反复编辑同一格：保留最初的 old 作为乐观锁基线
    const baselineOld = colChange ? colChange.old : op.old;
    if (valuesEqual(op.new, baselineOld)) {
      if (colChange) {
        delete entry.changes[op.column];
        if (Object.keys(entry.changes).length === 0) {
          cs.updates = cs.updates.filter((u) => u !== entry);
          return true;
        }
        return true;
      }
      // 从未改过且新值等于原值 → 无变化
      cs.updates = cs.updates.filter((u) => u !== entry);
      return false;
    }
    entry.changes[op.column] = { old: baselineOld, new: op.new };
    return true;
  }

  private mergeAddRow(cs: ChangeSet, op: Extract<EditOp, { op: 'addRow' }>): boolean {
    const existing = cs.inserts.find((i) => i.tempId === op.tempId);
    if (existing) {
      Object.assign(existing.values, op.values);
      return true;
    }
    cs.inserts.push({ tempId: op.tempId, values: { ...op.values } });
    return true;
  }

  private mergeMarkDelete(cs: ChangeSet, op: Extract<EditOp, { op: 'markDelete' }>): boolean {
    const key = rowKeyString(op.rowKey);
    // 删行吞并同行的未提交 update（最终效果 = DELETE）
    cs.updates = cs.updates.filter((u) => rowKeyString(u.rowKey) !== key);
    if (cs.deletes.some((d) => rowKeyString(d.rowKey) === key)) {
      return false;
    }
    cs.deletes.push({ rowKey: { ...op.rowKey }, original: { ...op.rowKey } });
    return true;
  }

  private emit(viewId: string): void {
    const cs = this.get(viewId);
    const counts = this.counts(viewId);
    for (const fn of this.listeners) {
      fn(viewId, cs, counts);
    }
  }
}
