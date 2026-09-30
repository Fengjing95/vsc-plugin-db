import { useVirtualizer } from '@tanstack/react-virtual';
import { useMemo, useRef, useState } from 'react';
import type { PreviewItemPayload } from '@db-explorer/protocol';
import { Button } from '../../components/ui/button';
import { Dialog } from '../../components/ui/dialog';
import { useTableStore } from '../../store/tableStore';

const COLLAPSE_THRESHOLD = 50;
const ROW_HEIGHT = 30;

const KIND_LABEL: Record<PreviewItemPayload['kind'], string> = {
  update: 'UPDATE',
  insert: 'INSERT',
  delete: 'DELETE',
};

/**
 * 变更预览 Modal（交互稿 §5，概要设计 §5.4.3：预览即执行）。
 * - 参数化语句逐条可展开（SQL + 参数）
 * - 超过 50 条默认折叠（仅统计行 + 首条），展开后虚拟滚动
 * - prod 环境红条：确认入口在 Host 层 DangerGuard（输入表名），此处提示
 */
export function ChangePreviewModal({ env }: { env: 'dev' | 'test' | 'prod' | null }) {
  const items = useTableStore((s) => s.previewItems);
  const closePreview = useTableStore((s) => s.closePreview);
  const submitChanges = useTableStore((s) => s.submitChanges);
  const committing = useTableStore((s) => s.committing);
  const obj = useTableStore((s) => s.obj);
  const db = useTableStore((s) => s.db);
  // P-17：计数订阅底层切片（editCount() 是 get() 型 action，不触发重渲染）
  const updateCount = useTableStore((s) => Object.keys(s.updates).length);
  const deleteCount = useTableStore((s) => Object.keys(s.deletes).length);
  const insertCount = useTableStore((s) => s.inserts.length);

  const [expanded, setExpanded] = useState<Record<number, boolean>>({});
  const [listOpen, setListOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const counts = {
    total: updateCount + deleteCount + insertCount,
    updates: updateCount,
    deletes: deleteCount,
    inserts: insertCount,
  };
  const list = useMemo<PreviewItemPayload[]>(() => items ?? [], [items]);
  const needsCollapse = list.length > COLLAPSE_THRESHOLD;
  const showFullList = !needsCollapse || listOpen;

  const visible = useMemo<PreviewItemPayload[]>(() => (showFullList ? list : list.slice(0, 1)), [showFullList, list]);

  const virtualizer = useVirtualizer({
    count: visible.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 8,
    getItemKey: (i) => `${i}:${expanded[i] ? 'e' : 'c'}`,
  });

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
          提交变更（{counts.total}）<span className="font-normal text-muted-foreground"> · {db}.{obj}</span>
        </span>
      }
      footer={
        <>
          <span className="mr-auto flex items-center gap-1 text-[11px] text-muted-foreground">
            <span aria-hidden>☑</span> 全部语句在单事务内执行，失败自动回滚
          </span>
          <Button variant="secondary" size="md" disabled={committing} onClick={closePreview}>
            取消
          </Button>
          <Button variant="primary" size="md" disabled={committing} onClick={() => void submitChanges()}>
            {committing ? '提交中…' : '确认提交'}
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
            <span className="font-medium">█ 目标环境：生产 (prod) — 确认提交后需按提示输入表名二次确认</span>
          ) : (
            <span>目标环境：{env ? envLabel(env) : '未设置'} · 连接生效中的只读/生产策略在提交时强制校验</span>
          )}
        </div>

        <div className="shrink-0 px-4 py-2 text-[12px] text-muted-foreground">
          {updateLines} 条 UPDATE · {insertLines} 条 INSERT · {deleteLines} 条 DELETE
          {needsCollapse && (
            <button
              type="button"
              className="ml-3 text-link hover:underline"
              onClick={() => setListOpen((v) => !v)}
            >
              {listOpen ? '折叠全部 ▴' : `展开全部 ${list.length} 条 ▾`}
            </button>
          )}
        </div>

        <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto border-t border-border">
          <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
            {virtualizer.getVirtualItems().map((v) => {
              const item = visible[v.index];
              const isOpen = Boolean(expanded[v.index]);
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
                    <span className="min-w-0 flex-1 truncate font-mono text-muted-foreground" title={item.sql}>
                      {item.sql}
                    </span>
                  </div>
                  {isOpen && (
                    <div className="mb-1 rounded-sm border border-border bg-background px-2 py-1.5 font-mono text-[11px] leading-relaxed">
                      <div className="whitespace-pre-wrap break-all">{item.sql}</div>
                      {item.params && item.params.length > 0 && (
                        <div className="mt-1 text-muted-foreground">参数: {JSON.stringify(item.params)}</div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </Dialog>
  );
}

function envLabel(env: 'dev' | 'test' | 'prod'): string {
  switch (env) {
    case 'dev':
      return '开发 (dev)';
    case 'test':
      return '测试 (test)';
    case 'prod':
      return '生产 (prod)';
  }
}
