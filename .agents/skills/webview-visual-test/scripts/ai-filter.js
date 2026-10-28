// AI P2A 批次 A1 场景：表格页筛选栏「✨ AI」弹层——自然语言生成 WHERE 片段回填（可过目可改）
window.__DBX_STUB__ = {
  delayMs: 60,
  bootstrap: {
    page: 'table',
    viewId: 'ai-filter-view',
    params: { connId: 'c1', db: 'demo', obj: 'orders', env: 'test', rowEstimate: '5000' },
  },
  handlers: {
    'sys.copyText': (p) => ({ written: (p?.text ?? '').length }),
    'sys.handshake': () => ({
      protocolVersion: 1,
      viewId: 'ai-filter-view',
      params: {},
      changeSet: { inserts: [], updates: [], deletes: [] },
      edit: { enabled: true },
      capabilities: { supportsSQL: true, supportsDdl: true },
    }),
    'table.fetchRows': () => {
      const columns = [
        { name: 'id', type: 'int' },
        { name: 'status', type: 'varchar' },
        { name: 'amount', type: 'decimal' },
        { name: 'created_at', type: 'datetime' },
      ];
      const rows = [
        [1, 'paid', '128.00', '2026-10-01 10:00:00.000'],
        [2, 'pending', '66.50', '2026-10-20 12:30:00.000'],
        [3, 'paid', '310.20', '2026-10-25 09:15:00.000'],
        [4, 'refunded', '88.00', '2026-10-27 18:40:00.000'],
        [5, 'pending', '12.90', '2026-10-28 08:05:00.000'],
      ];
      return { columns, rows, rowCount: rows.length, totalCount: 5000, primaryKey: ['id'], executionMs: 8 };
    },
    'table.editChanges': () => ({ counts: { inserts: 0, updates: 0, deletes: 0 } }),
    // A1：ai.generateFilter 返回 WHERE 片段（Host 已消毒）——断言回填的是片段文本且不自动执行
    'ai.generateFilter': (p) => {
      window.__AI_FILTER_CALLED__ = p;
      return { whereSql: "status = 'paid' AND amount > 100" };
    },
    'table.metadata': () => ({
      objects: [],
      columns: [
        { name: 'id', type: 'int', isPrimaryKey: true, ordinal: 1 },
        { name: 'status', type: 'varchar', ordinal: 2 },
        { name: 'amount', type: 'decimal', ordinal: 3 },
        { name: 'created_at', type: 'datetime', ordinal: 4 },
      ],
    }),
  },
};
