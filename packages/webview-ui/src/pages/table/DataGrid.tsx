import {
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
} from '@tanstack/react-table';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useEffect, useMemo, useRef, useState } from 'react';
import { cellView } from '../../lib/cellDisplay';
import { applyOverlay } from '../../lib/editOverlay';
import { cellInputText } from '../../lib/editValues';
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

interface MenuItem {
  key: string;
  label: string;
  disabled?: boolean;
  onSelect: () => void;
}

/** 轻量右键菜单（fixed 定位；Esc/点击外部关闭） */
function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);
  return (
    <div
      ref={ref}
      role="menu"
      className="fixed z-[70] min-w-36 rounded-sm border border-border bg-panel py-1 text-[12px] shadow-lg"
      style={{ left: x, top: y }}
    >
      {items.map((item) => (
        <button
          key={item.key}
          type="button"
          role="menuitem"
          disabled={item.disabled}
          className="block w-full truncate px-3 py-1 text-left hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
          onClick={() => {
            onClose();
            item.onSelect();
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

/**
 * 虚拟滚动数据网格（概要设计 5.4.4：只渲染可视区行；交互稿 §11 role=grid）。
 * M4：双击/Enter/F2 进入编辑、Esc 取消、Enter 下移、Tab 右移；
 * 视觉：已修改黄底+黄三角、新增行绿底、删除行红斜线、错误行红条（§4.2）。
 */
export function DataGrid({ pageOffset }: { pageOffset: number }) {
  const columns = useTableStore((s) => s.columns);
  const rows = useTableStore((s) => s.rows);
  const sorts = useTableStore((s) => s.sorts);
  const toggleSort = useTableStore((s) => s.toggleSort);
  const inserts = useTableStore((s) => s.inserts);
  const editEnabled = useTableStore((s) => s.editEnabled);
  const editing = useTableStore((s) => s.editing);
  const rowErrors = useTableStore((s) => s.rowErrors);
  const primaryKey = useTableStore((s) => s.primaryKey);
  const beginEdit = useTableStore((s) => s.beginEdit);
  const confirmEdit = useTableStore((s) => s.confirmEdit);
  const cancelEdit = useTableStore((s) => s.cancelEdit);
  const rowEditState = useTableStore((s) => s.rowEditState);
  const setCellNull = useTableStore((s) => s.setCellNull);
  const setCellEmpty = useTableStore((s) => s.setCellEmpty);
  const markDeleteRow = useTableStore((s) => s.markDeleteRow);
  const unmarkDeleteRow = useTableStore((s) => s.unmarkDeleteRow);
  const revertRowByIndex = useTableStore((s) => s.revertRowByIndex);
  const removeInsertRow = useTableStore((s) => s.removeInsertRow);

  const scrollRef = useRef<HTMLDivElement>(null);
  const [sizing, setSizing] = useState<Record<string, number>>({});
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [editText, setEditText] = useState('');
  // 订阅覆盖层（rowEditState 经 get() 读取，不自动触发重渲染）
  useTableStore((s) => s.updates);
  useTableStore((s) => s.deletes);

  const totalRows = rows.length + inserts.length;

  // 进入编辑态时初始化输入文本（NULL/对象按展示语义还原）
  useEffect(() => {
    if (editing) {
      setEditText(cellInputText(useTableStore.getState().effectiveValue(editing.rowIndex, editing.colIndex)));
    }
  }, [editing]);

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
    count: totalRows,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: OVERSCAN,
  });

  const headerCells = table.getHeaderGroups()[0]?.headers ?? [];
  const bodyWidth = ROW_NUM_WIDTH + headerCells.reduce((w, h) => w + h.getSize(), 0);

  /** 确认并按方向移动（交互稿 §4.3：Enter 下移、Tab 右移） */
  const confirmAndMove = (dRow: number, dCol: number): void => {
    if (!editing) {
      return;
    }
    const { rowIndex, colIndex } = editing;
    confirmEdit(editText);
    const still = useTableStore.getState().editing;
    if (still) {
      return; // 校验失败：留在当前编辑态
    }
    const nextRow = rowIndex + dRow;
    const nextCol = colIndex + dCol;
    if (nextRow >= 0 && nextRow < totalRows && nextCol >= 0 && nextCol < columns.length) {
      beginEdit(nextRow, nextCol);
    }
  };

  const cellMenuItems = (rowIndex: number, colIndex: number): MenuItem[] => {
    const value = useTableStore.getState().effectiveValue(rowIndex, colIndex);
    const items: MenuItem[] = [
      { key: 'edit', label: '编辑', disabled: !editEnabled, onSelect: () => beginEdit(rowIndex, colIndex) },
    ];
    if (value !== null) {
      items.push({ key: 'null', label: '设为 NULL', disabled: !editEnabled, onSelect: () => setCellNull(rowIndex, colIndex) });
    }
    if (value === null) {
      items.push({ key: 'empty', label: '设为空串', disabled: !editEnabled, onSelect: () => setCellEmpty(rowIndex, colIndex) });
    }
    items.push({
      key: 'copy',
      label: '复制值',
      onSelect: () => {
        void navigator.clipboard.writeText(typeof value === 'string' ? value : JSON.stringify(value));
      },
    });
    return items;
  };

  const rowNumMenuItems = (rowIndex: number): MenuItem[] => {
    if (rowIndex >= rows.length) {
      const tempId = inserts[rowIndex - rows.length]?.tempId;
      return [
        {
          key: 'drop',
          label: '移除新增行',
          disabled: !editEnabled,
          onSelect: () => tempId && removeInsertRow(tempId),
        },
      ];
    }
    const kind = rowEditState(rowIndex).kind;
    return [
      { key: 'delete', label: '标记删除', disabled: !editEnabled || kind === 'deleted', onSelect: () => markDeleteRow(rowIndex) },
      { key: 'undelete', label: '撤销删除', disabled: !editEnabled || kind !== 'deleted', onSelect: () => unmarkDeleteRow(rowIndex) },
      { key: 'revert', label: '放弃该行修改', disabled: !editEnabled || kind === 'normal', onSelect: () => revertRowByIndex(rowIndex) },
    ];
  };

  return (
    <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto" onClick={() => menu && setMenu(null)}>
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

        {/* 行窗口（虚拟滚动；含插入行） */}
        <div style={{ position: 'relative', height: totalRows * ROW_HEIGHT }}>
          {virtualizer.getVirtualItems().map((virtualRow) => {
            const rowIndex = virtualRow.index;
            const isInsert = rowIndex >= rows.length;
            const insertData = isInsert ? inserts[rowIndex - rows.length] : undefined;
            const editState = rowEditState(rowIndex);
            const error = !isInsert ? rowErrors[rowKeyForRow(rowIndex)] : undefined;
            const displayRow = isInsert
              ? columns.map((c) => (c.name in insertData!.values ? insertData!.values[c.name] : null))
              : editState.kind === 'updated'
                ? applyOverlay(rows[rowIndex], columns, editState.overlay)
                : rows[rowIndex];
            return (
              <div
                key={virtualRow.key}
                role="row"
                aria-rowindex={rowIndex + 1}
                className={`absolute left-0 flex ${isInsert ? 'bg-insert-bg' : editState.kind === 'deleted' ? 'bg-delete-bg' : 'hover:bg-row-hover'} ${error ? 'border-l-2 border-destructive' : ''}`}
                style={{
                  top: virtualRow.start,
                  height: ROW_HEIGHT,
                  width: bodyWidth,
                }}
              >
                <div
                  role="gridcell"
                  className={`sticky left-0 z-10 flex shrink-0 items-center justify-end gap-1 border-r border-border px-2 text-[12px] text-muted-foreground ${isInsert ? 'bg-insert-bg' : editState.kind === 'deleted' ? 'bg-delete-bg' : 'bg-background'}`}
                  style={{ width: ROW_NUM_WIDTH }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setMenu({ x: e.clientX, y: e.clientY, items: rowNumMenuItems(rowIndex) });
                  }}
                >
                  {isInsert ? (
                    <span title="新增行（未落库）" className="text-success">＋</span>
                  ) : editState.kind === 'deleted' ? (
                    <button
                      type="button"
                      className="text-destructive"
                      title="撤销删除"
                      onClick={() => unmarkDeleteRow(rowIndex)}
                    >
                      ↺
                    </button>
                  ) : null}
                  <span className={editState.kind === 'deleted' ? 'line-through' : ''}>
                    {pageOffset + rowIndex + 1}
                  </span>
                  {error && (
                    <span title={error.message} className="text-destructive">⚠</span>
                  )}
                </div>
                {columns.map((col, cellIdx) => {
                  const type = col.type;
                  const colName = col.name;
                  const value = displayRow[cellIdx];
                  const view = cellView(value, type);
                  const isDirty = editState.kind === 'updated' && editState.overlay?.cells[colName] !== undefined;
                  const isEditing = editing?.rowIndex === rowIndex && editing?.colIndex === cellIdx;
                  return (
                    <div
                      key={`${rowIndex}:${colName}`}
                      role="gridcell"
                      aria-selected={isEditing}
                      className={`relative flex shrink-0 items-center overflow-hidden border-r border-border px-2 text-[13px] ${isDirty ? 'bg-dirty-bg' : ''}`}
                      style={{ width: headerCells[cellIdx]?.getSize() ?? defaultWidth(type) }}
                      title={isDirty ? `${colName}: ${String(editState.overlay!.cells[colName].old)} → ${String(editState.overlay!.cells[colName].new)}` : view.title}
                      onDoubleClick={() => beginEdit(rowIndex, cellIdx)}
                      onKeyDown={(e) => {
                        if (!editEnabled || isEditing) {
                          return;
                        }
                        if (e.key === 'Enter' || e.key === 'F2') {
                          e.preventDefault();
                          beginEdit(rowIndex, cellIdx);
                        }
                      }}
                      tabIndex={editEnabled && !isEditing ? 0 : -1}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        setMenu({ x: e.clientX, y: e.clientY, items: cellMenuItems(rowIndex, cellIdx) });
                      }}
                    >
                      {isEditing ? (
                        <input
                          autoFocus
                          value={editText}
                          aria-label={`编辑 ${colName}`}
                          className="h-full w-full bg-input-bg px-1 font-mono text-[12px] text-input-fg outline-none ring-1 ring-ring"
                          onChange={(e) => setEditText(e.target.value)}
                          onBlur={() => {
                            // 点击其他区域视为取消（Enter/Tab 已在 onKeyDown 处理确认）
                            if (useTableStore.getState().editing) {
                              cancelEdit();
                            }
                          }}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              e.preventDefault();
                              confirmAndMove(1, 0);
                            } else if (e.key === 'Tab') {
                              e.preventDefault();
                              confirmAndMove(0, 1);
                            } else if (e.key === 'Escape') {
                              e.preventDefault();
                              cancelEdit();
                            } else if (e.key === 'ArrowDown') {
                              e.preventDefault();
                              confirmAndMove(1, 0);
                            } else if (e.key === 'ArrowUp') {
                              e.preventDefault();
                              confirmAndMove(-1, 0);
                            }
                          }}
                        />
                      ) : (
                        <div className={`truncate ${view.className ?? ''} ${editState.kind === 'deleted' ? 'line-through opacity-70' : ''}`}>
                          {view.text}
                        </div>
                      )}
                      {isDirty && (
                        <span
                          aria-hidden
                          title="已修改"
                          className="pointer-events-none absolute right-0 top-0 h-0 w-0 border-r-[9px] border-t-[9px] border-r-transparent border-t-warning"
                        />
                      )}
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

  /** 行 → RowKey 字符串（错误定位与视觉判断） */
  function rowKeyForRow(rowIndex: number): string {
    const row = rows[rowIndex];
    if (!row) {
      return '';
    }
    const key: Record<string, unknown> = {};
    for (const name of primaryKey) {
      const i = columns.findIndex((c) => c.name === name);
      if (i >= 0) {
        key[name] = row[i];
      }
    }
    if (Object.keys(key).length === 0) {
      columns.forEach((c, i) => {
        key[c.name] = row[i];
      });
    }
    return JSON.stringify(Object.keys(key).sort().map((k) => [k, key[k]]));
  }
}
