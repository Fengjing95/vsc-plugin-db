import { useEffect, useRef, useState } from 'react';
import type { ExportFormat, ExportScope } from '@db-explorer/protocol';
import { Checkbox } from '../../components/ui/checkbox';
import { Input } from '../../components/ui/input';
import { Menu } from '../../components/ui/menu';
import { Popover } from '../../components/ui/popover';
import { Button } from '../../components/ui/button';
import { useTableStore } from '../../store/tableStore';

/** 工具栏（交互稿 §4.1/概要设计 5.4.2，M3 只读范围）：标题、搜索、列设置、导出、刷新 */
export function Toolbar({ db, obj }: { db: string; obj: string }) {
  const readOnly = useTableStore((s) => s.readOnly);
  const applySearch = useTableStore((s) => s.applySearch);
  const refresh = useTableStore((s) => s.refresh);
  const runExport = useTableStore((s) => s.runExport);
  const exportProgress = useTableStore((s) => s.exportProgress);
  const visibleColumns = useTableStore((s) => s.visibleColumns);
  const setVisibleColumns = useTableStore((s) => s.setVisibleColumns);
  const columns = useTableStore((s) => s.columns);

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

  const visible = visibleColumns ?? columns.map((c) => c.name);
  const visibleSet = new Set(visible);

  const toggleColumn = (name: string, show: boolean) => {
    const next = show ? [...visible, name] : visible.filter((c) => c !== name);
    // 保持列定义顺序
    const ordered = columns.map((c) => c.name).filter((n) => next.includes(n));
    void setVisibleColumns(ordered.length === columns.length ? null : ordered);
  };

  return (
    <div className="flex items-center gap-2 border-b border-border bg-panel px-2 py-1.5">
      <h1 className="shrink-0 text-[13px] font-semibold">
        {obj} <span className="font-normal text-muted-foreground">@ {db}</span>
      </h1>
      {readOnly && (
        <span
          className="shrink-0 rounded-sm border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground"
          title="连接已开启只读保护（ConnectionManager 层拦截写操作）"
        >
          只读
        </span>
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
          {columns.map((c) => (
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
