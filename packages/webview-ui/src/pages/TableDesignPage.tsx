import { useEffect, useRef, useState } from 'react';
import type { DataTypeOptionPayload, ForeignKeySpecPayload } from '@db-explorer/protocol';

type FkAction = NonNullable<ForeignKeySpecPayload['onDelete']>;
import { Button } from '../components/ui/button';
import { Popover } from '../components/ui/popover';
import { highlightSql } from '../lib/sqlHighlight';
import {
  columnNameError,
  columnTypeError,
  destructiveCount,
  fkRowError,
  idxRowError,
  ukRowError,
} from '../lib/tableDesign';
import { caretPosFor, fillValueOf, filterDataTypeOptions, movedHighlight } from '../lib/typeSuggest';
import { useTableDesignStore, type DesignTab } from '../store/tableDesignStore';

/**
 * 表结构编辑器（M8-B2，交互稿 §12；Tab 化为表设计器批次 B §12.1~12.8）：
 * 新建表与修改表结构共用，按 Tab 组织——列 / 键 / 外键 / 索引（按驱动 features 显隐，
 * 缺省回落纯列编辑）。各 Tab 共同编辑同一份 TableSpec；SQL 预览 Modal（destructive 红条）
 * 与危险确认（Host）复用既有链路。
 */

/** 错误位（§12.3）：每行固定预留一条错误行，无错误时空白——行高恒定，输入框不跳动 */
function ErrorSlot({ text }: { text: string | undefined }) {
  return <div className="h-[14px] text-[11px] leading-[14px] text-destructive">{text ?? ''}</div>;
}

/** 类型建议输入（§12.3 可输入+建议下拉）：保持自由输入，聚焦弹方言词表建议；
 *  词表为空（驱动未提供）时无感降级为纯手输。建议不是白名单 */
function TypeSuggestInput(props: {
  index: number;
  value: string;
  wordList: DataTypeOptionPayload[];
  disabled?: boolean;
  invalid: boolean;
  onChange(value: string): void;
}) {
  const { index, value, wordList, disabled, invalid, onChange } = props;
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const suggestions = (open && wordList.length > 0 ? filterDataTypeOptions(wordList, value) : []).slice(0, 8);

  const accept = (item: DataTypeOptionPayload) => {
    const fill = fillValueOf(item);
    onChange(fill);
    setOpen(false);
    const el = inputRef.current;
    const pos = caretPosFor(fill);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(pos, pos);
    });
  };

  return (
    <div className="relative">
      <input
        ref={inputRef}
        role="combobox"
        aria-expanded={suggestions.length > 0}
        aria-label={`类型 ${index + 1}`}
        placeholder="varchar(64)"
        className={`h-6 w-full rounded-sm border bg-input px-1.5 ${invalid ? 'border-destructive' : 'border-transparent'}`}
        value={value}
        disabled={disabled}
        onChange={(e) => {
          onChange(e.target.value);
          if (wordList.length > 0) {
            setOpen(true);
          }
        }}
        onFocus={() => {
          if (wordList.length > 0) {
            setOpen(true);
          }
        }}
        onBlur={() => setOpen(false)}
        onKeyDown={(e) => {
          if (!open || suggestions.length === 0) {
            return;
          }
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setHighlight((h) => movedHighlight(h, 1, suggestions.length));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setHighlight((h) => movedHighlight(h, -1, suggestions.length));
          } else if (e.key === 'Enter') {
            e.preventDefault();
            accept(suggestions[Math.min(highlight, suggestions.length - 1)]);
          } else if (e.key === 'Tab') {
            // 回填后焦点照常移动（不 preventDefault）
            accept(suggestions[Math.min(highlight, suggestions.length - 1)]);
          } else if (e.key === 'Escape') {
            setOpen(false); // 仅关建议面板，不影响行内编辑
          }
        }}
      />
      {open && suggestions.length > 0 && (
        <ul
          role="listbox"
          aria-label={`类型建议 ${index + 1}`}
          className="absolute top-full left-0 z-50 mt-0.5 max-h-52 min-w-full overflow-auto rounded-sm border border-border bg-panel py-0.5 shadow-lg"
        >
          {suggestions.map((t, i) => (
            <li key={t.value}>
              <button
                type="button"
                role="option"
                aria-selected={i === highlight}
                className={`flex w-full items-center justify-between gap-3 px-2 py-0.5 text-left text-[12px] ${
                  i === highlight ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50'
                }`}
                // 阻止 mousedown 抢焦点——否则 blur 先关面板、click 落空
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setHighlight(i)}
                onClick={() => accept(t)}
              >
                <span>{t.value}</span>
                {t.template && <span className="text-[11px] text-muted-foreground">{t.template.toLowerCase()}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** 列多选（§12.4~12.6 键/外键/索引共用）：Popover + 复选清单；选项懒加载失败留空可重开重试 */
function ColumnMultiSelect(props: {
  label: string;
  ariaLabel: string;
  options: string[];
  selected: string[];
  disabled?: boolean;
  loading?: boolean;
  onOpen?(): void;
  onChange(columns: string[]): void;
}) {
  const [open, setOpen] = useState(false);
  const toggle = (name: string) => {
    props.onChange(props.selected.includes(name) ? props.selected.filter((c) => c !== name) : [...props.selected, name]);
  };
  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) {
          props.onOpen?.();
        }
      }}
      trigger={
        <Button variant="secondary" size="sm" disabled={props.disabled} aria-label={props.ariaLabel}>
          {props.label}
          {props.selected.length > 0 ? `（${props.selected.length}）` : ''} ▾
        </Button>
      }
    >
      <div className="max-h-56 w-52 overflow-auto p-1" role="group" aria-label={props.ariaLabel}>
        {props.options.length === 0 && (
          <div className="px-2 py-1 text-[12px] text-muted-foreground">{props.loading ? '加载中…' : '（暂无可用列）'}</div>
        )}
        {props.options.map((name) => (
          <label key={name} className="flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1 text-[12px] hover:bg-accent">
            <input type="checkbox" checked={props.selected.includes(name)} onChange={() => toggle(name)} />
            <span>{name}</span>
          </label>
        ))}
      </div>
    </Popover>
  );
}

/** 行头删除按钮（键/外键/索引行共用） */
function RowDeleteButton({ label, disabled, onClick }: { label: string; disabled?: boolean; onClick(): void }) {
  return (
    <button
      type="button"
      aria-label={label}
      title="删除"
      disabled={disabled}
      className="rounded-sm px-1 text-muted-foreground hover:bg-accent hover:text-destructive disabled:opacity-50"
      onClick={onClick}
    >
      ✕
    </button>
  );
}

export function TableDesignPage() {
  const phase = useTableDesignStore((s) => s.phase);
  const errorMsg = useTableDesignStore((s) => s.errorMsg);
  const kind = useTableDesignStore((s) => s.kind);
  const db = useTableDesignStore((s) => s.db);
  const obj = useTableDesignStore((s) => s.obj);
  const readOnly = useTableDesignStore((s) => s.readOnly);
  const tableName = useTableDesignStore((s) => s.tableName);
  const tableComment = useTableDesignStore((s) => s.tableComment);
  const rows = useTableDesignStore((s) => s.rows);
  const dataTypes = useTableDesignStore((s) => s.dataTypes);
  const features = useTableDesignStore((s) => s.features);
  const activeTab = useTableDesignStore((s) => s.activeTab);
  const ukRows = useTableDesignStore((s) => s.ukRows);
  const fkRows = useTableDesignStore((s) => s.fkRows);
  const idxRows = useTableDesignStore((s) => s.idxRows);
  // P-17：引用表/列缓存是独立切片，必须显式订阅（组件内 getState() 读不触发重渲染）
  const refTables = useTableDesignStore((s) => s.refTables);
  const refColumnsCache = useTableDesignStore((s) => s.refColumnsCache);
  const refColumnsLoading = useTableDesignStore((s) => s.refColumnsLoading);
  const executing = useTableDesignStore((s) => s.executing);
  const preview = useTableDesignStore((s) => s.preview);
  const executeError = useTableDesignStore((s) => s.executeError);
  const toast = useTableDesignStore((s) => s.toast);
  const dirty = useTableDesignStore((s) => s.dirty);

  const setTableName = useTableDesignStore((s) => s.setTableName);
  const setTableComment = useTableDesignStore((s) => s.setTableComment);
  const setActiveTab = useTableDesignStore((s) => s.setActiveTab);
  const editColumn = useTableDesignStore((s) => s.editColumn);
  const addColumn = useTableDesignStore((s) => s.addColumn);
  const removeColumn = useTableDesignStore((s) => s.removeColumn);
  const restoreColumn = useTableDesignStore((s) => s.restoreColumn);
  const editUk = useTableDesignStore((s) => s.editUk);
  const addUk = useTableDesignStore((s) => s.addUk);
  const removeUk = useTableDesignStore((s) => s.removeUk);
  const editFk = useTableDesignStore((s) => s.editFk);
  const addFk = useTableDesignStore((s) => s.addFk);
  const removeFk = useTableDesignStore((s) => s.removeFk);
  const editIdx = useTableDesignStore((s) => s.editIdx);
  const addIdx = useTableDesignStore((s) => s.addIdx);
  const removeIdx = useTableDesignStore((s) => s.removeIdx);
  const loadRefTables = useTableDesignStore((s) => s.loadRefTables);
  const loadRefColumns = useTableDesignStore((s) => s.loadRefColumns);
  const showPreview = useTableDesignStore((s) => s.showPreview);
  const hidePreview = useTableDesignStore((s) => s.hidePreview);
  const execute = useTableDesignStore((s) => s.execute);
  const closePanel = useTableDesignStore((s) => s.closePanel);
  const dismissToast = useTableDesignStore((s) => s.dismissToast);
  const diffText = useTableDesignStore((s) => s.diffText);
  const canExecute = useTableDesignStore((s) => s.canExecute);
  const validationError = useTableDesignStore((s) => s.validationError);
  const tabErrorCount = useTableDesignStore((s) => s.tabErrorCount);
  const focusRowId = useTableDesignStore((s) => s.focusRowId);
  const clearFocus = useTableDesignStore((s) => s.clearFocus);
  const nameInputRefs = useRef(new Map<string, HTMLInputElement>());

  useEffect(() => {
    void useTableDesignStore.getState().bootstrap();
  }, []);

  // §12 修订：编辑列/新增列入口打开时聚焦到指定列的列名输入框（滚动可见），聚焦后清除状态
  useEffect(() => {
    if (!focusRowId) {
      return;
    }
    const input = nameInputRefs.current.get(focusRowId);
    if (input) {
      input.scrollIntoView({ block: 'center' });
      input.focus();
      input.select();
      clearFocus();
    }
  }, [focusRowId, rows, clearFocus]);

  // §12.5：进入外键 Tab 时懒拉引用表清单（失败无感降级）
  useEffect(() => {
    if (activeTab === 'fks') {
      void loadRefTables();
    }
  }, [activeTab, loadRefTables]);

  if (phase === 'loading') {
    return <div className="flex h-screen items-center justify-center text-muted-foreground">加载中…</div>;
  }
  if (phase === 'error') {
    return <div className="flex h-screen items-center justify-center text-destructive">{errorMsg}</div>;
  }

  const activeColumns = rows.filter((r) => !r.deleted && r.col.name.trim()).map((r) => r.col.name.trim());
  const foreignKeyAlterable = features?.foreignKeyAlter !== false;
  // §12.2 能力矩阵：外键 alter 无原地语法（SQLite）→ alter 态外键 Tab 只读 + 黄条提示
  const fkReadOnly = kind === 'alter' && !foreignKeyAlterable;

  const tabs: Array<{ id: DesignTab; label: string; visible: boolean }> = [
    { id: 'columns', label: '列', visible: true },
    { id: 'keys', label: '键', visible: true },
    { id: 'fks', label: '外键', visible: features?.foreignKeys === true },
    { id: 'indexes', label: '索引', visible: features?.indexes === true },
  ];

  const formWrap = 'mx-auto flex h-full max-w-5xl flex-col gap-3 px-6 py-4';

  return (
    <div className="h-screen overflow-hidden bg-background text-panel-foreground">
      <div className={formWrap}>
        {/* 标题行 */}
        <div className="flex shrink-0 items-center gap-2 text-[15px] font-medium">
          {kind === 'create' ? '新建表' : '修改表结构'}
          <span className="text-[12px] text-muted-foreground">@ {db}{obj ? ` · ${obj}` : ''}</span>
          {readOnly && <span className="rounded-sm bg-muted px-1.5 text-[11px] text-muted-foreground">只读连接，执行被拒绝</span>}
          {dirty && <span className="text-[11px] text-warning">未保存</span>}
        </div>

        {/* 表选项（§12.1） */}
        <div className="flex shrink-0 items-center gap-4">
          <label className="flex items-center gap-2 text-[12px]">
            <span className="text-muted-foreground">表名<span className="text-destructive">*</span></span>
            <input
              aria-label="表名"
              className="h-7 w-52 rounded-sm border border-border bg-input px-2 text-[13px]"
              value={tableName}
              disabled={executing}
              onChange={(e) => setTableName(e.target.value)}
            />
          </label>
          <label className="flex min-w-0 flex-1 items-center gap-2 text-[12px]">
            <span className="shrink-0 text-muted-foreground">注释</span>
            <input
              aria-label="表注释"
              className="h-7 w-full rounded-sm border border-border bg-input px-2 text-[13px]"
              value={tableComment}
              disabled={executing}
              onChange={(e) => setTableComment(e.target.value)}
            />
          </label>
        </div>

        {/* Tab 栏（§12.1；校验失败的 Tab 标题旁红点，§12.7） */}
        <div className="flex shrink-0 items-center gap-1 border-b border-border" role="tablist" aria-label="表结构编辑分区">
          {tabs
            .filter((t) => t.visible)
            .map((t) => {
              const errCount = tabErrorCount(t.id);
              return (
                <button
                  key={t.id}
                  type="button"
                  role="tab"
                  aria-selected={activeTab === t.id}
                  className={`flex items-center gap-1 rounded-t-sm px-3 py-1.5 text-[13px] ${
                    activeTab === t.id ? 'border-x border-t border-border bg-panel font-medium' : 'text-muted-foreground hover:bg-accent'
                  }`}
                  onClick={() => setActiveTab(t.id)}
                >
                  {t.label}
                  {errCount > 0 && (
                    <span aria-label={`${t.label}分区有 ${errCount} 项校验错误`} className="inline-block h-1.5 w-1.5 rounded-full bg-destructive" />
                  )}
                </button>
              );
            })}
        </div>

        {/* 内容区（§12.3~§12.6） */}
        <div className="min-h-0 flex-1 overflow-auto rounded-sm border border-border bg-panel">
          {activeTab === 'columns' && (
            <table className="w-full text-[13px]">
              <thead className="sticky top-0 bg-panel text-left text-[12px] text-muted-foreground">
                <tr>
                  <th className="w-8 px-2 py-1.5 font-normal">#</th>
                  <th className="px-2 py-1.5 font-normal">列名</th>
                  <th className="px-2 py-1.5 font-normal">类型</th>
                  <th className="w-24 px-2 py-1.5 font-normal">NULL</th>
                  <th className="w-16 px-2 py-1.5 font-normal">主键</th>
                  <th className="w-16 px-2 py-1.5 font-normal">自增</th>
                  <th className="px-2 py-1.5 font-normal">默认值</th>
                  <th className="px-2 py-1.5 font-normal">注释</th>
                  <th className="w-10 px-2 py-1.5 font-normal"></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => {
                  const nameErr = columnNameError(r, rows);
                  const typeErr = columnTypeError(r);
                  return (
                    <tr
                      key={r.rowId}
                      data-row={r.rowId}
                      className={`border-t border-border ${r.deleted ? 'bg-destructive/10 opacity-60' : ''}`}
                    >
                      <td className="px-2 py-1 align-top text-muted-foreground">{i + 1}</td>
                      <td className="px-2 py-1 align-top">
                        <input
                          ref={(el) => {
                            if (el) {
                              nameInputRefs.current.set(r.rowId, el);
                            } else {
                              nameInputRefs.current.delete(r.rowId);
                            }
                          }}
                          aria-label={`列名 ${i + 1}`}
                          className={`h-6 w-full rounded-sm border bg-input px-1.5 ${nameErr ? 'border-destructive' : 'border-transparent'}`}
                          value={r.col.name}
                          disabled={executing || r.deleted}
                          onChange={(e) => editColumn(r.rowId, { name: e.target.value })}
                        />
                        <ErrorSlot text={nameErr} />
                      </td>
                      <td className="px-2 py-1 align-top">
                        <TypeSuggestInput
                          index={i}
                          value={r.col.dataType}
                          wordList={dataTypes}
                          disabled={executing || r.deleted}
                          invalid={Boolean(typeErr)}
                          onChange={(dataType) => editColumn(r.rowId, { dataType })}
                        />
                        <ErrorSlot text={typeErr} />
                      </td>
                      <td className="px-2 py-1 align-top">
                        <select
                          aria-label={`NULL ${i + 1}`}
                          className="h-6 w-full rounded-sm border border-transparent bg-input px-1"
                          value={r.col.nullable ? 'null' : 'notnull'}
                          disabled={executing || r.deleted}
                          onChange={(e) => editColumn(r.rowId, { nullable: e.target.value === 'null' })}
                        >
                          <option value="null">NULL</option>
                          <option value="notnull">NOT NULL</option>
                        </select>
                      </td>
                      <td className="px-2 py-1 pt-1.5 text-center align-top">
                        <input
                          type="checkbox"
                          aria-label={`主键 ${i + 1}`}
                          checked={r.col.isPrimaryKey}
                          disabled={executing || r.deleted}
                          onChange={(e) => editColumn(r.rowId, { isPrimaryKey: e.target.checked })}
                        />
                      </td>
                      <td className="px-2 py-1 pt-1.5 text-center align-top">
                        <input
                          type="checkbox"
                          aria-label={`自增 ${i + 1}`}
                          checked={Boolean(r.col.autoIncrement)}
                          disabled={executing || r.deleted}
                          onChange={(e) => editColumn(r.rowId, { autoIncrement: e.target.checked })}
                        />
                      </td>
                      <td className="px-2 py-1 align-top">
                        <input
                          aria-label={`默认值 ${i + 1}`}
                          placeholder="无"
                          className="h-6 w-full rounded-sm border border-transparent bg-input px-1.5"
                          value={r.col.defaultValue ?? ''}
                          disabled={executing || r.deleted}
                          onChange={(e) => editColumn(r.rowId, { defaultValue: e.target.value })}
                        />
                      </td>
                      <td className="px-2 py-1 align-top">
                        <input
                          aria-label={`注释 ${i + 1}`}
                          className="h-6 w-full rounded-sm border border-transparent bg-input px-1.5"
                          value={r.col.comment ?? ''}
                          disabled={executing || r.deleted}
                          onChange={(e) => editColumn(r.rowId, { comment: e.target.value })}
                        />
                      </td>
                      <td className="px-2 py-1 pt-1.5 text-center align-top">
                        {r.deleted ? (
                          <button
                            type="button"
                            aria-label={`撤销删除列 ${i + 1}`}
                            title="撤销删除"
                            className="rounded-sm px-1 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                            onClick={() => restoreColumn(r.rowId)}
                          >
                            ↺
                          </button>
                        ) : (
                          <button
                            type="button"
                            aria-label={`删除列 ${i + 1}`}
                            title="删除该列"
                            disabled={executing}
                            className="rounded-sm px-1 text-muted-foreground hover:bg-accent hover:text-destructive disabled:opacity-50"
                            onClick={() => removeColumn(r.rowId)}
                          >
                            ✕
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}

          {activeTab === 'columns' && (
            <div className="p-2">
              <Button variant="secondary" size="sm" disabled={executing} onClick={() => addColumn()}>
                ＋添加列
              </Button>
            </div>
          )}

          {activeTab === 'keys' && (
            <div className="flex flex-col gap-4 p-3">
              {/* 主键区（§12.4）：与列网格「主键」列同一状态的两个视图 */}
              <section aria-label="主键">
                <div className="mb-1.5 text-[12px] text-muted-foreground">主键（可多选组成复合主键；顺序 = 列序）</div>
                <div className="flex flex-wrap gap-x-4 gap-y-1 rounded-sm border border-border p-2">
                  {activeColumns.length === 0 && <span className="text-[12px] text-muted-foreground">先在「列」Tab 添加并命名列</span>}
                  {rows
                    .filter((r) => !r.deleted)
                    .map((r, i) =>
                      r.col.name.trim() ? (
                        <label key={r.rowId} className="flex items-center gap-1.5 text-[12px]">
                          <input
                            type="checkbox"
                            aria-label={`主键列 ${r.col.name}`}
                            checked={r.col.isPrimaryKey}
                            disabled={executing}
                            onChange={(e) => editColumn(r.rowId, { isPrimaryKey: e.target.checked })}
                          />
                          <span>{r.col.name}</span>
                        </label>
                      ) : (
                        <span key={r.rowId} className="text-[12px] text-muted-foreground">
                          第 {i + 1} 行列名未命名
                        </span>
                      ),
                    )}
                </div>
              </section>

              {features?.uniqueKeys === true && (
                <section aria-label="唯一键">
                  <div className="mb-1.5 flex items-center gap-2">
                    <span className="text-[12px] text-muted-foreground">唯一键（名称留空由驱动自动生成）</span>
                    <Button variant="secondary" size="sm" disabled={executing} onClick={addUk}>
                      ＋添加唯一键
                    </Button>
                  </div>
                  <div className="flex flex-col gap-2">
                    {ukRows.map((r, i) => {
                      const err = ukRowError(r, ukRows);
                      return (
                        <div key={r.rowId} className="flex flex-col gap-0.5 rounded-sm border border-border p-2">
                          <div className="flex items-center gap-2">
                            <span className="shrink-0 text-[12px] text-muted-foreground">名称</span>
                            <input
                              aria-label={`唯一键名 ${i + 1}`}
                              placeholder="uk_…（留空自动生成）"
                              className={`h-6 w-44 rounded-sm border bg-input px-1.5 ${err ? 'border-destructive' : 'border-transparent'}`}
                              value={r.spec.name ?? ''}
                              disabled={executing}
                              onChange={(e) => editUk(r.rowId, { name: e.target.value })}
                            />
                            <ColumnMultiSelect
                              label="列"
                              ariaLabel={`唯一键 ${i + 1} 列选择`}
                              options={activeColumns}
                              selected={r.spec.columns}
                              disabled={executing}
                              onChange={(columns) => editUk(r.rowId, { columns })}
                            />
                            <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
                              {r.spec.columns.length > 0 ? r.spec.columns.join(', ') : '未选择列'}
                            </span>
                            <RowDeleteButton label={`删除唯一键 ${i + 1}`} disabled={executing} onClick={() => removeUk(r.rowId)} />
                          </div>
                          <ErrorSlot text={err} />
                        </div>
                      );
                    })}
                    {ukRows.length === 0 && <span className="text-[12px] text-muted-foreground">暂无唯一键</span>}
                  </div>
                </section>
              )}
            </div>
          )}

          {activeTab === 'fks' && (
            <div className="flex flex-col gap-3 p-3">
              {fkReadOnly && (
                <div className="rounded-sm border border-warning/40 bg-warning/10 px-3 py-2 text-[12px] text-warning">
                  SQLite 不支持原地修改外键；此处只读展示库内现状。可在新建表时声明，或经 SQL Console 重建表
                </div>
              )}
              <div className="flex items-center gap-2">
                <span className="text-[12px] text-muted-foreground">外键（名称留空由驱动自动生成）</span>
                {!fkReadOnly && (
                  <Button variant="secondary" size="sm" disabled={executing} onClick={addFk}>
                    ＋添加外键
                  </Button>
                )}
              </div>
              {fkRows.map((r, i) => {
                const err = fkRowError(r, fkRows);
                const refColumnOptions = refColumnsCache[r.spec.refTable] ?? [];
                const refLoading = Boolean(refColumnsLoading[r.spec.refTable]);
                return (
                  <div key={r.rowId} className="flex flex-col gap-0.5 rounded-sm border border-border p-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="shrink-0 text-[12px] text-muted-foreground">名称</span>
                      <input
                        aria-label={`外键名 ${i + 1}`}
                        placeholder="fk_…（留空自动生成）"
                        className={`h-6 w-40 rounded-sm border bg-input px-1.5 ${err ? 'border-destructive' : 'border-transparent'}`}
                        value={r.spec.name ?? ''}
                        disabled={executing || fkReadOnly}
                        onChange={(e) => editFk(r.rowId, { name: e.target.value })}
                      />
                      <ColumnMultiSelect
                        label="本表列"
                        ariaLabel={`外键 ${i + 1} 本表列选择`}
                        options={activeColumns}
                        selected={r.spec.columns}
                        disabled={executing || fkReadOnly}
                        onChange={(columns) => editFk(r.rowId, { columns })}
                      />
                      <label className="flex items-center gap-1.5 text-[12px]">
                        <span className="text-muted-foreground">引用表</span>
                        <input
                          aria-label={`外键 ${i + 1} 引用表`}
                          list="dbx-ref-tables"
                          placeholder="选择或输入表名"
                          className={`h-6 w-36 rounded-sm border bg-input px-1.5 ${err && !r.spec.refTable.trim() ? 'border-destructive' : 'border-transparent'}`}
                          value={r.spec.refTable}
                          disabled={executing || fkReadOnly}
                          onChange={(e) => {
                            editFk(r.rowId, { refTable: e.target.value, refColumns: [] });
                          }}
                        />
                      </label>
                      <ColumnMultiSelect
                        label="引用列"
                        ariaLabel={`外键 ${i + 1} 引用列选择`}
                        options={refColumnOptions}
                        selected={r.spec.refColumns}
                        disabled={executing || fkReadOnly || !r.spec.refTable.trim()}
                        loading={refLoading}
                        onOpen={() => {
                          if (r.spec.refTable.trim()) {
                            void loadRefColumns(r.spec.refTable.trim());
                          }
                        }}
                        onChange={(refColumns) => editFk(r.rowId, { refColumns })}
                      />
                      <label className="flex items-center gap-1.5 text-[12px]">
                        <span className="text-muted-foreground">ON DELETE</span>
                        <select
                          aria-label={`外键 ${i + 1} ON DELETE`}
                          className="h-6 rounded-sm border border-transparent bg-input px-1"
                          value={r.spec.onDelete ?? ''}
                          disabled={executing || fkReadOnly}
                          onChange={(e) => editFk(r.rowId, { onDelete: (e.target.value || undefined) as FkAction })}
                        >
                          <option value="">（无动作）</option>
                          {(features?.refActions ?? ['RESTRICT', 'CASCADE', 'SET NULL', 'NO ACTION']).map((a) => (
                            <option key={a} value={a}>
                              {a}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="flex items-center gap-1.5 text-[12px]">
                        <span className="text-muted-foreground">ON UPDATE</span>
                        <select
                          aria-label={`外键 ${i + 1} ON UPDATE`}
                          className="h-6 rounded-sm border border-transparent bg-input px-1"
                          value={r.spec.onUpdate ?? ''}
                          disabled={executing || fkReadOnly}
                          onChange={(e) => editFk(r.rowId, { onUpdate: (e.target.value || undefined) as FkAction })}
                        >
                          <option value="">（无动作）</option>
                          {(features?.refActions ?? ['RESTRICT', 'CASCADE', 'SET NULL', 'NO ACTION']).map((a) => (
                            <option key={a} value={a}>
                              {a}
                            </option>
                          ))}
                        </select>
                      </label>
                      {!fkReadOnly && <RowDeleteButton label={`删除外键 ${i + 1}`} disabled={executing} onClick={() => removeFk(r.rowId)} />}
                    </div>
                    <ErrorSlot text={err} />
                  </div>
                );
              })}
              {fkRows.length === 0 && <span className="text-[12px] text-muted-foreground">暂无外键</span>}
              <datalist id="dbx-ref-tables">
                {refTables.map((t) => (
                  <option key={t} value={t} />
                ))}
              </datalist>
            </div>
          )}

          {activeTab === 'indexes' && (
            <div className="flex flex-col gap-3 p-3">
              <div className="flex items-center gap-2">
                <span className="text-[12px] text-muted-foreground">索引（二级索引；唯一约束在「键」Tab 管理。名称留空由驱动自动生成）</span>
                <Button variant="secondary" size="sm" disabled={executing} onClick={addIdx}>
                  ＋添加索引
                </Button>
              </div>
              {idxRows.map((r, i) => {
                const err = idxRowError(r, idxRows);
                const indexTypes = features?.indexTypes ?? [];
                return (
                  <div key={r.rowId} className="flex flex-col gap-0.5 rounded-sm border border-border p-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="shrink-0 text-[12px] text-muted-foreground">名称</span>
                      <input
                        aria-label={`索引名 ${i + 1}`}
                        placeholder="idx_…（留空自动生成）"
                        className={`h-6 w-44 rounded-sm border bg-input px-1.5 ${err ? 'border-destructive' : 'border-transparent'}`}
                        value={r.spec.name ?? ''}
                        disabled={executing}
                        onChange={(e) => editIdx(r.rowId, { name: e.target.value })}
                      />
                      <ColumnMultiSelect
                        label="列"
                        ariaLabel={`索引 ${i + 1} 列选择`}
                        options={activeColumns}
                        selected={r.spec.columns}
                        disabled={executing}
                        onChange={(columns) => editIdx(r.rowId, { columns })}
                      />
                      <label className="flex items-center gap-1.5 text-[12px]">
                        <input
                          type="checkbox"
                          aria-label={`索引 ${i + 1} 唯一`}
                          checked={Boolean(r.spec.unique)}
                          disabled={executing}
                          onChange={(e) => editIdx(r.rowId, { unique: e.target.checked })}
                        />
                        <span className="text-muted-foreground">唯一索引</span>
                      </label>
                      {indexTypes.length > 0 && (
                        <label className="flex items-center gap-1.5 text-[12px]">
                          <span className="text-muted-foreground">类型</span>
                          <select
                            aria-label={`索引 ${i + 1} 类型`}
                            className="h-6 rounded-sm border border-transparent bg-input px-1"
                            value={r.spec.type ?? ''}
                            disabled={executing}
                            onChange={(e) => editIdx(r.rowId, { type: e.target.value || undefined })}
                          >
                            <option value="">（默认）</option>
                            {indexTypes.map((t) => (
                              <option key={t} value={t}>
                                {t}
                              </option>
                            ))}
                          </select>
                        </label>
                      )}
                      <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
                        {r.spec.columns.length > 0 ? r.spec.columns.join(', ') : '未选择列'}
                      </span>
                      <RowDeleteButton label={`删除索引 ${i + 1}`} disabled={executing} onClick={() => removeIdx(r.rowId)} />
                    </div>
                    <ErrorSlot text={err} />
                  </div>
                );
              })}
              {idxRows.length === 0 && <span className="text-[12px] text-muted-foreground">暂无索引</span>}
            </div>
          )}
        </div>

        {/* 变更统计 + 底部操作（§12.1/§12.2/§12.7） */}
        <div className="flex shrink-0 items-center gap-3">
          <span className="text-[12px] text-muted-foreground">{diffText()}</span>
          {validationError() && <span className="text-[12px] text-destructive">{validationError()}</span>}
          <div className="ml-auto flex items-center gap-2">
            <span className="text-[12px] text-muted-foreground">
              {executeError
                ? `第 ${executeError.index} 条语句失败（${executeError.code}），已执行部分不回滚`
                : 'ⓘ 语句由驱动按方言生成，执行前可预览'}
            </span>
            <Button variant="secondary" size="sm" disabled={executing || !canExecute()} onClick={() => void showPreview()}>
              SQL 预览
            </Button>
            <Button size="sm" disabled={executing || !canExecute()} onClick={() => void execute()}>
              {executing ? '执行中…' : '执行'}
            </Button>
            <Button variant="secondary" size="sm" onClick={() => void closePanel()}>
              取消
            </Button>
          </div>
        </div>
      </div>

      {/* SQL 预览 Modal（§5 样式：逐条折叠 + destructive 红条汇总） */}
      {preview && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6" role="dialog" aria-label="SQL 预览">
          <div className="flex max-h-[80vh] w-full max-w-2xl flex-col gap-3 rounded-md border border-border bg-panel p-4 shadow-lg">
            <div className="flex items-center gap-2 text-[14px] font-medium">
              SQL 预览（{preview.statements.length} 条语句）
            </div>
            {destructiveCount(preview.statements) > 0 && (
              <div className="rounded-sm border border-destructive/40 bg-destructive/10 px-3 py-2 text-[12px] text-destructive">
                ⚠ {destructiveCount(preview.statements)} 条语句可能造成数据丢失，请逐条确认
              </div>
            )}
            <div className="min-h-0 flex-1 overflow-auto font-mono text-[12px] leading-5">
              {preview.statements.map((s, i) => (
                <div key={i} className="mb-3">
                  <div
                    className={`whitespace-pre-wrap break-all rounded-sm px-2 py-1.5 ${s.destructive ? 'bg-destructive/10 text-destructive' : 'bg-input/40'}`}
                    dangerouslySetInnerHTML={{ __html: highlightSql(s.sql) }}
                  />
                </div>
              ))}
            </div>
            <div className="flex shrink-0 justify-end gap-2">
              <Button variant="secondary" size="sm" onClick={hidePreview}>
                返回修改
              </Button>
              <Button size="sm" disabled={executing} onClick={() => void execute()}>
                {executing ? '执行中…' : '确认执行'}
              </Button>
            </div>
          </div>
        </div>
      )}

      {toast && (
        <div
          role="status"
          className={`fixed right-3 bottom-3 z-60 max-w-md rounded-sm border px-3 py-2 text-[12px] shadow-lg ${
            toast.kind === 'error' ? 'border-destructive/40 text-destructive' : 'border-border bg-panel text-panel-foreground'
          }`}
        >
          <span className="min-w-0 break-words">{toast.text}</span>
          <button
            type="button"
            aria-label="关闭提示"
            className="ml-2 text-muted-foreground hover:text-foreground"
            onClick={dismissToast}
          >
            ✕
          </button>
        </div>
      )}
    </div>
  );
}
