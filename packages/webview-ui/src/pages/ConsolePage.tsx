import { useEffect } from 'react';
import { Button } from '../components/ui/button';
import {
  messageLines,
  resultStatusLine,
  runStatusText,
  isExplainResultSet,
  explainIndentLevels,
  sessionTabLabel,
  sessionTabBadge,
} from '../lib/consoleView';
import { subscribeEvents } from '../rpc/client';
import { useConsoleStore } from '../store/consoleStore';
import { deriveTabs } from '../lib/consoleView';
import { ConsoleGrid } from './console/ConsoleGrid';

/**
 * SQL Console 结果面板（交互稿 §7.3/§7.4）：
 * [结果 1][结果 2][消息] … [导出][关闭]；顶部危险横幅；底部状态行 + truncated 黄字。
 * 数据流：console.getState 引导 → evt:console.updated/running/banner 增量推送。
 */
export function ConsolePage({ consoleId }: { consoleId: string }) {
  // 注意：prop consoleId 是 URL 引导参数（恒空串，仅用于首帧 bootstrap）；
  // 会话 Tab 的高亮必须用 store 的 consoleId——prop 同名遮蔽会让选中态永不显示（M8 修复）
  const storeConsoleId = useConsoleStore((s) => s.consoleId);
  const phase = useConsoleStore((s) => s.phase);
  const errorMsg = useConsoleStore((s) => s.errorMsg);
  const bound = useConsoleStore((s) => s.bound);
  const connLabel = useConsoleStore((s) => s.connLabel);
  const db = useConsoleStore((s) => s.db);
  const run = useConsoleStore((s) => s.run);
  const banner = useConsoleStore((s) => s.banner);
  const running = useConsoleStore((s) => s.running);
  const consoles = useConsoleStore((s) => s.consoles);
  const switchConsole = useConsoleStore((s) => s.switchConsole);
  const activeTab = useConsoleStore((s) => s.activeTab);
  const setActiveTab = useConsoleStore((s) => s.setActiveTab);
  const resolveBanner = useConsoleStore((s) => s.resolveBanner);
  const cancelRun = useConsoleStore((s) => s.cancelRun);
  const rerun = useConsoleStore((s) => s.rerun);
  const exportItem = useConsoleStore((s) => s.exportItem);
  const exporting = useConsoleStore((s) => s.exporting);
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

  const tabs = deriveTabs(run);
  const active = tabs.find((t) => t.id === activeTab) ?? tabs[0] ?? null;
  const activeItem = active?.kind === 'result' ? active.item : undefined;
  const activeResultSet = activeItem?.resultSet;

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

      {/* 会话 Tab 栏（M8 #11，交互稿 §7.3）：≥2 个会话时显示，点击切换跟随（结果/横幅/运行态保持）。
          单会话不显示（与既有形态一致，零噪音）；执行自动切换跟随由 evt:console.activated 承担 */}
      {consoles.length >= 2 && (
        <div
          className="flex shrink-0 items-center gap-1 border-b border-border bg-panel px-2"
          style={{ height: 28 }}
          role="tablist"
          aria-label="会话"
        >
          {consoles.map((c) => {
            const badge = sessionTabBadge(c);
            const active = c.consoleId === storeConsoleId;
            return (
              <button
                key={c.consoleId}
                type="button"
                role="tab"
                aria-selected={active}
                aria-label={sessionTabLabel(c)}
                className={`shrink-0 rounded-sm px-3 py-0.5 text-[12px] ${
                  active
                    ? 'bg-selected text-selected-foreground font-medium'
                    : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
                }`}
                onClick={() => void switchConsole(c.consoleId)}
              >
                {badge && (
                  <span className={`mr-1 ${badge.includes('事务') ? 'text-warning' : ''}`}>{badge}</span>
                )}
                {sessionTabLabel(c)}
              </button>
            );
          })}
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

      {/* 内容区：结果网格 / 消息 Tab */}
      {/* D-13：EXPLAIN 结果按 id 列推导层级，首列树形缩进（其余形状退化为普通表格） */}
      {activeResultSet ? (
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
              {messageLines(run).map((line, i) => (
                <div key={i} className={line.startsWith('  ⚠') ? 'text-warning' : ''}>
                  {line}
                </div>
              ))}
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
