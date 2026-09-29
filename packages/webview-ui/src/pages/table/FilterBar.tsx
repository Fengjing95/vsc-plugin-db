import { useEffect, useState } from 'react';
import type { FilterOpPayload as FilterOp } from '@db-explorer/protocol';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Select } from '../../components/ui/select';
import {
  draftsDirty,
  OP_LABELS,
  opsForType,
  opValueShape,
  type FilterDraft,
} from '../../lib/filterOps';
import { useTableStore } from '../../store/tableStore';

let draftSeq = 0;

function newDraft(column: string, op: FilterOp): FilterDraft {
  return { id: `f${++draftSeq}`, column, op, value: '', value2: '' };
}

/**
 * 筛选构造器（交互稿 §4.4）：行式构造，列/操作符/类型化值；
 * 应用 → 服务端下推并回到第 1 页；未应用的改动在 [应用] 上以蓝点提示。
 */
export function FilterBar() {
  const allColumns = useTableStore((s) => (s.allColumns.length > 0 ? s.allColumns : s.columns));
  const applied = useTableStore((s) => s.appliedDrafts);
  const applyFilters = useTableStore((s) => s.applyFilters);
  const clearFilters = useTableStore((s) => s.clearFilters);
  const searchApplied = useTableStore((s) => s.searchApplied);
  const applySearch = useTableStore((s) => s.applySearch);

  const [drafts, setDrafts] = useState<FilterDraft[]>(applied);
  const dirty = draftsDirty(drafts, applied);

  useEffect(() => {
    setDrafts(applied);
    // 应用/清空后同步本地草稿
  }, [applied]);

  const columnOptions = allColumns.map((c) => ({ value: c.name, label: c.name }));
  const typeOf = (name: string) => allColumns.find((c) => c.name === name)?.type ?? 'unknown';

  const addDraft = () => {
    const first = allColumns[0];
    if (first) {
      setDrafts((cur) => [...cur, newDraft(first.name, opsForType(first.type)[0])]);
    }
  };

  const updateDraft = (id: string, patch: Partial<FilterDraft>) => {
    setDrafts((cur) => cur.map((d) => (d.id === id ? { ...d, ...patch } : d)));
  };

  const removeDraft = (id: string) => {
    setDrafts((cur) => cur.filter((d) => d.id !== id));
  };

  return (
    <div className="flex flex-wrap items-center gap-1.5 border-b border-border bg-panel px-2 py-1.5">
      <span className="shrink-0 text-[12px] text-muted-foreground">筛选:</span>

      {drafts.map((d) => {
        const type = typeOf(d.column);
        const ops = opsForType(type);
        const shape = opValueShape(d.op);
        return (
          <div key={d.id} className="flex items-center gap-1">
            <Select
              aria-label="筛选列"
              value={d.column}
              options={columnOptions}
              className="w-32"
              onValueChange={(column) => {
                updateDraft(d.id, { column, op: opsForType(typeOf(column))[0], value: '', value2: '' });
              }}
            />
            <Select
              aria-label="操作符"
              value={d.op}
              options={ops.map((op) => ({ value: op, label: OP_LABELS[op] }))}
              className="w-24"
              onValueChange={(op) => updateDraft(d.id, { op: op as FilterOp, value: '', value2: '' })}
            />
            {shape !== 'none' && (
              <Input
                aria-label="筛选值"
                className={shape === 'double' ? 'w-24' : 'w-36'}
                placeholder={shape === 'multi' ? '多值用换行/逗号分隔' : type === 'datetime' ? 'YYYY-MM-DD hh:mm:ss' : '值'}
                value={d.value}
                onChange={(e) => updateDraft(d.id, { value: e.target.value })}
              />
            )}
            {shape === 'double' && (
              <>
                <span className="text-[12px] text-muted-foreground">至</span>
                <Input
                  aria-label="筛选值上限"
                  className="w-24"
                  value={d.value2}
                  onChange={(e) => updateDraft(d.id, { value2: e.target.value })}
                />
              </>
            )}
            <button
              type="button"
              aria-label="移除条件"
              className="px-1 text-[13px] text-muted-foreground hover:text-destructive"
              onClick={() => removeDraft(d.id)}
            >
              ✕
            </button>
          </div>
        );
      })}

      <Button variant="ghost" size="sm" onClick={addDraft} disabled={allColumns.length === 0}>
        ＋ 条件
      </Button>
      <span className="flex-1" />
      <Button
        variant="ghost"
        size="sm"
        onClick={() => {
          setDrafts([]);
          void clearFilters();
          // 清空语义包含全局搜索一并移除（回到全量数据）
          if (searchApplied !== '') {
            void applySearch('');
          }
        }}
        disabled={drafts.length === 0 && searchApplied === ''}
      >
        ↺ 清空
      </Button>
      <Button
        variant="primary"
        size="sm"
        disabled={!dirty}
        onClick={() => void applyFilters(drafts)}
        title={dirty ? '应用筛选（服务端下推）' : '无未应用的改动'}
      >
        ▶ 应用
        {dirty && <span className="h-1.5 w-1.5 rounded-full bg-link" aria-label="有未应用的改动" />}
      </Button>
    </div>
  );
}
