import { useVirtualizer } from '@tanstack/react-virtual';
import { useMemo, useRef, useState } from 'react';
import type { PreviewItemPayload } from '@db-explorer/protocol';
import { Button } from '../../components/ui/button';
import { Dialog } from '../../components/ui/dialog';
import { IconInfo } from '../../components/ui/icons';
import { t } from '../../lib/i18n';
import { highlightSql, interpolateSqlParams } from '../../lib/sqlHighlight';
import { useTableStore } from '../../store/tableStore';

const COLLAPSE_THRESHOLD = 50;
const ROW_HEIGHT = 30;

const KIND_LABEL: Record<PreviewItemPayload['kind'], string> = {
  update: 'UPDATE',
  insert: 'INSERT',
  delete: 'DELETE',
};

/**
 * 语句列表（P-21）：虚拟列表与其滚动容器必须在同一组件挂载。
 * Dialog 的 portal 内容比持有 useVirtualizer 的组件晚一拍挂载时，
 * 无依赖 layout effect（virtual-core _willUpdate）在 ref 就绪前运行且不再重跑，
 * 滚动元素永远为 null、列表空白——抽成子组件后二者同 commit 挂载，问题即消。
 */
function SqlList({
  list,
  showFullList,
  onToggleListOpen,
}: {
  list: PreviewItemPayload[];
  showFullList: boolean;
  onToggleListOpen: () => void;
}) {
  const [expanded, setExpanded] = useState<Record<number, boolean>>({});
  const scrollRef = useRef<HTMLDivElement>(null);

  const visible = useMemo<PreviewItemPayload[]>(
    () => (showFullList ? list : list.slice(0, 1)),
    [showFullList, list],
  );

  const virtualizer = useVirtualizer({
    count: visible.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 8,
    getItemKey: (i) => `${i}:${expanded[i] ? 'e' : 'c'}`,
  });

  return (
    <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto border-t border-border">
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
        {virtualizer.getVirtualItems().map((v) => {
          const item = visible[v.index];
          const isOpen = Boolean(expanded[v.index]);
          // 展示用回填：? → 参数字面量（实际执行仍为参数化语句，参数在展开详情中）
          const shownSql = interpolateSqlParams(item.sql, item.params);
          return (
            <div
              key={v.key}
              data-index={v.index}
              ref={virtualizer.measureElement}
              className="absolute left-0 w-full px-4"
              style={{ top: v.start }}
            >
              <div style={{ height: ROW_HEIGHT }} className="flex items-center gap-2 text-[12px]">
                <button
                  type="button"
                  className={`shrink-0 rounded-sm px-1.5 py-0.5 font-mono text-[11px] ${
                    item.kind === 'delete'
                      ? 'bg-delete-bg text-destructive'
                      : item.kind === 'insert'
                        ? 'bg-insert-bg text-success'
                        : 'bg-dirty-bg text-warning'
                  }`}
                  onClick={() => setExpanded((m) => ({ ...m, [v.index]: !m[v.index] }))}
                >
                  {isOpen ? '▾' : '▸'} {KIND_LABEL[item.kind]}
                </button>
                <span
                  className="sql-hl min-w-0 flex-1 truncate font-mono text-muted-foreground"
                  title={shownSql}
                  dangerouslySetInnerHTML={{ __html: highlightSql(shownSql) }}
                />
              </div>
              {isOpen && (
                <div className="sql-hl mb-1 rounded-sm border border-border bg-background px-2 py-1.5 font-mono text-[11px] leading-relaxed">
                  <div className="whitespace-pre-wrap break-all" dangerouslySetInnerHTML={{ __html: highlightSql(shownSql) }} />
                  {item.params && item.params.length > 0 && (
                    <div className="mt-1 text-muted-foreground">{t('table.preview.params', [JSON.stringify(item.params)])}</div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
      {/* 展开/折叠入口放在列表末尾，>50 条时可达（交互稿 §5） */}
      {list.length > COLLAPSE_THRESHOLD && (
        <button type="button" className="m-3 text-link hover:underline" onClick={onToggleListOpen}>
          {showFullList ? t('table.preview.collapseAll') : t('table.preview.expandAll', [list.length])}
        </button>
      )}
    </div>
  );
}

/**
 * 变更预览 Modal（交互稿 §5，概要设计 §5.4.3：预览即执行）。
 * - 参数化语句逐条可展开（SQL 高亮 + 参数）；>50 条默认折叠（仅统计行 + 首条）
 * - prod 环境红条：确认入口在 Host 层 DangerGuard（输入表名），此处提示
 */
export function ChangePreviewModal({ env }: { env: 'dev' | 'test' | 'prod' | null }) {
  const items = useTableStore((s) => s.previewItems);
  const closePreview = useTableStore((s) => s.closePreview);
  const submitChanges = useTableStore((s) => s.submitChanges);
  const committing = useTableStore((s) => s.committing);
  const obj = useTableStore((s) => s.obj);
  const db = useTableStore((s) => s.db);

  const [listOpen, setListOpen] = useState(false);

  const list = useMemo<PreviewItemPayload[]>(() => items ?? [], [items]);
  const showFullList = list.length <= COLLAPSE_THRESHOLD || listOpen;

  const updateLines = list.filter((i) => i.kind === 'update').length;
  const insertLines = list.filter((i) => i.kind === 'insert').length;
  const deleteLines = list.filter((i) => i.kind === 'delete').length;

  return (
    <Dialog
      open={items !== null}
      onOpenChange={(open) => {
        if (!open && !committing) {
          closePreview();
        }
      }}
      title={
        <span>
          {t('table.preview.title', [list.length])}<span className="font-normal text-muted-foreground"> · {db}.{obj}</span>
        </span>
      }
      footer={
        <>
          <span className="mr-auto flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <IconInfo size={15} className="shrink-0" /> {t('table.preview.txNote')}
          </span>
          <Button variant="secondary" size="md" disabled={committing} onClick={closePreview}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" size="md" disabled={committing} onClick={() => void submitChanges()}>
            {committing ? t('table.preview.committing') : t('table.preview.confirm')}
          </Button>
        </>
      }
    >
      <div className="flex h-full flex-col">
        {/* 环境色条（交互稿 §5：prod 为红条） */}
        <div
          className={`shrink-0 px-4 py-1.5 text-[12px] ${
            env === 'prod' ? 'bg-delete-bg text-destructive' : 'bg-row-stripe text-muted-foreground'
          }`}
        >
          {env === 'prod' ? (
            <span className="font-medium">{t('table.preview.prodBanner')}</span>
          ) : (
            <span>{t('table.preview.envBanner', [env ? envLabel(env) : t('table.preview.envUnset')])}</span>
          )}
        </div>

        <div className="shrink-0 px-4 py-2 text-[12px] text-muted-foreground">
          {t('table.preview.counts', [updateLines, insertLines, deleteLines])}
        </div>

        <SqlList list={list} showFullList={showFullList} onToggleListOpen={() => setListOpen((v) => !v)} />
      </div>
    </Dialog>
  );
}

function envLabel(env: 'dev' | 'test' | 'prod'): string {
  switch (env) {
    case 'dev':
      return t('table.env.devLabel');
    case 'test':
      return t('table.env.testLabel');
    case 'prod':
      return t('table.env.prodLabel');
  }
}
