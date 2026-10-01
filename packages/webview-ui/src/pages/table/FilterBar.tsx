import { useEffect, useState } from 'react';
import { Button } from '../../components/ui/button';
import { useTableStore } from '../../store/tableStore';
import { SqlInput } from './SqlInput';

/**
 * 自由条件栏（交互稿 §4.4 v0.1.3）：WHERE 与 ORDER BY 两个手写输入框，
 * 语法高亮 + 列名/关键字补全；应用 → 服务端拼接进最终语句并回到第 1 页；
 * 未应用的改动在 [应用] 上以蓝点提示。清空同时移除全局搜索（回到全量数据）。
 */
export function FilterBar() {
  const allColumns = useTableStore((s) => (s.allColumns.length > 0 ? s.allColumns : s.columns));
  const appliedWhere = useTableStore((s) => s.appliedWhere);
  const appliedOrderBy = useTableStore((s) => s.appliedOrderBy);
  const applyQuery = useTableStore((s) => s.applyQuery);
  const clearFilters = useTableStore((s) => s.clearFilters);
  const searchApplied = useTableStore((s) => s.searchApplied);
  const applySearch = useTableStore((s) => s.applySearch);

  const [where, setWhere] = useState(appliedWhere);
  const [orderBy, setOrderBy] = useState(appliedOrderBy);
  const dirty = where !== appliedWhere || orderBy !== appliedOrderBy;

  // 应用/清空后同步本地草稿
  useEffect(() => {
    setWhere(appliedWhere);
    setOrderBy(appliedOrderBy);
  }, [appliedWhere, appliedOrderBy]);

  const apply = (): void => {
    void applyQuery(where.trim(), orderBy.trim());
  };

  return (
    <div className="flex flex-wrap items-start gap-1.5 border-b border-border bg-panel px-2 py-1.5">
      <span className="mt-1 shrink-0 font-mono text-[11px] font-medium text-muted-foreground" title="手写 WHERE 条件（语法错误在应用时提示）">
        WHERE
      </span>
      <SqlInput
        value={where}
        onChange={setWhere}
        onApply={apply}
        columns={allColumns}
        context="where"
        ariaLabel="WHERE 条件"
        placeholder="如：status = 'active' AND (amount > 100 OR note IS NOT NULL)"
        widthClass="min-w-56 flex-1"
      />
      <span className="ml-1 mt-1 shrink-0 font-mono text-[11px] font-medium text-muted-foreground" title="手写 ORDER BY（追加在列头排序之后）">
        ORDER BY
      </span>
      <SqlInput
        value={orderBy}
        onChange={setOrderBy}
        onApply={apply}
        columns={allColumns}
        context="order"
        ariaLabel="ORDER BY 排序"
        placeholder="如：created_at DESC, id"
        widthClass="w-64"
      />
      <div className="flex shrink-0 items-center gap-1.5 self-start">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setWhere('');
            setOrderBy('');
            void clearFilters();
            // 清空语义包含全局搜索一并移除（回到全量数据）
            if (searchApplied !== '') {
              void applySearch('');
            }
          }}
          disabled={where === '' && orderBy === '' && searchApplied === ''}
        >
          ↺ 清空
        </Button>
        <Button variant="primary" size="sm" disabled={!dirty} onClick={apply} title={dirty ? '应用条件（服务端拼接）' : '无未应用的改动'}>
          ▶ 应用
          {dirty && <span className="h-1.5 w-1.5 rounded-full bg-link" aria-label="有未应用的改动" />}
        </Button>
      </div>
    </div>
  );
}
