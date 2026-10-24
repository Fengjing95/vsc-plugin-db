import { useEffect } from 'react';
import type { ConsoleRunItem } from '@db-explorer/protocol';
import { Button } from '../components/ui/button';
import {
  isExplainResultSet,
  explainIndentLevels,
  oneLineSql,
  resultStatusLine,
  runItemSummary,
  runStatusText,
} from '../lib/consoleView';
import { parseAiMarkdown } from '../lib/aiMarkdown';
import { rpcErrorText } from '../lib/errors';
import { subscribeEvents } from '../rpc/client';
import { useConsoleStore } from '../store/consoleStore';
import { deriveTabs } from '../lib/consoleView';
import { ConsoleGrid } from './console/ConsoleGrid';

/** AI 解释 Tab 内容（交互稿 §15.3）：Markdown 流式渲染 + 错误态（重试 / 去配置） */
function AiMarkdownView({ content }: { content: string }) {
  const blocks = parseAiMarkdown(content);
  return (
    <div className="text-[13px] leading-6">
      {blocks.map((block, i) => {
        if (block.type === 'heading') {
          return (
            <div key={i} className={`mt-3 font-semibold first:mt-0 ${block.level === 1 ? 'text-[14px]' : 'text-[13px]'}`}>
              {block.inlines.map((seg, k) => (seg.bold ? <strong key={k}>{seg.text}</strong> : <span key={k}>{seg.text}</span>))}
            </div>
          );
        }
        if (block.type === 'code') {
          return (
            <pre key={i} className="my-2 overflow-auto rounded-sm bg-input px-2 py-1 font-mono text-[12px] leading-5 whitespace-pre-wrap break-all">
              {block.text}
            </pre>
          );
        }
        if (block.type === 'list') {
          const Tag = block.ordered ? 'ol' : 'ul';
          return (
            <Tag key={i} className={`my-1 pl-5 ${block.ordered ? 'list-decimal' : 'list-disc'}`}>
              {block.items.map((item, k) => (
                <li key={k}>
                  {item.map((seg, s) =>
                    seg.bold ? <strong key={s}>{seg.text}</strong> : seg.code ? <code key={s} className="rounded-sm bg-input px-1">{seg.text}</code> : <span key={s}>{seg.text}</span>,
                  )}
                </li>
              ))}
            </Tag>
          );
        }
        return (
          <div key={i} className="my-1">
            {block.inlines.map((seg, s) =>
              seg.bold ? <strong key={s}>{seg.text}</strong> : seg.code ? <code key={s} className="rounded-sm bg-input px-1">{seg.text}</code> : <span key={s}>{seg.text}</span>,
            )}
          </div>
        );
      })}
    </div>
  );
}

/**
 * SQL Console 结果面板（交互稿 §7.3/§7.4）：
 * [结果 1][结果 2][消息][AI 解释] … [导出][关闭]；顶部危险横幅；底部状态行 + truncated 黄字。
 * 数据流：console.getState 引导 → evt:console.updated/running/banner/ai 增量推送。
 */
export function ConsolePage({ consoleId }: { consoleId: string }) {
  const phase = useConsoleStore((s) => s.phase);
  const errorMsg = useConsoleStore((s) => s.errorMsg);
  const bound = useConsoleStore((s) => s.bound);
  const connLabel = useConsoleStore((s) => s.connLabel);
  const db = useConsoleStore((s) => s.db);
  const run = useConsoleStore((s) => s.run);
  const banner = useConsoleStore((s) => s.banner);
  const running = useConsoleStore((s) => s.running);
  const ai = useConsoleStore((s) => s.ai);
  const activeTab = useConsoleStore((s) => s.activeTab);
  const setActiveTab = useConsoleStore((s) => s.setActiveTab);
  const resolveBanner = useConsoleStore((s) => s.resolveBanner);
  const cancelRun = useConsoleStore((s) => s.cancelRun);
  const rerun = useConsoleStore((s) => s.rerun);
  const exportItem = useConsoleStore((s) => s.exportItem);
  const exporting = useConsoleStore((s) => s.exporting);
  const openFix = useConsoleStore((s) => s.openFix);
  const retryExplain = useConsoleStore((s) => s.retryExplain);
  const openAiSettings = useConsoleStore((s) => s.openAiSettings);
  const closePanel = useConsoleStore((s) => s.closePanel);
  const dismissToast = useConsoleStore((s) => s.dismissToast);
  const toast = useConsoleStore((s) => s.toast);

  useEffect(() => {
    void useConsoleStore.getState().bootstrap(consoleId);
    const unsub = subscribeEvents((evt) => {
      useConsoleStore.getState().handleEvent(evt);
    });
    return () => {
      unsub();
    };
  }, [consoleId]);

  if (phase === 'loading') {
    return <div className="flex h-screen items-center justify-center text-muted-foreground">加载中…</div>;
  }
  if (phase === 'error') {
    return (
      <div className="flex h-screen items-center justify-center text-destructive">{errorMsg}</div>
    );
  }

  const tabs = deriveTabs(run, ai);
  const active = tabs.find((t) => t.id === activeTab) ?? tabs[0] ?? null;
  const activeItem = active?.kind === 'result' ? active.item : undefined;
  const activeResultSet = activeItem?.resultSet;

  const messageItems: ConsoleRunItem[] = run ? run.items.filter((i) => !i.resultSet) : [];

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      {/* 危险语句横幅（§7.4）：面板顶部内联 [仍要执行][取消] */}
      {banner && (
        <div
          role="alert"
          className="flex shrink-0 items-center gap-3 border-b border-warning/40 bg-dirty-bg px-3 py-2 text-[13px]"
        >
          <span className="text-warning">⚠</span>
          <span className="min-w-0 flex-1 break-all">
            检测到可能影响全表的语句：{banner.reasons.join('；')}
            <span className="ml-2 text-muted-foreground">{banner.sql.replace(/\s+/g, ' ').slice(0, 120)}</span>
          </span>
          <Button variant="secondary" onClick={() => void resolveBanner('cancel')}>
            取消
          </Button>
          <Button onClick={() => void resolveBanner('proceed')}>仍要执行</Button>
        </div>
      )}

      {/* Tab 栏 + 导出/关闭（§7.3） */}
      <div className="flex shrink-0 items-center gap-1 border-b border-border bg-panel px-2" style={{ height: 36 }}>
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              aria-label={tab.label}
              className={`shrink-0 rounded-sm px-3 py-1 text-[12px] ${
                tab.id === activeTab
                  ? 'bg-selected text-selected-foreground font-medium'
                  : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
              }`}
              onClick={() => setActiveTab(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </div>
        {activeItem?.resultSet && (
          <>
            <button
              type="button"
              aria-label="重跑该语句"
              title="重跑该语句"
              className="shrink-0 rounded-sm px-2 py-1 text-[12px] text-muted-foreground hover:bg-accent hover:text-accent-foreground"
              onClick={() => void rerun(activeItem.sql)}
            >
              ↻
            </button>
            <button
              type="button"
              aria-label="导出 CSV"
              title="导出 CSV"
              disabled={exporting}
              className="shrink-0 rounded-sm px-2 py-1 text-[12px] text-muted-foreground hover:bg-accent hover:text-accent-foreground disabled:opacity-50"
              onClick={() => void exportItem(activeItem.seq, 'csv')}
            >
              ⇩ CSV
            </button>
            <button
              type="button"
              aria-label="导出 JSON"
              title="导出 JSON"
              disabled={exporting}
              className="shrink-0 rounded-sm px-2 py-1 text-[12px] text-muted-foreground hover:bg-accent hover:text-accent-foreground disabled:opacity-50"
              onClick={() => void exportItem(activeItem.seq, 'json')}
            >
              ⇩ JSON
            </button>
            <button
              type="button"
              aria-label="导出 Excel"
              title="导出 Excel (xlsx)"
              disabled={exporting}
              className="shrink-0 rounded-sm px-2 py-1 text-[12px] text-muted-foreground hover:bg-accent hover:text-accent-foreground disabled:opacity-50"
              onClick={() => void exportItem(activeItem.seq, 'xlsx')}
            >
              ⇩ Excel
            </button>
          </>
        )}
        <button
          type="button"
          aria-label="关闭结果面板"
          title="关闭"
          className="shrink-0 rounded-sm px-2 py-1 text-[12px] text-muted-foreground hover:bg-accent hover:text-accent-foreground"
          onClick={() => void closePanel()}
        >
          ✕
        </button>
      </div>

      {/* 内容区：结果网格 / 消息 Tab / AI 解释 Tab */}
      {/* D-13：EXPLAIN 结果按 id 列推导层级，首列树形缩进（其余形状退化为普通表格） */}
      {active?.kind === 'ai' && ai ? (
        <div className="min-h-0 flex-1 overflow-auto px-4 py-3">
          {ai.status === 'error' ? (
            <div className="flex flex-col gap-2" role="alert">
              <div className="rounded-sm border border-destructive/40 px-3 py-2 text-[12px] text-destructive">
                {rpcErrorText({ code: ai.errorCode, message: ai.errorMessage ?? '' }) || 'AI 解释失败'}
              </div>
              <div className="flex gap-2">
                <Button variant="secondary" onClick={() => void retryExplain()}>
                  重试
                </Button>
                {(ai.errorCode === 'E_AI_NOT_CONFIGURED' || ai.errorCode === undefined) && (
                  <Button variant="secondary" onClick={() => void openAiSettings()}>
                    去配置
                  </Button>
                )}
              </div>
              {ai.content && <AiMarkdownView content={ai.content} />}
            </div>
          ) : (
            <>
              {ai.status === 'running' && <div className="mb-2 text-[12px] text-muted-foreground">AI 正在解释…</div>}
              <AiMarkdownView content={ai.content} />
              {ai.status === 'done' && (
                <div className="mt-3 text-[11px] text-muted-foreground">由 AI 生成，仅供参考</div>
              )}
            </>
          )}
        </div>
      ) : activeResultSet ? (
        <ConsoleGrid
          resultSet={activeResultSet}
          planLevels={
            activeItem && isExplainResultSet(activeItem.sql, activeResultSet.columns)
              ? explainIndentLevels(activeResultSet.rows, activeResultSet.columns.map((c) => c.name))
              : undefined
          }
        />
      ) : (
        <div className="min-h-0 flex-1 overflow-auto px-4 py-3 text-[13px] leading-6">
          {!run || run.items.length === 0 ? (
            <div className="text-muted-foreground">
              {bound ? '暂无执行记录。在 SQL 编辑器中按 Ctrl+Enter 执行。' : '未绑定连接（可在状态栏选择）。'}
            </div>
          ) : (
            <div className="font-mono whitespace-pre-wrap break-all text-panel-foreground">
              {messageItems.map((item) => (
                <div key={item.seq} className="mb-2">
                  <div>
                    [{item.seq}] {oneLineSql(item.sql)}
                  </div>
                  <div className={`pl-4 ${item.error ? 'text-destructive' : 'text-muted-foreground'}`}>
                    → {runItemSummary(item)}
                  </div>
                  {(item.messages ?? []).map((w, wi) => (
                    <div key={wi} className="pl-4 text-warning">
                      ⚠ {w}
                    </div>
                  ))}
                  {/* M9-AI（§15.4）：修复建议仅对「有文档来源的执行」的错误 item 显示 */}
                  {item.error && run?.documentBound && (
                    <button
                      type="button"
                      className="ml-4 mt-1 rounded-sm border border-border px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                      onClick={() => void openFix(item.seq)}
                    >
                      ✨ 修复建议
                    </button>
                  )}
                </div>
              ))}
              {run.status === 'canceled' && <div>⊘ 已取消</div>}
              {run.status === 'running' && <div className="text-muted-foreground">执行中…</div>}
            </div>
          )}
        </div>
      )}

      {/* 状态行（§7.3） */}
      <div
        className="flex shrink-0 items-center gap-3 border-t border-border bg-panel px-3 text-[12px] text-muted-foreground"
        style={{ height: 26 }}
        role="status"
      >
        <span className="shrink-0">
          {run ? runStatusText(run) : bound ? '就绪' : '未绑定连接'}
          {connLabel ? ` · ${connLabel}${db ? ` · ${db}` : ''}` : ''}
        </span>
        {activeItem && <span className="min-w-0 flex-1 truncate">{resultStatusLine(activeItem)}</span>}
      </div>
      {/* truncated 黄字（§7.3：状态行追加“结果已截断”） */}
      {activeItem?.resultSet?.truncated && (
        <div className="shrink-0 border-t border-border bg-dirty-bg px-3 py-1 text-[12px] text-warning" role="status">
          结果已截断至 {activeItem.resultSet.rowCount} 行（可在设置中调整行数上限）
        </div>
      )}
      {/* 执行中：状态行内取消入口（§7.2） */}
      {running && (
        <div className="flex shrink-0 items-center gap-2 border-t border-border bg-panel px-3 py-1 text-[12px]">
          <span className="text-muted-foreground">
            执行中（{run?.items.length ?? 0}/{running.total}）…
          </span>
          <Button variant="secondary" onClick={() => void cancelRun()}>
            取消执行
          </Button>
        </div>
      )}

      {toast && (
        <div
          role="status"
          className={`fixed right-3 bottom-3 z-[60] max-w-md rounded-sm border px-3 py-2 text-[12px] shadow-lg ${
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
