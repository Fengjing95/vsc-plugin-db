import type { HandshakeResult } from '@db-explorer/protocol';
import {
  ExportProgressEventSchema,
  RPC_PROTOCOL_VERSION,
  RpcEvents,
} from '@db-explorer/protocol';
import { useEffect } from 'react';
import { Button } from '../components/ui/button';
import { errorCodeToMessage } from '../lib/errors';
import { request, subscribeEvents } from '../rpc/client';
import { useTableStore } from '../store/tableStore';
import { DataGrid } from './table/DataGrid';
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
 * 表格视图（M3 只读）：工具栏 / 筛选栏 / 虚拟网格 / 分页栏。
 * 生命周期：sys.handshake（协议版本校验）→ 初始化 store → 首屏取数。
 */
export function TablePage({ connId, db, obj, rowEstimate, readOnly }: TablePageProps) {
  const phase = useTableStore((s) => s.phase);
  const errorMsg = useTableStore((s) => s.errorMsg);
  const errorCode = useTableStore((s) => s.errorCode);
  const rows = useTableStore((s) => s.rows);
  const refresh = useTableStore((s) => s.refresh);
  const clearFilters = useTableStore((s) => s.clearFilters);
  const appliedDrafts = useTableStore((s) => s.appliedDrafts);
  const searchApplied = useTableStore((s) => s.searchApplied);
  const setExportProgress = useTableStore((s) => s.setExportProgress);
  const page = useTableStore((s) => s.page);
  const pageSize = useTableStore((s) => s.pageSize);

  useEffect(() => {
    let disposed = false;
    const unsub = subscribeEvents((evt) => {
      if (evt.event === RpcEvents.exportProgress) {
        const parsed = ExportProgressEventSchema.safeParse(evt.payload);
        if (parsed.success) {
          setExportProgress({ rows: parsed.data.rows, bytes: parsed.data.bytes });
        }
      }
    });

    void (async () => {
      try {
        // 1) 握手：协议版本协商（概要设计 7.4.3）
        const hs = await request<HandshakeResult>('sys.handshake', { stateId: null });
        if (disposed) return;
        if (hs.protocolVersion !== RPC_PROTOCOL_VERSION) {
          useTableStore.setState({
            phase: 'error',
            errorMsg: '插件与视图版本不一致，请重载窗口',
          });
          return;
        }

        // 2) 初始化并取数（M4 起握手同时恢复 ChangeSet 快照）
        useTableStore.getState().init({ connId, db, obj, rowEstimate, readOnly });
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

  const hasQuery = appliedDrafts.length > 0 || searchApplied !== '';

  return (
    <div className="flex h-screen flex-col">
      <Toolbar db={db} obj={obj} />
      <FilterBar />
      {phase === 'ready' && rows.length === 0 ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 text-muted-foreground">
          <span>无匹配数据</span>
          {hasQuery && (
            <Button variant="secondary" onClick={() => void clearFilters()}>
              清除筛选
            </Button>
          )}
        </div>
      ) : (
        <DataGrid pageOffset={page * pageSize} />
      )}
      <PaginationBar />
    </div>
  );
}
