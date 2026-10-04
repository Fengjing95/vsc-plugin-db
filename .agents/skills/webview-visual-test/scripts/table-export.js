// M8-B1 导出后台化场景：export.run 即时回执 exportId → chip 出现 → progress 增长 → 取消清除
// （progress/done evt 帧由浏览器自动化侧手动派发，见 SKILL 流程）
window.__DBX_STUB__ = {
  delayMs: 40,
  bootstrap: {
    page: 'table',
    viewId: 'export-view',
    params: { connId: 'c1', db: 'demo', obj: 'users', env: 'test', rowEstimate: '5000' },
  },
  handlers: {
    'sys.copyText': (p) => ({ written: (p?.text ?? '').length }),
    'sys.handshake': () => ({
      protocolVersion: 1,
      viewId: 'export-view',
      params: {},
      changeSet: { inserts: [], updates: [], deletes: [] },
      edit: { enabled: false, reason: '场景只读' },
      capabilities: { supportsSQL: true, supportsDdl: false, pagination: 'offset' },
    }),
    'table.fetchRows': () => {
      const columns = [
        { name: 'id', type: 'integer' },
        { name: 'name', type: 'string' },
        { name: 'email', type: 'string' },
        { name: 'amount', type: 'decimal' },
      ];
      const rows = [];
      for (let i = 1; i <= 20; i++) {
        rows.push([i, `用户${i}`, `user${i}@example.com`, (i * 13.5).toFixed(2)]);
      }
      return { columns, rows, rowCount: rows.length, totalCount: 5000, primaryKey: ['id'], executionMs: 12 };
    },
    'export.run': () => ({ exportId: 'exp-m8-1' }),
    'export.cancel': () => ({}),
  },
};
