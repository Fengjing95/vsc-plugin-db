import {
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
} from '@tanstack/react-table';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useMemo, useRef, useState } from 'react';
import { cellView } from '../../lib/cellDisplay';
import { useTableStore } from '../../store/tableStore';

const ROW_HEIGHT = 28;
const ROW_NUM_WIDTH = 56;
const OVERSCAN = 12;

/** 默认列宽按类型区分（概要设计 5.4 布局） */
function defaultWidth(type: string): number {
  switch (type) {
    case 'integer':
    case 'float':
    case 'decimal':
      return 110;
    case 'boolean':
      return 90;
    case 'date':
    case 'time':
      return 130;
    case 'datetime':
      return 180;
    case 'json':
      return 220;
    default:
      return 170;
  }
}

/**
 * 虚拟滚动数据网格（概要设计 5.4.4：只渲染可视区行；交互稿 §11 role=grid）。
 * TanStack Table 负责列模型/列宽/表头，TanStack Virtual 负责行窗口；
 * 排序为服务端下推（manualSorting），列宽本地拖拽，行号列左侧冻结。
 */
export function DataGrid({ pageOffset }: { pageOffset: number }) {
  const columns = useTableStore((s) => s.columns);
  const rows = useTableStore((s) => s.rows);
  const sorts = useTableStore((s) => s.sorts);
  const toggleSort = useTableStore((s) => s.toggleSort);

  const scrollRef = useRef<HTMLDivElement>(null);
  const [sizing, setSizing] = useState<Record<string, number>>({});

  const columnDefs = useMemo<ColumnDef<unknown[]>[]>(
    () =>
      columns.map((c, index) => ({
        id: c.name,
        accessorFn: (row) => row[index],
        size: defaultWidth(c.type),
        meta: { type: c.type },
      })),
    [columns],
  );

  const table = useReactTable({
    data: rows,
    columns: columnDefs,
    getCoreRowModel: getCoreRowModel(),
    manualSorting: true,
    state: { columnSizing: sizing },
    onColumnSizingChange: setSizing,
  });

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: OVERSCAN,
  });

  const headerCells = table.getHeaderGroups()[0]?.headers ?? [];
  const bodyWidth = ROW_NUM_WIDTH + headerCells.reduce((w, h) => w + h.getSize(), 0);

  return (
    <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto">
      <div style={{ width: bodyWidth }}>
        {/* 表头（垂直冻结） */}
        <div className="sticky top-0 z-20 flex border-b border-border bg-panel" style={{ height: ROW_HEIGHT }} role="row">
          <div
            className="sticky left-0 z-30 flex shrink-0 items-center border-r border-border bg-panel px-2 text-muted-foreground"
            style={{ width: ROW_NUM_WIDTH }}
          >
            #
          </div>
          {headerCells.map((header) => {
            const sorted = sorts.find((s) => s.column === header.id);
            return (
              <div
                key={header.id}
                role="columnheader"
                aria-sort={sorted ? (sorted.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
                className="group relative flex shrink-0 cursor-pointer select-none items-center justify-between gap-1 overflow-hidden border-r border-border px-2 text-left text-[13px] font-semibold text-panel-foreground hover:bg-accent"
                style={{ width: header.getSize() }}
                onClick={() => void toggleSort(header.id)}
                title={`按 ${header.id} 排序`}
              >
                <span className="truncate">{header.id}</span>
                <span className="shrink-0 text-[10px] text-muted-foreground">
                  {sorted ? (sorted.dir === 'asc' ? '▲' : '▼') : <span className="opacity-0 group-hover:opacity-60">▲▼</span>}
                </span>
                {/* 拖拽调宽（交互稿 §4.3）；阻止冒泡避免触发排序 */}
                <span
                  className="absolute right-0 top-0 h-full w-1 cursor-col-resize touch-none select-none hover:bg-ring"
                  onMouseDown={(e) => {
                    e.stopPropagation();
                    header.getResizeHandler()(e);
                  }}
                  onTouchStart={(e) => {
                    e.stopPropagation();
                    header.getResizeHandler()(e);
                  }}
                  onClick={(e) => e.stopPropagation()}
                />
              </div>
            );
          })}
        </div>

        {/* 行窗口（虚拟滚动） */}
        <div style={{ position: 'relative', height: rows.length * ROW_HEIGHT }}>
          {virtualizer.getVirtualItems().map((virtualRow) => {
            const tRow = table.getRowModel().rows[virtualRow.index];
            return (
              <div
                key={tRow.id}
                role="row"
                aria-rowindex={virtualRow.index + 1}
                className="absolute left-0 flex hover:bg-row-hover"
                style={{
                  top: virtualRow.start,
                  height: ROW_HEIGHT,
                  width: bodyWidth,
                }}
              >
                <div
                  role="gridcell"
                  className="sticky left-0 z-10 flex shrink-0 items-center justify-end border-r border-border bg-background px-2 text-[12px] text-muted-foreground"
                  style={{ width: ROW_NUM_WIDTH }}
                >
                  {pageOffset + virtualRow.index + 1}
                </div>
                {tRow.getVisibleCells().map((cell) => {
                  const type = (cell.column.columnDef.meta as { type?: string } | undefined)?.type ?? 'unknown';
                  const view = cellView(cell.getValue(), type);
                  return (
                    <div
                      key={cell.id}
                      role="gridcell"
                      className="flex shrink-0 items-center overflow-hidden border-r border-border px-2 text-[13px] text-foreground"
                      style={{ width: cell.column.getSize() }}
                      title={view.title}
                    >
                      <div className={`truncate ${view.className ?? ''}`}>{view.text}</div>
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
