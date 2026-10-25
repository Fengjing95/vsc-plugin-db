import { useEffect, useRef, useState } from 'react';
import type { ExportFormat, ExportScope } from '@db-explorer/protocol';
import { Checkbox } from '../../components/ui/checkbox';
import { Input } from '../../components/ui/input';
import { Menu } from '../../components/ui/menu';
import { Popover } from '../../components/ui/popover';
import { Button } from '../../components/ui/button';
import {
  IconCheck,
  IconColumns,
  IconCopy,
  IconDownload,
  IconEye,
  IconMinus,
  IconPlus,
  IconRefresh,
  IconUndo,
} from '../../components/ui/icons';
import { request } from '../../rpc/client';
import { rowKeyOfRow, rowKeyString } from '../../lib/editOverlay';
import { t } from '../../lib/i18n';
import { useTableStore } from '../../store/tableStore';
import {
  rowsToInList,
  rowsToInsert,
  rowsToJson,
  rowsToMarkdown,
  rowsToTsType,
  type CopyColumn,
} from '../../lib/copyFormats';

/**
 * 工具栏（交互稿 §4.1/概要设计 5.4.2）：标题、编辑操作、搜索、列设置、DDL、导出。
 * 去文本化：操作一律图标按钮，hover 经 title 提示（aria-label 兜底读屏）；
 * 全部统一 secondary 带边框风格，按钮常驻显示，不可用时置灰禁用（不隐藏）。
 */
export function Toolbar({ db, obj, env }: { db: string; obj: string; env: 'dev' | 'test' | 'prod' | null }) {
  const readOnly = useTableStore((s) => s.readOnly);
  const applySearch = useTableStore((s) => s.applySearch);
  const refresh = useTableStore((s) => s.refresh);
  const fetching = useTableStore((s) => s.fetching);
  const runExport = useTableStore((s) => s.runExport);
  const cancelExport = useTableStore((s) => s.cancelExport);
  const exportProgress = useTableStore((s) => s.exportProgress);
  const visibleColumns = useTableStore((s) => s.visibleColumns);
  const setVisibleColumns = useTableStore((s) => s.setVisibleColumns);
  const allColumns = useTableStore((s) => s.allColumns);
  const editEnabled = useTableStore((s) => s.editEnabled);
  const editReason = useTableStore((s) => s.editReason);
  // P-17：计数必须订阅底层切片（editCount() 是 get() 型 action，不触发重渲染）
  const updateCount = useTableStore((s) => Object.keys(s.updates).length);
  const deleteCount = useTableStore((s) => Object.keys(s.deletes).length);
  const insertCount = useTableStore((s) => s.inserts.length);
  const addInsertRow = useTableStore((s) => s.addInsertRow);
  const openPreview = useTableStore((s) => s.openPreview);
  const submitChanges = useTableStore((s) => s.submitChanges);
  const revertSelected = useTableStore((s) => s.revertSelected);
  const openDdl = useTableStore((s) => s.openDdl);
  const previewing = useTableStore((s) => s.previewing);
  const committing = useTableStore((s) => s.committing);
  const selectedCount = useTableStore((s) => Object.keys(s.selectedRows).length);
  // 选中且存在未提交变更的行数（P-17：订阅底层切片本地聚合，不经 action 间接读）
  const selectedDirtyCount = useTableStore((s) => {
    let n = 0;
    for (const key of Object.keys(s.selectedRows)) {
      if (s.updates[key] || s.deletes[key]) {
        n++;
      }
    }
    return n;
  });
  const markDeleteSelected = useTableStore((s) => s.markDeleteSelected);
  const supportsDdl = useTableStore((s) => s.capabilities.supportsDdl);
  const supportsSQL = useTableStore((s) => s.capabilities.supportsSQL);
  // 复制为多种格式（概要 §6 #6）：选中行 × 可见列，webview 内联生成（≤ 单页行数）
  const rows = useTableStore((s) => s.rows);
  const columns = useTableStore((s) => s.columns);
  const allColumnsList = useTableStore((s) => (s.allColumns.length > 0 ? s.allColumns : s.columns));
  const primaryKey = useTableStore((s) => s.primaryKey);

  const [searchText, setSearchText] = useState('');
  const [columnSettingsOpen, setColumnSettingsOpen] = useState(false);
  const [copyHint, setCopyHint] = useState('');
  const copyHintTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    return () => {
      if (debounceRef.current !== undefined) {
        clearTimeout(debounceRef.current);
      }
      if (copyHintTimer.current !== undefined) {
        clearTimeout(copyHintTimer.current);
      }
    };
  }, []);

  const onSearchChange = (text: string) => {
    setSearchText(text);
    if (debounceRef.current !== undefined) {
      clearTimeout(debounceRef.current);
    }
    debounceRef.current = setTimeout(() => {
      void applySearch(text.trim());
    }, 400);
  };

  const onExport = (format: ExportFormat, scope: ExportScope) => {
    void runExport(format, scope);
  };

  const visible = visibleColumns ?? allColumns.map((c) => c.name);
  const visibleSet = new Set(visible);

  // ── 复制为多种格式（概要 §6 #6）：选中行 × 可见列 ──
  const selectedRowsMap = useTableStore((s) => s.selectedRows);

  const onCopyAs = async (format: 'inList' | 'json' | 'markdown' | 'tsType' | 'insert') => {
    // 取数列序：rows 数组按 s.columns 对齐；可见列取值经索引映射
    const idxOf = (name: string) => columns.findIndex((c) => c.name === name);
    const colNames = visible.filter((n) => idxOf(n) >= 0);
    const selected = rows.filter((row) => {
      const key = rowKeyString(rowKeyOfRow(row, columns, primaryKey));
      return Boolean(selectedRowsMap[key]);
    });
    if (selected.length === 0) {
      return;
    }
    let text = '';
    if (format === 'inList') {
      // IN 列表取主键首列（无主键回退首可见列）——选中行 IN 查询的高频复用场景
      const inCol = (primaryKey.length > 0 ? primaryKey[0] : colNames[0]) ?? '';
      const idx = idxOf(inCol);
      if (idx < 0) return;
      text = rowsToInList(selected.map((row) => row[idx]));
    } else if (format === 'json') {
      text = rowsToJson(colNames, selected.map((row) => colNames.map((n) => row[idxOf(n)])));
    } else if (format === 'markdown') {
      text = rowsToMarkdown(colNames, selected.map((row) => colNames.map((n) => row[idxOf(n)])));
    } else if (format === 'tsType') {
      const cols: CopyColumn[] = colNames.map((n) => {
        const meta = allColumnsList.find((c) => c.name === n);
        return { name: n, type: meta?.type ?? 'unknown' };
      });
      text = rowsToTsType(obj, cols);
    } else {
      text = rowsToInsert(obj, colNames, selected.map((row) => colNames.map((n) => row[idxOf(n)])));
    }
    await request('sys.copyText', { text });
    setCopyHint(t('table.toolbar.copiedRows', [selected.length]));
    if (copyHintTimer.current !== undefined) {
      clearTimeout(copyHintTimer.current);
    }
    copyHintTimer.current = setTimeout(() => setCopyHint(''), 2000);
  };

  const toggleColumn = (name: string, show: boolean) => {
    const next = show ? [...visible, name] : visible.filter((c) => c !== name);
    // 保持列定义顺序
    const ordered = allColumns.map((c) => c.name).filter((n) => next.includes(n));
    void setVisibleColumns(ordered.length === allColumns.length ? null : ordered);
  };

  const counts = {
    total: updateCount + deleteCount + insertCount,
    updates: updateCount,
    deletes: deleteCount,
    inserts: insertCount,
  };
  const editBusy = previewing || committing;

  // 图标按钮统一规格：h-7 方形（w-7），图标居中；与文本按钮同高对齐
  const iconBtn = 'w-7 px-0';

  return (
    <div className="flex items-center gap-2 border-b border-border bg-panel px-2 py-1.5">
      <h1 className="shrink-0 text-[13px] font-semibold">
        {obj} <span className="font-normal text-muted-foreground">@ {db}</span>
      </h1>
      {env && (
        <span
          className={`shrink-0 rounded-sm border px-1.5 py-0.5 text-[11px] ${
            env === 'prod' ? 'border-destructive/40 text-destructive' : 'border-border text-muted-foreground'
          }`}
          title={env === 'prod' ? t('table.env.prodTitle') : t('table.env.title', [env])}
        >
          {env === 'prod' ? t('table.env.prod') : env === 'test' ? t('table.env.test') : t('table.env.dev')}
        </span>
      )}
      {(readOnly || !editEnabled) && (
        <span
          className="shrink-0 rounded-sm border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground"
          title={editReason ?? t('table.edit.readOnlyReason')}
        >
          {t('table.env.readOnly')}
        </span>
      )}
      {editEnabled && counts.total > 0 && (
        <span className="shrink-0 text-[11px] text-warning" title={t('table.edit.unsavedTitle')}>
          {t('table.edit.unsavedBadge')}
        </span>
      )}

      {/* 刷新：常驻左侧（标题区之后），图标放大一档；与编辑操作统一 secondary 带边框风格 */}
      <Button
        variant="secondary"
        size="md"
        className="w-8 px-0"
        aria-label={t('table.toolbar.refresh')}
        title={t('table.toolbar.refreshPage')}
        disabled={fetching}
        onClick={() => void refresh()}
      >
        <IconRefresh size={17} />
      </Button>

      {editEnabled && (
        <div className="flex shrink-0 items-center gap-1">
          <Button
            variant="secondary"
            size="md"
            className={iconBtn}
            disabled={editBusy}
            onClick={addInsertRow}
            aria-label={t('table.toolbar.addRow')}
            title={t('table.toolbar.addRow')}
          >
            <IconPlus size={15} />
          </Button>
          {/* 常驻显示，未选中行时置灰（评审：按钮不隐藏，统一禁用语义） */}
          <Button
            variant="secondary"
            size="md"
            className={iconBtn}
            disabled={selectedCount === 0 || editBusy}
            onClick={markDeleteSelected}
            title={selectedCount > 0 ? t('table.toolbar.deleteSelectedHint', [selectedCount]) : t('table.toolbar.deleteSelectedNoSel')}
            aria-label={t('table.toolbar.deleteSelected', [selectedCount])}
          >
            <IconMinus size={15} />
          </Button>
          <Button
            variant="secondary"
            size="md"
            className={iconBtn}
            disabled={counts.total === 0 || editBusy}
            onClick={() => void openPreview()}
            aria-label={t('table.toolbar.previewSql')}
            title={t('table.toolbar.previewSqlHint', [counts.total])}
          >
            <IconEye size={15} />
          </Button>
          <Button
            variant="secondary"
            size="md"
            disabled={counts.total === 0 || editBusy}
            onClick={() => void submitChanges()}
            className={counts.total > 0 ? `${iconBtn} animate-pulse` : iconBtn}
            aria-label={t('table.toolbar.commitCount', [counts.total])}
            title={t('table.toolbar.commitHint', [counts.total])}
          >
            <IconCheck size={15} />
          </Button>
          <Button
            variant="secondary"
            size="md"
            className={iconBtn}
            disabled={selectedDirtyCount === 0 || editBusy}
            onClick={() => void revertSelected()}
            aria-label={selectedDirtyCount > 0 ? t('table.toolbar.revertSelectedCount', [selectedDirtyCount]) : t('table.toolbar.revertSelected')}
            title={
              selectedDirtyCount > 0
                ? t('table.toolbar.revertSelectedCount', [selectedDirtyCount])
                : t('table.toolbar.revertSelectedHint')
            }
          >
            <IconUndo size={15} />
          </Button>
        </div>
      )}

      <div className="ml-auto flex min-w-0 items-center gap-1.5">
        {copyHint && (
          <span className="shrink-0 text-[12px] text-muted-foreground">{copyHint}</span>
        )}
        {exportProgress && (
          <span className="flex shrink-0 items-center gap-1 text-[12px] text-muted-foreground">
            {t('table.export.progress', [exportProgress.rows])}
            <button
              type="button"
              aria-label={t('table.export.cancel')}
              title={t('table.export.cancel')}
              className="rounded-sm px-1 hover:bg-accent hover:text-accent-foreground"
              onClick={() => void cancelExport()}
            >
              ✕
            </button>
          </span>
        )}
        <div className="relative w-44 shrink-0">
          <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-[12px] text-muted-foreground">
            🔍
          </span>
          <Input
            aria-label={t('table.toolbar.search')}
            value={searchText}
            onChange={(e) => onSearchChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                if (debounceRef.current !== undefined) {
                  clearTimeout(debounceRef.current);
                }
                void applySearch(searchText.trim());
              }
            }}
            placeholder={t('table.toolbar.search')}
            className="pl-6"
          />
        </div>

        {/* 复制为多种格式（概要 §6 #6）：选中行 × 可见列；无选区置灰不隐藏。
            SQL 类格式（IN 列表 / TS 类型 / INSERT）按 supportsSQL 能力降级——
            键值源（Redis）无 SQL 语义、列是驱动虚拟列，复制出 SQL/类型不可用，仅留纯数据格式 */}
        <Menu
          trigger={
            <Button
              variant="secondary"
              size="md"
              className={`${iconBtn} gap-0.5`}
              disabled={selectedCount === 0}
              aria-label={t('table.toolbar.copySelected')}
              title={
                selectedCount > 0
                  ? supportsSQL
                    ? t('table.toolbar.copySelectedSqlHint', [selectedCount])
                    : t('table.toolbar.copySelectedKvHint', [selectedCount])
                  : t('table.toolbar.copyNoSel')
              }
            >
              <IconCopy size={14} />
              <span aria-hidden className="text-[9px] leading-none text-muted-foreground">▾</span>
            </Button>
          }
          items={[
            ...(supportsSQL
              ? [
                  { key: 'inList', label: t('table.copy.inList', [primaryKey.length > 0 ? primaryKey[0] : t('table.copy.firstColumn')]), onSelect: () => void onCopyAs('inList') },
                  { key: 'tsType', label: t('table.copy.tsType'), onSelect: () => void onCopyAs('tsType') },
                  { key: 'insert', label: t('table.copy.insert'), onSelect: () => void onCopyAs('insert') },
                ]
              : []),
            { key: 'json', label: 'JSON', onSelect: () => void onCopyAs('json') },
            { key: 'markdown', label: t('table.copy.markdownTable'), onSelect: () => void onCopyAs('markdown') },
          ]}
        />

        {/* DDL 按能力位隐藏（supportsDdl=false 的驱动未实现 getDdl，概要 §5.1.3 降级渲染） */}
        {supportsDdl && (
          <Button
            variant="secondary"
            size="md"
            className={iconBtn}
            aria-label={t('table.toolbar.viewDdl')}
            title={t('table.toolbar.viewDdlTitle')}
            onClick={() => void openDdl()}
          >
            <span className="text-[11px] font-medium tracking-tight">DDL</span>
          </Button>
        )}
        <Popover
          trigger={
            <Button variant="secondary" size="md" className={`${iconBtn} gap-0.5`} aria-label={t('table.toolbar.columnSettings')} title={t('table.toolbar.columnSettingsTitle')}>
              <IconColumns size={14} />
              <span aria-hidden className="text-[9px] leading-none text-muted-foreground">▾</span>
            </Button>
          }
          open={columnSettingsOpen}
          onOpenChange={setColumnSettingsOpen}
          contentClassName="p-1 min-w-44 max-h-72 overflow-y-auto"
        >
          <div className="px-2 py-1 text-[11px] text-muted-foreground">{t('table.toolbar.showHideColumns')}</div>
          {allColumns.map((c) => (
            <Checkbox
              key={c.name}
              checked={visibleSet.has(c.name)}
              onCheckedChange={(show) => toggleColumn(c.name, show)}
              label={
                <span className="truncate">
                  {c.name} <span className="text-muted-foreground">{c.type}</span>
                </span>
              }
            />
          ))}
        </Popover>

        <Menu
          trigger={
            <Button
              variant="secondary"
              size="md"
              className={`${iconBtn} gap-0.5`}
              aria-label={t('table.toolbar.export')}
              title={t('table.toolbar.exportTitle')}
            >
              <IconDownload size={14} />
              <span aria-hidden className="text-[9px] leading-none text-muted-foreground">▾</span>
            </Button>
          }
          items={[
            { key: 'csv-page', label: t('table.export.currentPage', ['CSV']), onSelect: () => onExport('csv', 'page') },
            { key: 'csv-result', label: t('table.export.allResults', ['CSV']), onSelect: () => onExport('csv', 'result') },
            { key: 'json-page', label: t('table.export.currentPage', ['JSON']), onSelect: () => onExport('json', 'page') },
            { key: 'json-result', label: t('table.export.allResults', ['JSON']), onSelect: () => onExport('json', 'result') },
            { key: 'xlsx-page', label: t('table.export.currentPage', ['Excel (xlsx)']), onSelect: () => onExport('xlsx', 'page') },
            { key: 'xlsx-result', label: t('table.export.allResults', ['Excel (xlsx)']), onSelect: () => onExport('xlsx', 'result') },
            { key: 'ndjson-page', label: t('table.export.currentPage', ['NDJSON']), onSelect: () => onExport('ndjson', 'page') },
            { key: 'ndjson-result', label: t('table.export.allResults', ['NDJSON']), onSelect: () => onExport('ndjson', 'result') },
            { key: 'markdown-page', label: t('table.export.currentPage', ['Markdown']), onSelect: () => onExport('markdown', 'page') },
            { key: 'markdown-result', label: t('table.export.allResults', ['Markdown']), onSelect: () => onExport('markdown', 'result') },
            { key: 'insert-page', label: t('table.export.currentPage', ['SQL (INSERT)']), onSelect: () => onExport('insert', 'page') },
            { key: 'insert-result', label: t('table.export.allResults', ['SQL (INSERT)']), onSelect: () => onExport('insert', 'result') },
          ]}
        />
      </div>
    </div>
  );
}
