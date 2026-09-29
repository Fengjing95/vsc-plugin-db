import { useEffect, useState } from 'react';
import type { HandshakeResult, ResultSetPayload } from '@db-explorer/protocol';
import { request } from './rpc/client';

type Phase = 'connecting' | 'ready' | 'error';

export default function App() {
  const [phase, setPhase] = useState<Phase>('connecting');
  const [snapshot, setSnapshot] = useState<HandshakeResult | null>(null);
  const [table, setTable] = useState<ResultSetPayload | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // 1) 握手：校验协议版本 + 拿视图参数（M4 起同时恢复 ChangeSet 快照）
        const snap = await request<HandshakeResult>('sys.handshake', { stateId: null });
        if (cancelled) return;
        setSnapshot(snap);

        // 2) 取数：走完整 RPC 链路（Webview → Host → 驱动 → 数据）
        const p = snap.params;
        const rs = await request<ResultSetPayload>('table.fetchRows', {
          connId: p.connId,
          db: p.db,
          obj: p.obj,
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
  }, []);

  if (phase === 'connecting') {
    return <div className="status">连接 Extension Host…</div>;
  }
  if (phase === 'error') {
    return <div className="status error">加载失败：{error}</div>;
  }

  const p = snapshot!.params;
  return (
    <div className="wrap">
      <header>
        <h1>
          {p.obj} <span className="at">@ {p.db}</span>
        </h1>
        <span className="badge">M0 演示 · RPC 打通</span>
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
