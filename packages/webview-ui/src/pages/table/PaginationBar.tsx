import { useState } from 'react';
import { Button } from '../../components/ui/button';
import { Select } from '../../components/ui/select';
import { PAGE_SIZES, paginationLabel } from '../../lib/queryState';
import { useTableStore } from '../../store/tableStore';

/**
 * 分页栏（交互稿 §4.7）：
 * - totalCount 已知：`第 X-Y 行 / 共 N 行` + 页码跳转
 * - 缺省：`第 X-Y 行`，行估算可得时附 `约 N 行`；仅上/下页，末页提示
 * - 每页 50 / 100 / 200 / 500
 */
export function PaginationBar() {
  const page = useTableStore((s) => s.page);
  const pageSize = useTableStore((s) => s.pageSize);
  const setPageSize = useTableStore((s) => s.setPageSize);
  const setPage = useTableStore((s) => s.setPage);
  const rows = useTableStore((s) => s.rows);
  const totalCount = useTableStore((s) => s.totalCount);
  const rowEstimate = useTableStore((s) => s.rowEstimate);
  const hasMore = useTableStore((s) => s.hasMore);
  const fetching = useTableStore((s) => s.fetching);

  const [jump, setJump] = useState('');
  const [endHint, setEndHint] = useState(false);

  const knownTotal = totalCount ?? undefined;
  const totalPages = knownTotal !== undefined ? Math.max(1, Math.ceil(knownTotal / pageSize)) : undefined;
  const hasPrev = page > 0;
  const hasNext = totalPages !== undefined ? page + 1 < totalPages : hasMore;

  const goNext = () => {
    if (hasNext) {
      setEndHint(false);
      void setPage(page + 1);
    } else if (knownTotal === undefined) {
      // 翻到空页提示“已是末页”（交互稿 §4.7）
      setEndHint(true);
    }
  };

  const goPrev = () => {
    setEndHint(false);
    void setPage(page - 1);
  };

  const jumpTo = () => {
    const target = Number(jump);
    if (totalPages !== undefined && Number.isInteger(target) && target >= 1 && target <= totalPages) {
      setEndHint(false);
      void setPage(target - 1);
    }
    setJump('');
  };

  return (
    <div className="flex items-center gap-2 border-t border-border bg-panel px-2 py-1.5 text-[12px] text-muted-foreground">
      <span>{paginationLabel({ page, pageSize, loadedRows: rows.length, totalCount, rowEstimate })}</span>
      {fetching && <span>加载中…</span>}
      {rows.length === 0 && knownTotal === undefined && <span>已是末页</span>}

      <span className="flex-1" />
      {endHint && <span className="text-warning">已是末页</span>}

      <Select
        aria-label="每页行数"
        value={String(pageSize)}
        options={PAGE_SIZES.map((n) => ({ value: String(n), label: `每页 ${n}` }))}
        className="w-28 h-6 text-[12px]"
        onValueChange={(v) => void setPageSize(Number(v))}
      />

      <Button variant="ghost" size="icon" aria-label="上一页" disabled={!hasPrev || fetching} onClick={goPrev}>
        ◀
      </Button>
      {totalPages !== undefined ? (
        <span className="whitespace-nowrap">
          第 {page + 1} / {totalPages} 页
        </span>
      ) : (
        <span className="whitespace-nowrap">第 {page + 1} 页</span>
      )}
      <Button variant="ghost" size="icon" aria-label="下一页" disabled={!hasNext || fetching} onClick={goNext}>
        ▶
      </Button>

      {totalPages !== undefined && (
        <span className="flex items-center gap-1">
          跳至
          <input
            aria-label="页码跳转"
            className="h-6 w-12 rounded-sm border border-input-border bg-input-bg px-1 text-center text-[12px] text-input-fg outline-none focus-visible:border-ring"
            value={jump}
            onChange={(e) => setJump(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                jumpTo();
              }
            }}
            placeholder={String(page + 1)}
          />
          页
        </span>
      )}
    </div>
  );
}
