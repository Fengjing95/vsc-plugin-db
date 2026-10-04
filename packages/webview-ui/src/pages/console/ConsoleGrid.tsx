import { useVirtualizer } from '@tanstack/react-virtual';
import { useRef, useState } from 'react';
import type { ResultSetPayload } from '@db-explorer/protocol';
import { ContextMenu, type ContextMenuItem } from '../../components/ui/contextMenu';
import { cellView } from '../../lib/cellDisplay';
import { explainIndentPrefix } from '../../lib/consoleView';
import { defaultWidth } from '../table/DataGrid';

const ROW_HEIGHT = 28;
const ROW_NUM_WIDTH = 56;
const OVERSCAN = 12;

/**
 * Console 只读结果网格（交互稿 §7.3：只读表格，同 §4.2 视觉）：
 * 复用 cellDisplay 渲染契约与虚拟滚动骨架；无编辑/选择/排序（结果集只读）。
 * P-21：虚拟列表与滚动容器同组件挂载（ref 就绪先于 layout effect）。
 * planLevels（D-13）：EXPLAIN 结果的首列树形缩进级别（与行一一对应）。
 */
export function ConsoleGrid({
  resultSet,
  planLevels,
}: {
  resultSet: ResultSetPayload;
  planLevels?: number[];
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; items: ContextMenuItem[] } | null>(null);

  const virtualizer = useVirtualizer({
    count: resultSet.rowCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: OVERSCAN,
  });

  const widths = resultSet.columns.map((c) => defaultWidth(c.type));
  const bodyWidth = ROW_NUM_WIDTH + widths.reduce((w, x) => w + x, 0);

  const copyValue = (rowIndex: number, colIndex: number): void => {
    const value = resultSet.rows[rowIndex]?.[colIndex];
    void navigator.clipboard.writeText(
      typeof value === 'string' ? value : JSON.stringify(value) ?? '',
    );
  };

  return (
    <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto" onClick={() => menu && setMenu(null)}>
      <div style={{ width: bodyWidth }}>
        {/* 表头（垂直冻结） */}
        <div
          className="sticky top-0 z-20 flex border-b border-border bg-panel"
          style={{ height: ROW_HEIGHT }}
          role="row"
        >
          <div
            className="sticky left-0 z-30 flex shrink-0 items-center border-r border-border bg-panel px-2 text-muted-foreground"
            style={{ width: ROW_NUM_WIDTH }}
          >
            #
          </div>
          {resultSet.columns.map((col, i) => (
            <div
              key={`${col.name}:${i}`}
              role="columnheader"
              className="flex shrink-0 select-none items-center overflow-hidden border-r border-border px-2 text-left text-[13px] font-semibold text-panel-foreground"
              style={{ width: widths[i] }}
              title={col.name}
            >
              <span className="truncate">{col.name}</span>
            </div>
          ))}
        </div>

        {/* 行窗口（虚拟滚动） */}
        <div style={{ position: 'relative', height: resultSet.rowCount * ROW_HEIGHT }}>
          {virtualizer.getVirtualItems().map((virtualRow) => {
            const rowIndex = virtualRow.index;
            const row = resultSet.rows[rowIndex] ?? [];
            return (
              <div
                key={virtualRow.key}
                role="row"
                aria-rowindex={rowIndex + 1}
                className="absolute left-0 flex hover:bg-row-hover"
                style={{ top: virtualRow.start, height: ROW_HEIGHT, width: bodyWidth }}
              >
                <div
                  className="sticky left-0 z-10 flex shrink-0 items-center justify-end border-r border-border bg-background px-2 text-[12px] text-muted-foreground"
                  style={{ width: ROW_NUM_WIDTH }}
                >
                  {rowIndex + 1}
                </div>
                {resultSet.columns.map((col, colIdx) => {
                  const view = cellView(row[colIdx], col.type);
                  return (
                    <div
                      key={`${rowIndex}:${col.name}:${colIdx}`}
                      role="gridcell"
                      className="flex shrink-0 items-center overflow-hidden border-r border-border px-2 text-[13px]"
                      style={{ width: widths[colIdx] }}
                      title={view.title}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        setMenu({
                          x: e.clientX,
                          y: e.clientY,
                          items: [
                            {
                              key: 'copy',
                              label: '复制值',
                              onSelect: () => copyValue(rowIndex, colIdx),
                            },
                            {
                              key: 'copy-row',
                              label: '复制行 JSON',
                              onSelect: () =>
                                void navigator.clipboard.writeText(
                                  JSON.stringify(
                                    Object.fromEntries(resultSet.columns.map((c, i) => [c.name, row[i]])),
                                  ),
                                ),
                            },
                          ],
                        });
                      }}
                    >
                      <div className={`truncate ${view.className ?? ''}`}>
                        {planLevels?.[rowIndex] !== undefined && colIdx === 0 && (
                          <span aria-hidden className="whitespace-pre text-muted-foreground">
                            {explainIndentPrefix(planLevels[rowIndex] ?? 0)}
                          </span>
                        )}
                        {view.text}
                      </div>
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </div>
  );
}
