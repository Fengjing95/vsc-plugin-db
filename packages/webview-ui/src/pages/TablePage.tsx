import type { HandshakeResult } from '@db-explorer/protocol';
import {
  ChangesetUpdatedEventSchema,
  ExportDoneEventSchema,
  ExportProgressEventSchema,
  RowErrorEventSchema,
  RPC_PROTOCOL_VERSION,
  RpcEvents,
} from '@db-explorer/protocol';
import { useEffect } from 'react';
import { Button } from '../components/ui/button';
import { Toast } from '../components/ui/toast';
import { errorCodeToMessage } from '../lib/errors';
import { rowKeyString } from '../lib/editOverlay';
import { t } from '../lib/i18n';
import { request, subscribeEvents } from '../rpc/client';
import { useTableStore } from '../store/tableStore';
import { ChangePreviewModal } from './table/ChangePreviewModal';
import { CellViewerModal } from './table/CellViewerModal';
import { DataGrid } from './table/DataGrid';
import { DdlModal } from './table/DdlModal';
import { FilterBar } from './table/FilterBar';
import { PaginationBar } from './table/PaginationBar';
import { Toolbar } from './table/Toolbar';

interface TablePageProps {
  connId: string;
  db: string;
  obj: string;
  rowEstimate?: number;
  readOnly: boolean;
}

/**
 * 表格视图：工具栏 / 筛选栏 / 虚拟网格 / 分页栏 + 编辑（M4）。
 * 生命周期：sys.handshake（协议版本 + 快照回放 + 编辑权限）→ 初始化 → 首屏取数。
 */
export function TablePage({ connId, db, obj, rowEstimate, readOnly }: TablePageProps) {
  const phase = useTableStore((s) => s.phase);
  const errorMsg = useTableStore((s) => s.errorMsg);
  const errorCode = useTableStore((s) => s.errorCode);
  const rows = useTableStore((s) => s.rows);
  const refresh = useTableStore((s) => s.refresh);
  const clearFilters = useTableStore((s) => s.clearFilters);
  const appliedWhere = useTableStore((s) => s.appliedWhere);
  const appliedOrderBy = useTableStore((s) => s.appliedOrderBy);
  const searchApplied = useTableStore((s) => s.searchApplied);
  const supportsSQL = useTableStore((s) => s.capabilities.supportsSQL);
  const setExportProgress = useTableStore((s) => s.setExportProgress);
  const page = useTableStore((s) => s.page);
  const pageSize = useTableStore((s) => s.pageSize);
  const applyHandshake = useTableStore((s) => s.applyHandshake);
  const insertsLen = useTableStore((s) => s.inserts.length);

  useEffect(() => {
    let disposed = false;
    const unsub = subscribeEvents((evt) => {
      if (evt.event === RpcEvents.exportProgress) {
        const parsed = ExportProgressEventSchema.safeParse(evt.payload);
        if (parsed.success) {
          // M8 后台化：只跟随本视图发起的导出（exportId 匹配）；其它视图/后台任务不打扰
          const tracked = useTableStore.getState().exportProgress;
          if (tracked && tracked.exportId === parsed.data.exportId) {
            setExportProgress({ exportId: tracked.exportId, rows: parsed.data.rows, bytes: parsed.data.bytes });
          }
        }
        return;
      }
      if (evt.event === RpcEvents.exportDone) {
        const parsed = ExportDoneEventSchema.safeParse(evt.payload);
        if (parsed.success) {
          // 终态回执（成功/取消/失败三路）：清除本视图进度 chip（失败详情由 Host Toast 呈现）
          const tracked = useTableStore.getState().exportProgress;
          if (tracked && tracked.exportId === parsed.data.exportId) {
            setExportProgress(null);
          }
        }
        return;
      }
      if (evt.event === RpcEvents.changesetUpdated) {
        const parsed = ChangesetUpdatedEventSchema.safeParse(evt.payload);
        if (parsed.success) {
          const c = parsed.data.counts;
          // Host 权威副本清空（提交成功/撤销）→ 本地覆盖层同步清空
          if (c.inserts + c.updates + c.deletes === 0) {
            const s = useTableStore.getState();
            if (Object.keys(s.updates).length + Object.keys(s.deletes).length + s.inserts.length > 0) {
              useTableStore.setState({ updates: {}, deletes: {}, inserts: [] });
            }
          }
        }
        return;
      }
      if (evt.event === RpcEvents.rowError) {
        const parsed = RowErrorEventSchema.safeParse(evt.payload);
        if (parsed.success) {
          const e = parsed.data;
          const s = useTableStore.getState();
          if (e.rowKey) {
            const key = rowKeyString(e.rowKey);
            useTableStore.setState({
              rowErrors: { ...s.rowErrors, [key]: { code: e.code, message: e.message, kind: e.kind, tempId: e.tempId, rowKey: e.rowKey } },
            });
          }
          useTableStore.getState().showToast({
            kind: 'error',
            text: `${errorCodeToMessage(e.code, e.message)}（第 ${Object.keys(useTableStore.getState().rowErrors).length} 处）`,
            actions:
              e.code === 'E_CONFLICT'
                ? [
                    { label: '刷新并放弃', onSelect: () => void useTableStore.getState().discardAndRefresh() },
                    { label: '保留我的修改', onSelect: () => void useTableStore.getState().retainMyChanges() },
                  ]
                : undefined,
          }, 9000);
        }
        return;
      }
    });

    void (async () => {
      try {
        // 1) 握手：协议版本协商 + 快照回放（概要设计 §5.4.5 崩溃恢复）
        const hs = await request<HandshakeResult>('sys.handshake', { stateId: null });
        if (disposed) return;
        if (hs.protocolVersion !== RPC_PROTOCOL_VERSION) {
          useTableStore.setState({
            phase: 'error',
            errorMsg: '插件与视图版本不一致，请重载窗口',
          });
          return;
        }

        // 2) 应用握手结果（编辑权限 + ChangeSet 快照 + 视图状态回放）
        applyHandshake(hs);
        useTableStore.setState({ connId, db, obj, rowEstimate, readOnly });

        // 3) 首屏取数
        await useTableStore.getState().refresh();
      } catch (err) {
        if (!disposed) {
          useTableStore.setState({
            phase: 'error',
            errorMsg: err instanceof Error ? err.message : String(err),
          });
        }
      }
    })();

    return () => {
      disposed = true;
      unsub();
    };
    // init 仅应执行一次（connId/db/obj 为静态 bootstrap 参数）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (phase === 'error') {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-3">
        <div className="text-destructive">{errorCodeToMessage(errorCode, errorMsg)}</div>
        <Button variant="secondary" onClick={() => void refresh()}>
          重试
        </Button>
      </div>
    );
  }

  const hasQuery = appliedWhere !== '' || appliedOrderBy !== '' || searchApplied !== '';
  const env = (window.__BOOTSTRAP__?.params.env ?? '') as 'dev' | 'test' | 'prod' | '';

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <Toolbar db={db} obj={obj} env={env === '' ? null : env} />
      {/* 自由条件栏是手写 SQL 片段（驱动规范 §4 whereSql/orderBySql），仅 supportsSQL 驱动渲染 */}
      {supportsSQL && <FilterBar />}
      {phase === 'ready' && rows.length === 0 && insertsLen === 0 ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 text-muted-foreground">
          <span>{t('table.noMatch')}</span>
          {hasQuery && (
            <Button variant="secondary" onClick={() => void clearFilters()}>
              {t('table.clearFilter')}
            </Button>
          )}
        </div>
      ) : (
        <DataGrid pageOffset={page * pageSize} />
      )}
      <PaginationBar />
      <ChangePreviewModal env={env === '' ? null : env} />
      <DdlModal />
      <CellViewerModal />
      <Toast />
    </div>
  );
}
