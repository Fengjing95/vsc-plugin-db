import { useEffect, useRef, useState } from 'react';
import type { ExportFormat, ExportScope } from '@db-explorer/protocol';
import { Checkbox } from '../../components/ui/checkbox';
import { Input } from '../../components/ui/input';
import { Menu } from '../../components/ui/menu';
import { Popover } from '../../components/ui/popover';
import { Button } from '../../components/ui/button';
import { useTableStore } from '../../store/tableStore';

/** 工具栏（交互稿 §4.1/概要设计 5.4.2）：标题、编辑操作、搜索、列设置、导出、刷新 */
export function Toolbar({ db, obj, env }: { db: string; obj: string; env: 'dev' | 'test' | 'prod' | null }) {
  const readOnly = useTableStore((s) => s.readOnly);
  const applySearch = useTableStore((s) => s.applySearch);
  const refresh = useTableStore((s) => s.refresh);
  const runExport = useTableStore((s) => s.runExport);
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
  const revertAll = useTableStore((s) => s.revertAll);
  const previewing = useTableStore((s) => s.previewing);
  const committing = useTableStore((s) => s.committing);
  const selectedCount = useTableStore((s) => Object.keys(s.selectedRows).length);
  const markDeleteSelected = useTableStore((s) => s.markDeleteSelected);

  const [searchText, setSearchText] = useState('');
  const [columnSettingsOpen, setColumnSettingsOpen] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    return () => {
      if (debounceRef.current !== undefined) {
        clearTimeout(debounceRef.current);
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
          title={env === 'prod' ? '生产环境：提交需输入表名确认（DangerGuard）' : `环境：${env}`}
        >
          {env === 'prod' ? '生产' : env === 'test' ? '测试' : '开发'}
        </span>
      )}
      {(readOnly || !editEnabled) && (
        <span
          className="shrink-0 rounded-sm border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground"
          title={editReason ?? '连接已开启只读保护（ConnectionManager 层拦截写操作）'}
        >
          只读
        </span>
      )}
      {editEnabled && counts.total > 0 && (
        <span className="shrink-0 text-[11px] text-warning" title="存在未提交变更">
          ● 表名有未提交变更
        </span>
      )}

      {editEnabled && (
        <div className="flex shrink-0 items-center gap-1.5">
          <Button variant="secondary" size="md" disabled={editBusy} onClick={addInsertRow} aria-label="新增行">
            ＋ 新增行
          </Button>
          {selectedCount > 0 && (
            <Button
              variant="secondary"
              size="md"
              disabled={editBusy}
              onClick={markDeleteSelected}
              title="标记删除选中行（进入变更集，提交时落库）"
              aria-label={`删除选中行（${selectedCount}）`}
            >
              🗑 删除选中行 ({selectedCount})
            </Button>
          )}
          <Button
            variant={counts.total > 0 ? 'primary' : 'secondary'}
            size="md"
            disabled={counts.total === 0 || editBusy}
            onClick={() => void openPreview()}
            className={counts.total > 0 ? 'animate-pulse' : undefined}
            aria-label={`提交变更（${counts.total}）`}
          >
            {previewing ? '生成预览…' : committing ? '提交中…' : `提交变更 (${counts.total})`}
          </Button>
          <Button
            variant="ghost"
            size="md"
            disabled={counts.total === 0 || editBusy}
            onClick={() => void revertAll()}
            aria-label="撤销全部变更"
          >
            撤销
          </Button>
        </div>
      )}

      <div className="ml-auto flex min-w-0 items-center gap-1.5">
        {exportProgress && (
          <span className="shrink-0 text-[12px] text-muted-foreground">
            导出中… {exportProgress.rows} 行
          </span>
        )}
        <div className="relative w-44 shrink-0">
          <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-[12px] text-muted-foreground">
            🔍
          </span>
          <Input
            aria-label="全局搜索"
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
            placeholder="全局搜索"
            className="pl-6"
          />
        </div>

        <Popover
          trigger={
            <Button variant="secondary" size="md" aria-label="列设置">
              列设置 ▾
            </Button>
          }
          open={columnSettingsOpen}
          onOpenChange={setColumnSettingsOpen}
          contentClassName="p-1 min-w-44 max-h-72 overflow-y-auto"
        >
          <div className="px-2 py-1 text-[11px] text-muted-foreground">显示/隐藏列（服务端投影）</div>
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
            <Button variant="secondary" size="md" disabled={exportProgress !== null}>
              导出 ▾
            </Button>
          }
          items={[
            { key: 'csv-page', label: 'CSV · 当前页', onSelect: () => onExport('csv', 'page') },
            { key: 'csv-result', label: 'CSV · 全部结果', onSelect: () => onExport('csv', 'result') },
            { key: 'json-page', label: 'JSON · 当前页', onSelect: () => onExport('json', 'page') },
            { key: 'json-result', label: 'JSON · 全部结果', onSelect: () => onExport('json', 'result') },
          ]}
        />

        <Button
          variant="ghost"
          size="icon"
          aria-label="刷新"
          title="刷新当前页"
          onClick={() => void refresh()}
        >
          ⟳
        </Button>
      </div>
    </div>
  );
}
