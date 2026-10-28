import { useEffect, useState } from 'react';
import { Button } from '../../components/ui/button';
import { IconPlay } from '../../components/ui/icons';
import { t } from '../../lib/i18n';
import { rpcErrorText } from '../../lib/errors';
import { RpcError, request } from '../../rpc/client';
import { useTableStore } from '../../store/tableStore';
import { Popover } from '../../components/ui/popover';
import { normalizeSingleLine, SqlInput } from './SqlInput';

/**
 * 自由条件栏（交互稿 §4.4 v0.1.3）：WHERE 与 ORDER BY 两个手写输入框，
 * 语法高亮 + 列名/关键字补全；应用 → 服务端拼接进最终语句并回到第 1 页；
 * 未应用的改动在 [应用] 上以蓝点提示。清空同时移除全局搜索（回到全量数据）。
 * AI P2A 批次 A1（交互稿 §15.7 转正）：「✨ AI」弹层——自然语言 → WHERE 片段
 * **回填 WHERE 输入框**给用户过目可改（原则②：AI 产物可审计、绝不直接执行），
 * 应用走既有下推链。
 */
export function FilterBar() {
  const allColumns = useTableStore((s) => (s.allColumns.length > 0 ? s.allColumns : s.columns));
  const appliedWhere = useTableStore((s) => s.appliedWhere);
  const appliedOrderBy = useTableStore((s) => s.appliedOrderBy);
  const applyQuery = useTableStore((s) => s.applyQuery);
  const connId = useTableStore((s) => s.connId);
  const db = useTableStore((s) => s.db);
  const obj = useTableStore((s) => s.obj);
  const showToast = useTableStore((s) => s.showToast);

  const [where, setWhere] = useState(appliedWhere);
  const [orderBy, setOrderBy] = useState(appliedOrderBy);
  const dirty = where !== appliedWhere || orderBy !== appliedOrderBy;

  // AI 弹层状态（A1）：打开即聚焦输入；生成中禁按钮；成功回填 + Toast 提示
  const [aiOpen, setAiOpen] = useState(false);
  const [aiInput, setAiInput] = useState('');
  const [aiBusy, setAiBusy] = useState(false);

  // 应用/清空后同步本地草稿（归一化为单行——历史会话恢复的值可能含换行）
  useEffect(() => {
    setWhere(normalizeSingleLine(appliedWhere));
    setOrderBy(normalizeSingleLine(appliedOrderBy));
  }, [appliedWhere, appliedOrderBy]);

  const apply = (): void => {
    void applyQuery(where.trim(), orderBy.trim());
  };

  const generateFilter = async (): Promise<void> => {
    const nl = aiInput.trim();
    if (!nl || aiBusy) {
      return;
    }
    setAiBusy(true);
    try {
      const result = await request<{ whereSql: string }>(
        'ai.generateFilter',
        { connId, db, table: obj, nl },
        120_000,
      );
      setWhere(normalizeSingleLine(result.whereSql));
      setAiOpen(false);
      setAiInput('');
      showToast({ kind: 'info', text: t('ai.filterFilled') }, 6000);
    } catch (err) {
      const text =
        err instanceof RpcError
          ? rpcErrorText(err)
          : err instanceof Error
            ? err.message
            : String(err);
      showToast({ kind: 'error', text: t('ai.filterFailed', [text]) }, 8000);
    } finally {
      setAiBusy(false);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-1.5 border-b border-border bg-panel px-2 py-1.5">
      <span className="shrink-0 font-mono text-[11px] font-medium text-muted-foreground" title={t('table.filter.whereTitle')}>
        WHERE
      </span>
      <SqlInput
        value={where}
        onChange={setWhere}
        onApply={apply}
        columns={allColumns}
        context="where"
        ariaLabel={t('table.filter.whereAria')}
        widthClass="min-w-56 flex-1"
      />
      <span className="ml-1 shrink-0 font-mono text-[11px] font-medium text-muted-foreground" title={t('table.filter.orderTitle')}>
        ORDER BY
      </span>
      <SqlInput
        value={orderBy}
        onChange={setOrderBy}
        onApply={apply}
        columns={allColumns}
        context="order"
        ariaLabel={t('table.filter.orderAria')}
        widthClass="w-64"
      />
      <Button
        variant="primary"
        size="sm"
        className="w-7 px-0"
        disabled={!dirty}
        onClick={apply}
        aria-label={t('table.filter.apply')}
        title={dirty ? t('table.filter.applyTitle') : t('table.filter.unchanged')}
      >
        <IconPlay size={13} />
      </Button>
      <Popover
        open={aiOpen}
        onOpenChange={(next) => {
          if (!aiBusy) {
            setAiOpen(next);
          }
        }}
        contentClassName="w-96 p-3 flex flex-col gap-2"
        trigger={
          <Button
            variant="secondary"
            size="sm"
            aria-label={t('ai.filter')}
            title={t('ai.filterTitle')}
            onClick={() => setAiOpen(true)}
          >
            {t('ai.filter')}
          </Button>
        }
      >
        <div className="text-[12px] font-medium">{t('ai.filterPrompt')}</div>
        <textarea
          value={aiInput}
          onChange={(e) => setAiInput(e.target.value)}
          placeholder={t('ai.filterPlaceholder')}
          rows={3}
          aria-label={t('ai.filterPrompt')}
          className="w-full resize-none rounded-sm border border-border bg-input px-2 py-1.5 text-[12px] outline-none focus:border-primary"
        />
        <div className="flex justify-end">
          <Button
            variant="primary"
            size="sm"
            disabled={aiBusy || aiInput.trim() === ''}
            onClick={() => void generateFilter()}
          >
            {aiBusy ? t('ai.filterGenerating') : t('ai.filterGenerate')}
          </Button>
        </div>
      </Popover>
    </div>
  );
}
