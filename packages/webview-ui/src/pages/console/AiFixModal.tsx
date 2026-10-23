import type { AiFixErrorResult } from '@db-explorer/protocol';
import { Button } from '../../components/ui/button';
import { lineDiff } from '../../lib/aiDiff';

/**
 * AI 修复建议 Modal（M9-AI / D-24 / 交互稿 §15.4）：
 * 原 SQL vs 建议 SQL 双栏（行级 LCS diff 着色），确认后替换原语句 / 插入为新语句——
 * **不自动执行**：应用仅为文档编辑，用户自行 Ctrl+Enter（危险判定与 prod 确认照常）。
 * 错误态展示完整原因（rpcErrorText）+ 未配置时的「去配置」直达。
 */
export interface AiFixModalProps {
  loading: boolean;
  error: string;
  errorCode?: string;
  result: AiFixErrorResult | null;
  applying: boolean;
  onApply: (mode: 'replace' | 'insert') => void;
  onOpenSettings: () => void;
  onClose: () => void;
}

function SqlPane({ title, diff, side }: { title: string; diff: ReturnType<typeof lineDiff>; side: 'del' | 'add' }): React.JSX.Element {
  const lines = diff.filter((d) => (side === 'del' ? d.type !== 'add' : d.type !== 'del'));
  return (
    <div className="flex min-w-0 flex-1 flex-col rounded-sm border border-border">
      <div className="border-b border-border bg-panel px-2 py-1 text-[11px] text-muted-foreground">{title}</div>
      <pre className="min-h-0 flex-1 overflow-auto p-2 font-mono text-[12px] leading-5 whitespace-pre-wrap break-all">
        {lines.map((line, i) => (
          <div
            key={i}
            className={
              line.type === 'same'
                ? 'text-muted-foreground'
                : line.type === 'del'
                  ? 'bg-destructive/10 text-destructive'
                  : 'bg-dirty-bg text-warning'
            }
          >
            {line.text || ' '}
          </div>
        ))}
      </pre>
    </div>
  );
}

export function AiFixModal(props: AiFixModalProps): React.JSX.Element | null {
  const { loading, error, errorCode, result, applying, onApply, onOpenSettings, onClose } = props;
  if (!loading && !error && !result) {
    return null;
  }
  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40" role="dialog" aria-modal="true" aria-label="AI 修复建议">
      <div className="flex max-h-[80vh] w-[min(880px,92vw)] flex-col rounded-md border border-border bg-app shadow-xl">
        <div className="flex items-center justify-between border-b border-border px-3 py-2">
          <span className="text-[13px] font-semibold">✨ AI 修复建议</span>
          <button
            type="button"
            aria-label="关闭"
            className="rounded-sm px-1 text-muted-foreground hover:bg-accent hover:text-foreground"
            onClick={onClose}
          >
            ✕
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-auto px-3 py-3">
          {loading && <div className="text-[13px] text-muted-foreground">AI 正在生成修复建议…</div>}
          {!loading && error !== '' && (
            <div role="alert" className="flex flex-col gap-2">
              <div className="rounded-sm border border-destructive/40 px-3 py-2 text-[12px] text-destructive">
                {error}
              </div>
              {errorCode === 'E_AI_NOT_CONFIGURED' && (
                <div>
                  <Button variant="secondary" onClick={onOpenSettings}>
                    去配置
                  </Button>
                </div>
              )}
            </div>
          )}
          {!loading && result && (
            <div className="flex min-h-0 flex-col gap-2">
              <div className="text-[12px] text-muted-foreground">
                确认后仅把建议 SQL 写入编辑器（<strong>不会自动执行</strong>），执行仍走危险语句拦截与确认流程。
              </div>
              <div className="flex min-h-0 flex-1 gap-2" style={{ minHeight: 160 }}>
                <SqlPane title="原 SQL" diff={lineDiff(result.originalSql, result.suggestedSql)} side="del" />
                <SqlPane title="建议 SQL" diff={lineDiff(result.originalSql, result.suggestedSql)} side="add" />
              </div>
            </div>
          )}
        </div>

        {result && !loading && (
          <div className="flex items-center justify-end gap-2 border-t border-border px-3 py-2">
            <Button variant="secondary" onClick={onClose}>
              不采用
            </Button>
            <Button variant="secondary" disabled={applying} onClick={() => onApply('insert')}>
              插入为新语句
            </Button>
            <Button disabled={applying} onClick={() => onApply('replace')}>
              {applying ? '应用中…' : '替换原语句'}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
