import { useEffect, useRef, useState } from 'react';
import type { DataTypeOptionPayload, ForeignKeySpecPayload } from '@db-explorer/protocol';

type FkAction = NonNullable<ForeignKeySpecPayload['onDelete']>;
import { Button } from '../components/ui/button';
import { IconInfo } from '../components/ui/icons';
import { Popover } from '../components/ui/popover';
import { highlightSql } from '../lib/sqlHighlight';
import {
  columnNameError,
  columnTypeError,
  destructiveCount,
  fkNameError,
  fkPairCount,
  fkPairError,
  fkRefTableError,
  idxRowError,
  ukRowError,
} from '../lib/tableDesign';
import { caretPosFor, fillValueOf, filterDataTypeOptions, movedHighlight } from '../lib/typeSuggest';
import { t } from '../lib/i18n';
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
        aria-label={t('design.ariaTypeN', [index + 1])}
        placeholder="varchar(64)"
        className={`h-6 w-full rounded-sm border bg-input px-1.5 ${invalid ? 'border-destructive' : 'border-border'}`}
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
          aria-label={t('design.ariaTypeSuggestN', [index + 1])}
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

/** 引用表输入（§12.5 修订二稿：输入与选择统一为单控件——聚焦弹主题化表清单、键入过滤、
 *  点击/Enter 回填，与类型建议输入同款交互；清单懒加载失败无感降级为纯手输） */
function RefTableInput(props: {
  index: number;
  value: string;
  tables: string[];
  loading: boolean;
  disabled?: boolean;
  invalid: boolean;
  onOpen(): void;
  onChange(value: string): void;
}) {
  const { index, value, tables, loading, disabled, invalid, onOpen, onChange } = props;
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const kw = value.trim().toLowerCase();
  const suggestions = (open ? tables.filter((t) => !kw || t.toLowerCase().includes(kw)) : []).slice(0, 8);

  const accept = (name: string) => {
    onChange(name);
    setOpen(false);
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  return (
    <div className="relative">
      <input
        ref={inputRef}
        role="combobox"
        aria-expanded={suggestions.length > 0}
        aria-label={t('design.ariaFkNRefTable', [index + 1])}
        placeholder={t('design.refTablePlaceholder')}
        className={`h-6 w-36 rounded-sm border bg-input px-1.5 ${invalid ? 'border-destructive' : 'border-border'}`}
        value={value}
        disabled={disabled}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
        }}
        onFocus={() => {
          setOpen(true);
          onOpen();
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
          } else if (e.key === 'Escape') {
            setOpen(false);
          }
        }}
      />
      {open && (
        <ul
          role="listbox"
          aria-label={t('design.ariaFkNRefTableList', [index + 1])}
          className="absolute top-full left-0 z-50 mt-0.5 min-w-full overflow-auto rounded-sm border border-border bg-panel py-0.5 shadow-lg"
        >
          {suggestions.length === 0 && (
            <li className="px-2 py-1 text-[11px] text-muted-foreground">{loading ? t('common.loading') : t('design.emptyRefTableList')}</li>
          )}
          {suggestions.map((t, i) => (
            <li key={t}>
              <button
                type="button"
                role="option"
                aria-selected={i === highlight}
                className={`flex w-full items-center gap-2 px-2 py-0.5 text-left text-[12px] ${
                  i === highlight ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50'
                }`}
                // 阻止 mousedown 抢焦点——否则 blur 先关面板、click 落空
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setHighlight(i)}
                onClick={() => accept(t)}
              >
                <span>{t}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** 列选择（§12.4~12.6 键/外键/索引共用）：Popover + 清单；multiple=true 复选（键/索引），
 *  单选模式点击即选并关闭（外键列对应行，§12.5 修订）。选项懒加载失败留空可重开重试 */
function ColumnMultiSelect(props: {
  label: string;
  ariaLabel: string;
  options: string[];
  selected: string[];
  multiple?: boolean;
  disabled?: boolean;
  loading?: boolean;
  placeholder?: string;
  onOpen?(): void;
  onChange(columns: string[]): void;
}) {
  const [open, setOpen] = useState(false);
  const single = props.multiple !== true;
  const toggle = (name: string) => {
    if (single) {
      props.onChange([name]);
      setOpen(false);
      return;
    }
    props.onChange(props.selected.includes(name) ? props.selected.filter((c) => c !== name) : [...props.selected, name]);
  };
  const triggerLabel = single
    ? props.selected[0]
      ? props.selected[0]
      : (props.placeholder ?? props.label)
    : `${props.label}${props.selected.length > 0 ? t('design.selectedCount', [props.selected.length]) : ''}`;
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
        <Button
          variant="secondary"
          size="sm"
          disabled={props.disabled}
          aria-label={props.ariaLabel}
          className={single && props.selected[0] ? 'max-w-44' : ''}
        >
          <span className="max-w-40 truncate">{triggerLabel}</span> ▾
        </Button>
      }
    >
      <div className="max-h-56 w-52 overflow-auto p-1" role="group" aria-label={props.ariaLabel}>
        {props.options.length === 0 && (
          <div className="px-2 py-1 text-[12px] text-muted-foreground">{props.loading ? t('common.loading') : t('design.emptyColumns')}</div>
        )}
        {props.options.map((name) =>
          single ? (
            <button
              key={name}
              type="button"
              role="option"
              aria-selected={props.selected[0] === name}
              className="flex w-full cursor-pointer items-center gap-2 rounded-sm px-2 py-1 text-left text-[12px] hover:bg-accent"
              onClick={() => toggle(name)}
            >
              <span className="w-3 text-center text-[11px] text-muted-foreground">{props.selected[0] === name ? '✓' : ''}</span>
              <span className="min-w-0 truncate">{name}</span>
            </button>
          ) : (
            <label key={name} className="flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1 text-[12px] hover:bg-accent">
              <input type="checkbox" checked={props.selected.includes(name)} onChange={() => toggle(name)} />
              <span className="min-w-0 truncate">{name}</span>
            </label>
          ),
        )}
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
      title={t('design.delete')}
      disabled={disabled}
      className="rounded-sm px-1 text-muted-foreground hover:bg-accent hover:text-destructive disabled:opacity-50"
      onClick={onClick}
    >
      ✕
    </button>
  );
}

/** 提示文案的 tips 形式（§12.7 修订：底部说明由长文案改为图标+tooltip，与连接表单 HintTip 同款）：
 *  ⓘ 图标 hover 500ms 后显示气泡（原生 title 延迟不可控，自绘实现） */
function HintTip({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const show = (): void => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setOpen(true), 500);
  };
  const hide = (): void => {
    clearTimeout(timer.current);
    setOpen(false);
  };
  return (
    <span className="relative inline-flex" onMouseEnter={show} onMouseLeave={hide}>
      <span aria-hidden className="inline-flex cursor-help items-center text-muted-foreground hover:text-foreground">
        <IconInfo size={12} />
      </span>
      {open && (
        <span
          role="tooltip"
          className="absolute bottom-full left-1/2 z-50 mb-1 w-max max-w-72 -translate-x-1/2 rounded-sm border border-border bg-[var(--vscode-editorHover-widget-background,#252526)] px-2 py-1 text-left text-[11px] font-normal leading-4 text-foreground shadow-lg"
        >
          {text}
        </span>
      )}
    </span>
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
  const refTablesStatus = useTableDesignStore((s) => s.refTablesStatus);
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
    return <div className="flex h-screen items-center justify-center text-muted-foreground">{t('common.loading')}</div>;
  }
  if (phase === 'error') {
    return <div className="flex h-screen items-center justify-center text-destructive">{errorMsg}</div>;
  }

  const activeColumns = rows.filter((r) => !r.deleted && r.col.name.trim()).map((r) => r.col.name.trim());
  const foreignKeyAlterable = features?.foreignKeyAlter !== false;
  // §12.2 能力矩阵：外键 alter 无原地语法（SQLite）→ alter 态外键 Tab 只读 + 黄条提示
  const fkReadOnly = kind === 'alter' && !foreignKeyAlterable;

  const tabs: Array<{ id: DesignTab; label: string; visible: boolean }> = [
    { id: 'columns', label: t('design.columns'), visible: true },
    { id: 'keys', label: t('design.keys'), visible: true },
    { id: 'fks', label: t('design.foreignKeys'), visible: features?.foreignKeys === true },
    { id: 'indexes', label: t('design.indexes'), visible: features?.indexes === true },
  ];

  const formWrap = 'mx-auto flex h-full max-w-5xl flex-col gap-3 px-6 py-4';

  return (
    <div className="h-screen overflow-hidden bg-background text-panel-foreground">
      <div className={formWrap}>
        {/* 标题行 */}
        <div className="flex shrink-0 items-center gap-2 text-[15px] font-medium">
          {kind === 'create' ? t('design.newTable') : t('design.alterTable')}
          <span className="text-[12px] text-muted-foreground">@ {db}{obj ? ` · ${obj}` : ''}</span>
          {readOnly && <span className="rounded-sm bg-muted px-1.5 text-[11px] text-muted-foreground">{t('design.readOnlyBadge')}</span>}
          {dirty && <span className="text-[11px] text-warning">{t('design.unsaved')}</span>}
        </div>

        {/* 表选项（§12.1） */}
        <div className="flex shrink-0 items-center gap-4">
          <label className="flex items-center gap-2 text-[12px]">
            <span className="text-muted-foreground">{t('design.tableName')}<span className="text-destructive">*</span></span>
            <input
              aria-label={t('design.tableName')}
              className="h-7 w-52 rounded-sm border border-border bg-input px-2 text-[13px]"
              value={tableName}
              disabled={executing}
              onChange={(e) => setTableName(e.target.value)}
            />
          </label>
          <label className="flex min-w-0 flex-1 items-center gap-2 text-[12px]">
            <span className="shrink-0 text-muted-foreground">{t('design.comment')}</span>
            <input
              aria-label={t('design.tableComment')}
              className="h-7 w-full rounded-sm border border-border bg-input px-2 text-[13px]"
              value={tableComment}
              disabled={executing}
              onChange={(e) => setTableComment(e.target.value)}
            />
          </label>
        </div>

        {/* Tab 栏（§12.1；校验失败的 Tab 标题旁红点，§12.7） */}
        <div className="flex shrink-0 items-center gap-1 border-b border-border" role="tablist" aria-label={t('design.ariaTabsRegion')}>
          {tabs
            .filter((tab) => tab.visible)
            .map((tab) => {
              const errCount = tabErrorCount(tab.id);
              return (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  aria-selected={activeTab === tab.id}
                  className={`flex items-center gap-1 rounded-t-sm px-3 py-1.5 text-[13px] ${
                    activeTab === tab.id ? 'border-x border-t border-border bg-panel font-medium' : 'text-muted-foreground hover:bg-accent'
                  }`}
                  onClick={() => setActiveTab(tab.id)}
                >
                  {tab.label}
                  {errCount > 0 && (
                    <span aria-label={t('design.ariaTabErrors', [tab.label, errCount])} className="inline-block h-1.5 w-1.5 rounded-full bg-destructive" />
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
                  <th className="px-2 py-1.5 font-normal">{t('design.columnName')}</th>
                  <th className="px-2 py-1.5 font-normal">{t('design.type')}</th>
                  <th className="w-20 px-2 py-1.5 text-center font-normal">{t('design.notNull')}</th>
                  <th className="w-16 px-2 py-1.5 font-normal">{t('design.primaryKey')}</th>
                  <th className="w-16 px-2 py-1.5 font-normal">{t('design.autoIncrement')}</th>
                  <th className="px-2 py-1.5 font-normal">{t('design.defaultValue')}</th>
                  <th className="px-2 py-1.5 font-normal">{t('design.comment')}</th>
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
                          aria-label={t('design.ariaColumnNameN', [i + 1])}
                          className={`h-6 w-full rounded-sm border bg-input px-1.5 ${nameErr ? 'border-destructive' : 'border-border'}`}
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
                      {/* §12.3 修订：NOT NULL 复选（选中 = NOT NULL，不选 = NULL）——勾选语义与主键/自增一致 */}
                      <td className="px-2 py-1 pt-1.5 text-center align-top">
                        <input
                          type="checkbox"
                          aria-label={t('design.ariaNotNullN', [i + 1])}
                          checked={!r.col.nullable}
                          disabled={executing || r.deleted}
                          onChange={(e) => editColumn(r.rowId, { nullable: !e.target.checked })}
                        />
                      </td>
                      <td className="px-2 py-1 pt-1.5 text-center align-top">
                        <input
                          type="checkbox"
                          aria-label={t('design.ariaPrimaryKeyN', [i + 1])}
                          checked={r.col.isPrimaryKey}
                          disabled={executing || r.deleted}
                          onChange={(e) => editColumn(r.rowId, { isPrimaryKey: e.target.checked })}
                        />
                      </td>
                      <td className="px-2 py-1 pt-1.5 text-center align-top">
                        <input
                          type="checkbox"
                          aria-label={t('design.ariaAutoIncrementN', [i + 1])}
                          checked={Boolean(r.col.autoIncrement)}
                          disabled={executing || r.deleted}
                          onChange={(e) => editColumn(r.rowId, { autoIncrement: e.target.checked })}
                        />
                      </td>
                      <td className="px-2 py-1 align-top">
                        <input
                          aria-label={t('design.ariaDefaultValueN', [i + 1])}
                          placeholder={t('design.defaultEmpty')}
                          className="h-6 w-full rounded-sm border border-border bg-input px-1.5"
                          value={r.col.defaultValue ?? ''}
                          disabled={executing || r.deleted}
                          onChange={(e) => editColumn(r.rowId, { defaultValue: e.target.value })}
                        />
                      </td>
                      <td className="px-2 py-1 align-top">
                        <input
                          aria-label={t('design.ariaCommentN', [i + 1])}
                          className="h-6 w-full rounded-sm border border-border bg-input px-1.5"
                          value={r.col.comment ?? ''}
                          disabled={executing || r.deleted}
                          onChange={(e) => editColumn(r.rowId, { comment: e.target.value })}
                        />
                      </td>
                      <td className="px-2 py-1 pt-1.5 text-center align-top">
                        {r.deleted ? (
                          <button
                            type="button"
                            aria-label={t('design.ariaRestoreColumnN', [i + 1])}
                            title={t('design.restoreColumn')}
                            className="rounded-sm px-1 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                            onClick={() => restoreColumn(r.rowId)}
                          >
                            ↺
                          </button>
                        ) : (
                          <button
                            type="button"
                            aria-label={t('design.ariaDeleteColumnN', [i + 1])}
                            title={t('design.deleteColumn')}
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
                {t('design.addColumn')}
              </Button>
            </div>
          )}

          {activeTab === 'keys' && (
            <div className="flex flex-col gap-4 p-3">
              {/* 主键区（§12.4）：与列网格「主键」列同一状态的两个视图 */}
              <section aria-label={t('design.primaryKey')}>
                <div className="mb-1.5 text-[12px] text-muted-foreground">{t('design.pkSectionHint')}</div>
                <div className="flex flex-wrap gap-x-4 gap-y-1 rounded-sm border border-border p-2">
                  {activeColumns.length === 0 && <span className="text-[12px] text-muted-foreground">{t('design.pkEmptyHint')}</span>}
                  {rows
                    .filter((r) => !r.deleted)
                    .map((r, i) =>
                      r.col.name.trim() ? (
                        <label key={r.rowId} className="flex items-center gap-1.5 text-[12px]">
                          <input
                            type="checkbox"
                            aria-label={t('design.ariaPkColumnN', [r.col.name])}
                            checked={r.col.isPrimaryKey}
                            disabled={executing}
                            onChange={(e) => editColumn(r.rowId, { isPrimaryKey: e.target.checked })}
                          />
                          <span>{r.col.name}</span>
                        </label>
                      ) : (
                        <span key={r.rowId} className="text-[12px] text-muted-foreground">
                          {t('design.unnamedColumnRow', [i + 1])}
                        </span>
                      ),
                    )}
                </div>
              </section>

              {features?.uniqueKeys === true && (
                <section aria-label={t('design.uniqueKey')}>
                  <div className="mb-1.5 flex items-center gap-2">
                    <span className="text-[12px] text-muted-foreground">{t('design.ukSectionHint')}</span>
                    <Button variant="secondary" size="sm" disabled={executing} onClick={addUk}>
                      {t('design.addUniqueKey')}
                    </Button>
                  </div>
                  <div className="flex flex-col gap-2">
                    {ukRows.map((r, i) => {
                      const err = ukRowError(r, ukRows);
                      return (
                        <div key={r.rowId} className="flex flex-col gap-0.5 rounded-sm border border-border p-2">
                          <div className="flex items-center gap-2">
                            <span className="shrink-0 text-[12px] text-muted-foreground">{t('design.name')}</span>
                            <input
                              aria-label={t('design.ariaUkNameN', [i + 1])}
                              placeholder={t('design.ukPlaceholder')}
                              className={`h-6 w-44 rounded-sm border bg-input px-1.5 ${err ? 'border-destructive' : 'border-border'}`}
                              value={r.spec.name ?? ''}
                              disabled={executing}
                              onChange={(e) => editUk(r.rowId, { name: e.target.value })}
                            />
                            <ColumnMultiSelect
                              label={t('design.columns')}
                              ariaLabel={t('design.ariaUkColumnsN', [i + 1])}
                              options={activeColumns}
                              selected={r.spec.columns}
                              disabled={executing}
                              onChange={(columns) => editUk(r.rowId, { columns })}
                            />
                            <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
                              {r.spec.columns.length > 0 ? r.spec.columns.join(', ') : t('design.noColumnsSelected')}
                            </span>
                            <RowDeleteButton label={t('design.ariaDeleteUkN', [i + 1])} disabled={executing} onClick={() => removeUk(r.rowId)} />
                          </div>
                          <ErrorSlot text={err} />
                        </div>
                      );
                    })}
                    {ukRows.length === 0 && <span className="text-[12px] text-muted-foreground">{t('design.noUniqueKeys')}</span>}
                  </div>
                </section>
              )}
            </div>
          )}

          {activeTab === 'fks' && (
            <div className="flex flex-col gap-3 p-3">
              {fkReadOnly && (
                <div className="rounded-sm border border-warning/40 bg-warning/10 px-3 py-2 text-[12px] text-warning">
                  {t('design.fkReadOnlyBanner')}
                </div>
              )}
              <div className="flex items-center gap-2">
                <span className="text-[12px] text-muted-foreground">{t('design.fkSectionHint')}</span>
                {!fkReadOnly && (
                  <Button variant="secondary" size="sm" disabled={executing} onClick={addFk}>
                    {t('design.addForeignKey')}
                  </Button>
                )}
              </div>
              {fkRows.map((r, i) => {
                const nameErr = fkNameError(r, fkRows);
                const refTableErr = fkRefTableError(r);
                const refColumnOptions = refColumnsCache[r.spec.refTable] ?? [];
                const refLoading = Boolean(refColumnsLoading[r.spec.refTable]);
                const pairCount = fkPairCount(r);
                const setFkPairSide = (side: 'columns' | 'refColumns', index: number, value: string): void => {
                  const arr = [...r.spec[side]];
                  arr[index] = value;
                  if (side === 'columns') {
                    editFk(r.rowId, { columns: arr });
                  } else {
                    editFk(r.rowId, { refColumns: arr });
                  }
                };
                return (
                  <div key={r.rowId} className="flex flex-col gap-2 rounded-sm border border-border p-2">
                    {/* 第 1 行：名称 + 引用表（§12.5 修订）+ 组级移除（组右上角 ✕） */}
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="shrink-0 text-[12px] text-muted-foreground">{t('design.name')}</span>
                      <input
                        aria-label={t('design.ariaFkNameN', [i + 1])}
                        placeholder={t('design.fkPlaceholder')}
                        className={`h-6 w-40 rounded-sm border bg-input px-1.5 ${nameErr ? 'border-destructive' : 'border-border'}`}
                        value={r.spec.name ?? ''}
                        disabled={executing || fkReadOnly}
                        onChange={(e) => editFk(r.rowId, { name: e.target.value })}
                      />
                      {nameErr && <span className="text-[11px] text-destructive">{nameErr}</span>}
                      <span className="ml-2 shrink-0 text-[12px] text-muted-foreground">{t('design.refTable')}</span>
                      {/* 引用表（§12.5 修订二稿：输入与选择统一为单控件，主题化清单聚焦即弹、可键入过滤/手输） */}
                      <RefTableInput
                        index={i}
                        value={r.spec.refTable}
                        tables={refTables}
                        loading={refTablesStatus === 'loading'}
                        disabled={executing || fkReadOnly}
                        invalid={Boolean(refTableErr)}
                        onOpen={() => void loadRefTables()}
                        onChange={(table) => {
                          editFk(r.rowId, { refTable: table, refColumns: [] });
                        }}
                      />
                      {refTableErr && <span className="text-[11px] text-destructive">{refTableErr}</span>}
                      {!fkReadOnly && (
                        <span className="ml-auto">
                          <RowDeleteButton label={t('design.ariaDeleteFkN', [i + 1])} disabled={executing} onClick={() => removeFk(r.rowId)} />
                        </span>
                      )}
                    </div>

                    {/* 第 2 行：列对应可变数组（本表列 → 引用列一一对应，＋ 增行，§12.5 修订） */}
                    <div className="flex flex-col gap-1 rounded-sm border border-border/60 bg-input/20 p-2">
                      <div className="flex items-center gap-2">
                        <span className="text-[11px] text-muted-foreground">{t('design.fkMappingLabel')}</span>
                        {!fkReadOnly && (
                          <button
                            type="button"
                            aria-label={t('design.ariaFkAddMappingN', [i + 1])}
                            disabled={executing}
                            className="ml-auto rounded-sm px-1.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
                            onClick={() => {
                              editFk(r.rowId, { columns: [...r.spec.columns, ''], refColumns: [...r.spec.refColumns, ''] });
                            }}
                          >
                            {t('design.addMapping')}
                          </button>
                        )}
                      </div>
                      {Array.from({ length: pairCount }, (_, pi) => pi).map((pi) => {
                        const pairErr = fkPairError(r, pi);
                        return (
                          <div key={pi} className="flex flex-wrap items-center gap-2">
                            <ColumnMultiSelect
                              label={t('design.localColumn')}
                              ariaLabel={t('design.ariaFkNMappingLocalM', [i + 1, pi + 1])}
                              options={activeColumns}
                              selected={r.spec.columns[pi] ? [r.spec.columns[pi]] : []}
                              disabled={executing || fkReadOnly}
                              onChange={(cols) => setFkPairSide('columns', pi, cols[0] ?? '')}
                            />
                            <span aria-hidden className="text-[11px] text-muted-foreground">
                              →
                            </span>
                            <ColumnMultiSelect
                              label={t('design.refColumn')}
                              ariaLabel={t('design.ariaFkNMappingRefM', [i + 1, pi + 1])}
                              options={refColumnOptions}
                              selected={r.spec.refColumns[pi] ? [r.spec.refColumns[pi]] : []}
                              disabled={executing || fkReadOnly || !r.spec.refTable.trim()}
                              loading={refLoading}
                              onOpen={() => {
                                if (r.spec.refTable.trim()) {
                                  void loadRefColumns(r.spec.refTable.trim());
                                }
                              }}
                              onChange={(cols) => setFkPairSide('refColumns', pi, cols[0] ?? '')}
                            />
                            {!fkReadOnly && pairCount > 1 && (
                              <button
                                type="button"
                                aria-label={t('design.ariaFkNDeleteMappingM', [i + 1, pi + 1])}
                                title={t('design.deleteMapping')}
                                disabled={executing}
                                className="rounded-sm px-1 text-muted-foreground hover:bg-accent hover:text-destructive disabled:opacity-50"
                                onClick={() => {
                                  editFk(r.rowId, {
                                    columns: r.spec.columns.filter((_, idx) => idx !== pi),
                                    refColumns: r.spec.refColumns.filter((_, idx) => idx !== pi),
                                  });
                                }}
                              >
                                ✕
                              </button>
                            )}
                            {pairErr && <span className="text-[11px] text-destructive">{pairErr}</span>}
                          </div>
                        );
                      })}
                    </div>

                    {/* 第 3 行：动作选项 */}
                    <div className="flex items-center gap-3">
                      <label className="flex items-center gap-1.5 text-[12px]">
                        <span className="text-muted-foreground">{t('design.onDelete')}</span>
                        <select
                          aria-label={t('design.ariaFkOnDeleteN', [i + 1])}
                          className="h-6 rounded-sm border border-border bg-input px-1"
                          value={r.spec.onDelete ?? ''}
                          disabled={executing || fkReadOnly}
                          onChange={(e) => editFk(r.rowId, { onDelete: (e.target.value || undefined) as FkAction })}
                        >
                          <option value="">{t('design.noAction')}</option>
                          {(features?.refActions ?? ['RESTRICT', 'CASCADE', 'SET NULL', 'NO ACTION']).map((a) => (
                            <option key={a} value={a}>
                              {a}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="flex items-center gap-1.5 text-[12px]">
                        <span className="text-muted-foreground">{t('design.onUpdate')}</span>
                        <select
                          aria-label={t('design.ariaFkOnUpdateN', [i + 1])}
                          className="h-6 rounded-sm border border-border bg-input px-1"
                          value={r.spec.onUpdate ?? ''}
                          disabled={executing || fkReadOnly}
                          onChange={(e) => editFk(r.rowId, { onUpdate: (e.target.value || undefined) as FkAction })}
                        >
                          <option value="">{t('design.noAction')}</option>
                          {(features?.refActions ?? ['RESTRICT', 'CASCADE', 'SET NULL', 'NO ACTION']).map((a) => (
                            <option key={a} value={a}>
                              {a}
                            </option>
                          ))}
                        </select>
                      </label>
                    </div>
                  </div>
                );
              })}
              {fkRows.length === 0 && <span className="text-[12px] text-muted-foreground">{t('design.noForeignKeys')}</span>}
            </div>
          )}

          {activeTab === 'indexes' && (
            <div className="flex flex-col gap-3 p-3">
              <div className="flex items-center gap-2">
                <span className="text-[12px] text-muted-foreground">{t('design.idxSectionHint')}</span>
                <Button variant="secondary" size="sm" disabled={executing} onClick={addIdx}>
                  {t('design.addIndex')}
                </Button>
              </div>
              {idxRows.map((r, i) => {
                const err = idxRowError(r, idxRows);
                const indexTypes = features?.indexTypes ?? [];
                return (
                  <div key={r.rowId} className="flex flex-col gap-0.5 rounded-sm border border-border p-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="shrink-0 text-[12px] text-muted-foreground">{t('design.name')}</span>
                      <input
                        aria-label={t('design.ariaIdxNameN', [i + 1])}
                        placeholder={t('design.idxPlaceholder')}
                        className={`h-6 w-44 rounded-sm border bg-input px-1.5 ${err ? 'border-destructive' : 'border-border'}`}
                        value={r.spec.name ?? ''}
                        disabled={executing}
                        onChange={(e) => editIdx(r.rowId, { name: e.target.value })}
                      />
                      <ColumnMultiSelect
                        label={t('design.columns')}
                        ariaLabel={t('design.ariaIdxColumnsN', [i + 1])}
                        options={activeColumns}
                        selected={r.spec.columns}
                        disabled={executing}
                        onChange={(columns) => editIdx(r.rowId, { columns })}
                      />
                      <label className="flex items-center gap-1.5 text-[12px]">
                        <input
                          type="checkbox"
                          aria-label={t('design.ariaIdxUniqueN', [i + 1])}
                          checked={Boolean(r.spec.unique)}
                          disabled={executing}
                          onChange={(e) => editIdx(r.rowId, { unique: e.target.checked })}
                        />
                        <span className="text-muted-foreground">{t('design.uniqueIndex')}</span>
                      </label>
                      {indexTypes.length > 0 && (
                        <label className="flex items-center gap-1.5 text-[12px]">
                          <span className="text-muted-foreground">{t('design.type')}</span>
                          <select
                            aria-label={t('design.ariaIdxTypeN', [i + 1])}
                            className="h-6 rounded-sm border border-border bg-input px-1"
                            value={r.spec.type ?? ''}
                            disabled={executing}
                            onChange={(e) => editIdx(r.rowId, { type: e.target.value || undefined })}
                          >
                            <option value="">{t('design.defaultOption')}</option>
                            {indexTypes.map((t) => (
                              <option key={t} value={t}>
                                {t}
                              </option>
                            ))}
                          </select>
                        </label>
                      )}
                      <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
                        {r.spec.columns.length > 0 ? r.spec.columns.join(', ') : t('design.noColumnsSelected')}
                      </span>
                      <RowDeleteButton label={t('design.ariaDeleteIdxN', [i + 1])} disabled={executing} onClick={() => removeIdx(r.rowId)} />
                    </div>
                    <ErrorSlot text={err} />
                  </div>
                );
              })}
              {idxRows.length === 0 && <span className="text-[12px] text-muted-foreground">{t('design.noIndexes')}</span>}
            </div>
          )}
        </div>

        {/* 变更统计 + 底部操作（§12.1/§12.2/§12.7） */}
        <div className="flex shrink-0 items-center gap-3">
          <span className="text-[12px] text-muted-foreground">{diffText()}</span>
          {validationError() && <span className="text-[12px] text-destructive">{validationError()}</span>}
          <div className="ml-auto flex items-center gap-2">
            {executeError ? (
              <span className="text-[12px] text-destructive">
                {t('design.executeErrorInline', [executeError.index, executeError.code])}
              </span>
            ) : (
              // §12.1 修订：底部说明由长文案改为图标 + tooltip（HoverTip），节省状态行空间
              <HintTip text={t('design.executeHint')} />
            )}
            <Button variant="secondary" size="sm" disabled={executing || !canExecute()} onClick={() => void showPreview()}>
              {t('design.previewSql')}
            </Button>
            <Button size="sm" disabled={executing || !canExecute()} onClick={() => void execute()}>
              {executing ? t('design.executing') : t('design.run')}
            </Button>
            <Button variant="secondary" size="sm" onClick={() => void closePanel()}>
              {t('common.cancel')}
            </Button>
          </div>
        </div>
      </div>

      {/* SQL 预览 Modal（§5 样式：逐条折叠 + destructive 红条汇总） */}
      {preview && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6" role="dialog" aria-label={t('design.previewSql')}>
          <div className="flex max-h-[80vh] w-full max-w-2xl flex-col gap-3 rounded-md border border-border bg-panel p-4 shadow-lg">
            <div className="flex items-center gap-2 text-[14px] font-medium">
              {t('design.previewTitle', [preview.statements.length])}
            </div>
            {destructiveCount(preview.statements) > 0 && (
              <div className="rounded-sm border border-destructive/40 bg-destructive/10 px-3 py-2 text-[12px] text-destructive">
                {t('design.destructiveWarning', [destructiveCount(preview.statements)])}
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
                {t('design.goBack')}
              </Button>
              <Button size="sm" disabled={executing} onClick={() => void execute()}>
                {executing ? t('design.executing') : t('design.confirmRun')}
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
            aria-label={t('design.dismissToast')}
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
