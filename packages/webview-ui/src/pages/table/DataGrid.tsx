import {
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
} from '@tanstack/react-table';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ContextMenu, type ContextMenuItem } from '../../components/ui/contextMenu';
import { cellView } from '../../lib/cellDisplay';
import { viewerKindFor } from '../../lib/cellViewer';
import { applyOverlay } from '../../lib/editOverlay';
import { cellInputText } from '../../lib/editValues';
import { useTableStore } from '../../store/tableStore';

const ROW_HEIGHT = 28;
const ROW_NUM_WIDTH = 56;
const OVERSCAN = 12;

/** 默认列宽按类型区分（概要设计 5.4 布局） */
export function defaultWidth(type: string): number {
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
 * M4：双击/Enter/F2 进入编辑、Esc 取消、Enter 下移、Tab 右移；
 * 视觉：已修改黄底+黄三角、新增行绿底、删除行红斜线、错误行红条（§4.2）。
 */
export function DataGrid({ pageOffset }: { pageOffset: number }) {
  const columns = useTableStore((s) => s.columns);
  const rows = useTableStore((s) => s.rows);
  const sorts = useTableStore((s) => s.sorts);
  const toggleHeaderSort = useTableStore((s) => s.toggleHeaderSort);
  const orderFreeform = useTableStore((s) => s.orderFreeform);
  const inserts = useTableStore((s) => s.inserts);
  const editEnabled = useTableStore((s) => s.editEnabled);
  const editing = useTableStore((s) => s.editing);
  const rowErrors = useTableStore((s) => s.rowErrors);
  const primaryKey = useTableStore((s) => s.primaryKey);
  const beginEdit = useTableStore((s) => s.beginEdit);
  const openCellViewer = useTableStore((s) => s.openCellViewer);
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
  const [menu, setMenu] = useState<{ x: number; y: number; items: ContextMenuItem[] } | null>(null);
  const [editText, setEditText] = useState('');
  // 订阅覆盖层与选中集（rowEditState/selectRow 经 get() 读取，不自动触发重渲染）
  useTableStore((s) => s.updates);
  useTableStore((s) => s.deletes);
  const selectedRows = useTableStore((s) => s.selectedRows);
  const selectRow = useTableStore((s) => s.selectRow);
  const clearSelection = useTableStore((s) => s.clearSelection);
  const markDeleteSelected = useTableStore((s) => s.markDeleteSelected);
  const dragSelectingRef = useRef(false);
  const lastEditCellRef = useRef('');

  const totalRows = rows.length + inserts.length;

  // 拖拽选择：在行首列按住滑动扩展选区，松开结束
  useEffect(() => {
    const stop = (): void => {
      dragSelectingRef.current = false;
    };
    window.addEventListener('mouseup', stop);
    return () => window.removeEventListener('mouseup', stop);
  }, []);

  // 进入编辑态时初始化输入文本（NULL/对象按展示语义还原）；
  // 同一单元格重入（如失焦校验失败后再点回）保留已输入文本
  useEffect(() => {
    if (editing) {
      const cellKey = `${editing.rowIndex}:${editing.colIndex}`;
      if (lastEditCellRef.current !== cellKey) {
        lastEditCellRef.current = cellKey;
        setEditText(cellInputText(useTableStore.getState().effectiveValue(editing.rowIndex, editing.colIndex)));
      }
    } else {
      lastEditCellRef.current = '';
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

  const cellMenuItems = (rowIndex: number, colIndex: number): ContextMenuItem[] => {
    const value = useTableStore.getState().effectiveValue(rowIndex, colIndex);
    const items: ContextMenuItem[] = [
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

  const rowNumMenuItems = (rowIndex: number): ContextMenuItem[] => {
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
      {
        key: 'revert-all',
        label: '撤销全部变更',
        disabled: !editEnabled || useTableStore.getState().committing || useTableStore.getState().editCount().total === 0,
        onSelect: () => void useTableStore.getState().revertAll(),
      },
    ];
  };

  return (
    <div
      ref={scrollRef}
      className="min-h-0 flex-1 overflow-auto"
      onClick={() => menu && setMenu(null)}
      onKeyDown={(e) => {
        // 交互稿 §4.3：Delete 标记删除选中行；Esc 取消选择
        if (e.key === 'Delete' && Object.keys(selectedRows).length > 0) {
          e.preventDefault();
          markDeleteSelected();
        } else if (e.key === 'Escape') {
          clearSelection();
        }
      }}
    >
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
                className={`group relative flex shrink-0 select-none items-center justify-between gap-1 overflow-hidden border-r border-border px-2 text-left text-[13px] font-semibold text-panel-foreground ${orderFreeform ? 'cursor-default' : 'cursor-pointer hover:bg-accent'}`}
                style={{ width: header.getSize() }}
                onClick={() => toggleHeaderSort(header.id)}
                title={orderFreeform ? '自定义 ORDER BY 表达式生效中，列头排序已停用（清空输入框后可用）' : `按 ${header.id} 排序`}
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
            const rowKeyStr = isInsert ? '' : rowKeyForRow(rowIndex);
            const isSelected = !isInsert && Boolean(selectedRows[rowKeyStr]);
            return (
              <div
                key={virtualRow.key}
                role="row"
                aria-rowindex={rowIndex + 1}
                className={`absolute left-0 flex ${isInsert ? 'bg-insert-bg' : editState.kind === 'deleted' ? 'bg-delete-bg' : isSelected ? 'bg-row-selected' : 'hover:bg-row-hover'} ${error ? 'border-l-2 border-destructive' : ''}`}
                style={{
                  top: virtualRow.start,
                  height: ROW_HEIGHT,
                  width: bodyWidth,
                }}
                // 行选择（交互稿 §4.3 v0.1.2）：任意单元格可选中；新单击覆盖已有选择
                onMouseDown={(e) => {
                  if (isInsert || e.button !== 0 || (e.target as HTMLElement).closest('button, input')) {
                    return; // ↺ 等按钮与编辑输入框不触发选择
                  }
                  dragSelectingRef.current = true;
                  selectRow(rowIndex, e.shiftKey ? 'extend' : e.ctrlKey || e.metaKey ? 'toggle' : 'replace');
                }}
                onMouseEnter={() => {
                  if (dragSelectingRef.current && !isInsert) {
                    selectRow(rowIndex, 'extend');
                  }
                }}
              >
                <div
                  role="gridcell"
                  aria-selected={isSelected}
                  /* 粘性行号必须不透明遮挡横向滚过的列：以 bg-background 打底，
                     状态染色（半透明 token）经第二层叠加，避免选中/新增/删除行时透出下层列 */
                  className={`sticky left-0 z-10 flex shrink-0 items-center justify-end gap-1 border-r border-border px-2 text-[12px] text-muted-foreground bg-background ${!isInsert ? 'cursor-pointer select-none' : ''}`}
                  style={{
                    width: ROW_NUM_WIDTH,
                    backgroundImage: isInsert
                      ? 'linear-gradient(var(--color-insert-bg), var(--color-insert-bg))'
                      : editState.kind === 'deleted'
                        ? 'linear-gradient(var(--color-delete-bg), var(--color-delete-bg))'
                        : isSelected
                          ? 'linear-gradient(var(--color-row-selected), var(--color-row-selected))'
                          : undefined,
                  }}
                  title={!isInsert ? '点击选择行（拖拽/Shift 范围选 · Ctrl 增删 · Esc 取消）' : undefined}
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
                          /* 铺满单元格（absolute 覆盖含父级 px-2 的内边距区），
                             字号/内边距与展示态一致——避免进入编辑时文本跳动"闪烁" */
                          className="absolute inset-0 bg-input-bg px-2 text-[13px] text-input-fg caret-ring outline-none"
                          onChange={(e) => setEditText(e.target.value)}
                          onBlur={() => {
                            // 失焦即记录（评审反馈：输入后不必按 Enter）；
                            // 校验失败时保持编辑态等待修正，Esc 仍是取消
                            if (useTableStore.getState().editing) {
                              confirmEdit(editText);
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
                      {/* 值查看器入口（交互稿 §4.6）：binary/json 类型或超长文本；新增行无 RowKey 不开 */}
                      {!isEditing && rowIndex < rows.length && viewerKindFor(type, value) !== null && (
                        <button
                          type="button"
                          aria-label={`查看 ${colName} 完整值`}
                          title="查看完整值"
                          className={`absolute top-0 z-10 rounded-bl-sm bg-panel/80 px-1 text-[10px] leading-4 text-muted-foreground hover:text-foreground ${
                            isDirty ? 'right-2.5' : 'right-0'
                          }`}
                          onMouseDown={(e) => e.stopPropagation()}
                          onClick={(e) => {
                            e.stopPropagation();
                            openCellViewer(rowIndex, cellIdx);
                          }}
                        >
                          ▤
                        </button>
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
