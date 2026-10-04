// 键值源（Redis 能力态）表格页场景：验证复制菜单降级（仅 JSON/Markdown）
// + M7 cursor 透传：握手下行 pagination=cursor，handler 按 cursor 返回不同页（每页 2 行）
const ROWS = Array.from({ length: 5 }, (_, i) => [
  `user:${i + 1}`,
  i % 2 === 0 ? 'hash' : 'string',
  (i + 1) * 60,
  `值 ${i + 1}`,
]);

function pageByCursor(cursor) {
  // 浏览器侧无 Buffer：游标不透明串用 btoa（语义等价，驱动真实现是 base64url JSON）
  const start = cursor ? Number(atob(cursor)) : 0;
  const rows = ROWS.slice(start, start + 2);
  const nextStart = start + rows.length;
  const nextCursor = nextStart < ROWS.length ? btoa(String(nextStart)).replace(/=+$/, '') : undefined;
  return { rows, nextCursor };
}

window.__DBX_STUB__ = {
  delayMs: 20,
  bootstrap: {
    page: 'table',
    viewId: 'redis-view',
    params: { connId: 'c1', db: 'db0', obj: '*', env: 'dev', rowEstimate: '5' },
  },
  handlers: {
    'sys.copyText': (p) => ({ written: (p?.text ?? '').length }),
    'sys.handshake': () => ({
      protocolVersion: 1,
      viewId: 'redis-view',
      params: {},
      changeSet: { inserts: [], updates: [], deletes: [] },
      edit: { enabled: false, reason: '键值源不可编辑' },
      capabilities: { supportsSQL: false, supportsDdl: false, pagination: 'cursor' },
    }),
    'table.fetchRows': (p) => {
      const { rows, nextCursor } = pageByCursor(p?.cursor);
      return {
        columns: [
          { name: 'key', type: 'string' },
          { name: 'type', type: 'string' },
          { name: '__ttl', type: 'integer' },
          { name: 'value', type: 'json' },
        ],
        rows,
        rowCount: rows.length,
        primaryKey: ['key'],
        nextCursor,
        executionMs: 5,
      };
    },
  },
};
