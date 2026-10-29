import { useEffect, useState } from 'react';
import type { CompareTableResult, CompareTableSummary } from '@db-explorer/protocol';
import { RpcMethods } from '@db-explorer/protocol';
import { Button } from '../components/ui/button';
import { t } from '../lib/i18n';
import { request, RpcError } from '../rpc/client';
import { errorCodeToMessage } from '../lib/errors';

/**
 * 表结构对比页（ADR D-29 / 交互稿 §17）：同连接两库结构 diff 只读展示。
 * 单页两层：差异清单（compare.list）↔ 点表名看双侧对齐详情（compare.table）。
 * 数据经 Host 走自省三件套 + core schemaDiff（P-57① 形状对齐）；无编辑控件。
 */

interface ListState {
  status: 'loading' | 'ready' | 'error';
  tables?: CompareTableSummary[];
  error?: string;
}

export function SchemaComparePage() {
  const boot = window.__BOOTSTRAP__;
  const connId = boot?.params.connId ?? '';
  const dbA = boot?.params.dbA ?? '';
  const dbB = boot?.params.dbB ?? '';

  const [list, setList] = useState<ListState>({ status: 'loading' });
  const [openTable, setOpenTable] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ status: 'loading' | 'ready' | 'error'; data?: CompareTableResult; error?: string }>({
    status: 'loading',
  });

  useEffect(() => {
    if (!connId || !dbA || !dbB) {
      return;
    }
    void (async () => {
      setList({ status: 'loading' });
      try {
        const r = await request<{ tables: CompareTableSummary[] }>(RpcMethods.compareList, { connId, dbA, dbB });
        setList({ status: 'ready', tables: r.tables });
      } catch (err) {
        setList({ status: 'error', error: describe(err) });
      }
    })();
  }, [connId, dbA, dbB]);

  useEffect(() => {
    if (!openTable || !connId) {
      return;
    }
    void (async () => {
      setDetail({ status: 'loading' });
      try {
        const r = await request<CompareTableResult>(RpcMethods.compareTable, { connId, dbA, dbB, table: openTable });
        setDetail({ status: 'ready', data: r });
      } catch (err) {
        setDetail({ status: 'error', error: describe(err) });
      }
    })();
  }, [openTable, connId, dbA, dbB]);

  if (!boot || !connId || !dbA || !dbB) {
    return <div className="status error">{t('compare.loadFailed', ['missing params'])}</div>;
  }

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      {/* 头部 */}
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        {openTable && (
          <Button variant="secondary" size="sm" onClick={() => setOpenTable(null)}>
            {t('compare.backToList')}
          </Button>
        )}
        <span className="text-[13px] font-medium text-foreground">{t('compare.title')}</span>
        <span className="text-[12px] text-muted-foreground">
          {openTable ? t('compare.tableHeader', [openTable, dbA, dbB]) : t('compare.header', [dbA, dbB])}
        </span>
      </div>

      {openTable === null ? (
        <SummaryView state={list} onOpen={setOpenTable} />
      ) : (
        <DetailView state={detail} />
      )}
    </div>
  );
}

function describe(err: unknown): string {
  const code = err instanceof RpcError ? err.code : 'E_INTERNAL';
  const msg = err instanceof Error ? err.message : String(err);
  return errorCodeToMessage(code, msg) || msg;
}

function statusBadge(status: string, diffCount: number): { text: string; cls: string } {
  switch (status) {
    case 'only-left':
      return { text: t('compare.onlyLeft'), cls: 'bg-warning/15 text-warning' };
    case 'only-right':
      return { text: t('compare.onlyRight'), cls: 'bg-insert-bg text-success' };
    case 'changed':
      return { text: t('compare.changedN', [diffCount]), cls: 'bg-selected text-selected-foreground' };
    default:
      return { text: t('compare.same'), cls: 'text-muted-foreground' };
  }
}

function SummaryView({ state, onOpen }: { state: ListState; onOpen: (table: string) => void }) {
  if (state.status === 'loading') {
    return <div className="flex flex-1 items-center justify-center text-[13px] text-muted-foreground">{t('compare.loading')}</div>;
  }
  if (state.status === 'error') {
    return <div className="flex flex-1 items-center justify-center text-[13px] text-destructive">{t('compare.loadFailed', [state.error ?? ''])}</div>;
  }
  const tables = state.tables ?? [];
  if (tables.length === 0) {
    return <div className="flex flex-1 items-center justify-center text-[13px] text-muted-foreground">{t('compare.allSame')}</div>;
  }
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <table className="w-full text-[12px]">
        <thead className="sticky top-0 bg-panel">
          <tr className="border-b border-border text-left text-muted-foreground">
            <th className="px-3 py-1.5 font-normal">{t('compare.colName')}</th>
            <th className="px-3 py-1.5 font-normal">A</th>
            <th className="px-3 py-1.5 font-normal">B</th>
            <th className="px-3 py-1.5 font-normal">—</th>
          </tr>
        </thead>
        <tbody>
          {tables.map((r) => {
            const badge = statusBadge(r.status, r.diffCount);
            return (
              <tr
                key={r.table}
                className="cursor-pointer border-b border-border hover:bg-accent"
                onClick={() => onOpen(r.table)}
              >
                <td className="px-3 py-1.5 font-medium text-foreground">{r.table}</td>
                <td className="px-3 py-1.5 text-muted-foreground">{r.leftRows === undefined ? '—' : t('compare.rowsLabel', [r.leftRows])}</td>
                <td className="px-3 py-1.5 text-muted-foreground">{r.rightRows === undefined ? '—' : t('compare.rowsLabel', [r.rightRows])}</td>
                <td className="px-3 py-1.5">
                  <span className={`rounded-sm px-1.5 py-0.5 text-[11px] ${badge.cls}`}>{badge.text}</span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function DetailView({ state }: { state: { status: 'loading' | 'ready' | 'error'; data?: CompareTableResult; error?: string } }) {
  if (state.status === 'loading') {
    return <div className="flex flex-1 items-center justify-center text-[13px] text-muted-foreground">{t('compare.tableLoading')}</div>;
  }
  if (state.status === 'error') {
    return <div className="flex flex-1 items-center justify-center text-[13px] text-destructive">{t('compare.loadFailed', [state.error ?? ''])}</div>;
  }
  const d = state.data;
  if (!d) {
    return null;
  }

  const sideCls = (status: string): string =>
    status === 'only-left'
      ? 'bg-delete-bg'
      : status === 'only-right'
        ? 'bg-insert-bg'
        : status === 'changed'
          ? 'bg-warning/10'
          : '';

  const namedRow = (n: { name: string; status: string; left?: { columns: string[]; extra?: string }; right?: { columns: string[]; extra?: string } }, key: string) => {
    const shape = (s?: { columns: string[]; extra?: string }): string => (s ? `${s.columns.join(', ')}${s.extra ? ` · ${s.extra}` : ''}` : '—');
    return (
      <tr key={key} className={`border-b border-border ${sideCls(n.status)}`}>
        <td className="px-3 py-1.5 font-medium text-foreground">{n.name}</td>
        <td className="px-3 py-1.5 font-mono text-[11px] text-foreground">{shape(n.left)}</td>
        <td className="px-3 py-1.5 font-mono text-[11px] text-foreground">{shape(n.right)}</td>
      </tr>
    );
  };

  return (
    <div className="min-h-0 flex-1 overflow-auto px-3 py-2">
      {/* 列 */}
      <div className="mb-3 text-[12px] font-medium text-foreground">{t('compare.sectionColumns')}</div>
      <table className="mb-4 w-full text-[12px]">
        <thead>
          <tr className="border-b border-border text-left text-muted-foreground">
            <th className="px-3 py-1 font-normal">{t('compare.colName')}</th>
            <th className="px-3 py-1 font-normal">A</th>
            <th className="px-3 py-1 font-normal">B</th>
          </tr>
        </thead>
        <tbody>
          {d.columns.map((c) => {
            const side = (s?: { dataType: string; nullable: boolean; defaultValue?: string; comment?: string }): string =>
              s
                ? `${s.dataType}${s.nullable ? '' : ' NOT NULL'}${s.defaultValue !== undefined && s.defaultValue !== '' ? ` DEFAULT ${s.defaultValue}` : ''}${s.comment ? ` -- ${s.comment}` : ''}`
                : '—';
            return (
              <tr key={c.name} className={`border-b border-border ${sideCls(c.status)}`}>
                <td className="px-3 py-1.5 font-medium text-foreground">{c.name}</td>
                <td className="px-3 py-1.5 font-mono text-[11px] text-foreground">{side(c.left)}</td>
                <td className="px-3 py-1.5 font-mono text-[11px] text-foreground">{side(c.right)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {d.primaryKey && (
        <>
          <div className="mb-2 text-[12px] font-medium text-foreground">{t('compare.sectionPrimaryKey')}</div>
          <table className="mb-4 w-full text-[12px]">
            <tbody>{namedRow(d.primaryKey, 'pk')}</tbody>
          </table>
        </>
      )}
      {d.indexes.length > 0 && (
        <>
          <div className="mb-2 text-[12px] font-medium text-foreground">{t('compare.sectionIndexes')}</div>
          <table className="mb-4 w-full text-[12px]">
            <tbody>{d.indexes.map((n) => namedRow(n, `idx:${n.name}`))}</tbody>
          </table>
        </>
      )}
      {d.foreignKeys.length > 0 && (
        <>
          <div className="mb-2 text-[12px] font-medium text-foreground">{t('compare.sectionForeignKeys')}</div>
          <table className="mb-4 w-full text-[12px]">
            <tbody>{d.foreignKeys.map((n) => namedRow(n, `fk:${n.name}`))}</tbody>
          </table>
        </>
      )}
      {d.primaryKey === null && d.indexes.length === 0 && d.foreignKeys.length === 0 && d.columns.every((c) => c.status === 'same') && (
        <div className="py-4 text-center text-[12px] text-muted-foreground">{t('compare.allSame')}</div>
      )}
    </div>
  );
}
