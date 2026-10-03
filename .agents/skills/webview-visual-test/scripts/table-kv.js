// 键值源（Redis 能力态）表格页场景：验证复制菜单按 supportsSQL 降级（仅 JSON/Markdown）
window.__DBX_STUB__ = {
  delayMs: 30,
  bootstrap: {
    page: 'table',
    viewId: 'redis-view',
    params: { connId: 'c1', db: 'db0', obj: '*', env: 'dev', rowEstimate: '3000' },
  },
  handlers: {
    'sys.copyText': (p) => ({ written: (p?.text ?? '').length }),
    'sys.handshake': () => ({
      protocolVersion: 1,
      viewId: 'redis-view',
      params: {},
      changeSet: { inserts: [], updates: [], deletes: [] },
      edit: { enabled: false, reason: '键值源不可编辑' },
      capabilities: { supportsSQL: false, supportsDdl: false },
    }),
    'table.fetchRows': () => {
      const rows = [];
      for (let i = 1; i <= 25; i++) {
        rows.push([`user:${i}`, i % 3 === 0 ? 'string' : 'hash', i * 60, i % 4 === 0 ? 'eyJhIjoxfQ==' : `值 ${i}`]);
      }
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
        executionMs: 8,
      };
    },
  },
};
