import type { HandshakeResult, ResultSetPayload } from '@db-explorer/protocol';
import { useEffect, useState } from 'react';
import { request } from '../rpc/client';

type Phase = 'connecting' | 'ready' | 'error';

/** 表格视图（M0 演示版；M3 起替换为 TanStack Table 虚拟网格） */
export function TablePage({ connId, db, obj }: { connId: string; db: string; obj: string }) {
  const [phase, setPhase] = useState<Phase>('connecting');
  const [table, setTable] = useState<ResultSetPayload | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // 1) 握手：校验协议版本（M4 起同时恢复 ChangeSet 快照）
        await request<HandshakeResult>('sys.handshake', { stateId: null });
        if (cancelled) return;

        // 2) 取数：走完整 RPC 链路（Webview → Host → 驱动 → 数据）
        const rs = await request<ResultSetPayload>('table.fetchRows', {
          connId,
          db,
          obj,
          limit: 50,
        });
        if (cancelled) return;
        setTable(rs);
        setPhase('ready');
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
          setPhase('error');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [connId, db, obj]);

  if (phase === 'connecting') {
    return <div className="status">连接 Extension Host…</div>;
  }
  if (phase === 'error') {
    return <div className="status error">加载失败：{error}</div>;
  }

  return (
    <div className="wrap">
      <header>
        <h1>
          {obj} <span className="at">@ {db}</span>
        </h1>
        <span className="badge">M1 · RPC 打通</span>
      </header>

      {table ? (
        <>
          <div className="meta">
            第 1-{table.rowCount} 行 · 共 {table.totalCount ?? '—'} 行 · {table.executionMs}ms
            {table.truncated ? ' · 已截断' : ''}
          </div>
          <div className="grid">
            <table>
              <thead>
                <tr>
                  {table.columns.map((c) => (
                    <th key={c.name}>{c.name}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {table.rows.map((row, i) => (
                  <tr key={i}>
                    {row.map((cell, j) => (
                      <td key={j}>{renderCell(cell)}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : (
        <div className="status">加载数据中…</div>
      )}
    </div>
  );
}

function renderCell(cell: unknown): string {
  if (cell === null || cell === undefined) {
    return 'NULL';
  }
  if (typeof cell === 'object') {
    return JSON.stringify(cell);
  }
  return String(cell);
}
