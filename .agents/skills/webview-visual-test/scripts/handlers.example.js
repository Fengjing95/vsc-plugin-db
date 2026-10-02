// 表格页默认场景（浏览器侧 JS，非 node 模块；可复制改名后编辑 handlers 即为新场景）
// 注意：handler 收到的 params 即 Webview 下发的请求参数（如 table.fetchRows 的
// whereSql/orderBySql/filters/sorts）——静态数据场景可直接忽略，要验证查询逻辑时需在
// handler 内按 params 过滤/排序（参考真实驱动语义）
window.__DBX_STUB__ = {
  delayMs: 60,
  bootstrap: {
    page: 'table',
    viewId: 'preview-view',
    params: { connId: 'c1', db: 'demo', obj: 'users', env: 'test', rowEstimate: '5000' },
  },
  handlers: {
    'sys.handshake': () => ({
      protocolVersion: 1,
      viewId: 'preview-view',
      params: {},
      changeSet: { inserts: [], updates: [], deletes: [] },
      edit: { enabled: true },
      capabilities: { supportsSQL: true, supportsDdl: true },
    }),
    'table.fetchRows': () => {
      const pad = (n) => String(n).padStart(2, '0');
      const dt = (i) => `2026-09-${pad((i % 28) + 1)} ${pad(i % 24)}:${pad((i * 7) % 60)}:00.000`;
      const columns = [
        { name: 'id', type: 'int' },
        { name: 'name', type: 'varchar' },
        { name: 'email', type: 'varchar' },
        { name: 'amount', type: 'decimal' },
        { name: 'created_at', type: 'datetime' },
        { name: 'note', type: 'varchar' },
      ];
      const rows = [];
      for (let i = 1; i <= 30; i++) {
        rows.push([i, `用户${i}`, `user${i}@example.com`, (i * 13.5).toFixed(2), dt(i), i % 5 === 0 ? null : `备注 ${i}`]);
      }
      return { columns, rows, rowCount: rows.length, totalCount: 5000, primaryKey: ['id'], executionMs: 12 };
    },
    'table.editChanges': () => ({ counts: { inserts: 0, updates: 0, deletes: 0 } }),
    'table.previewChanges': () => ({
      items: [
        { kind: 'update', rowKey: { id: 3 }, sql: 'UPDATE `demo`.`users` SET `name` = ?, `amount` = ? WHERE `id` = ?', params: ['张三改', '88.50', 3] },
        { kind: 'insert', tempId: 't-1', sql: 'INSERT INTO `demo`.`users` (`name`, `email`) VALUES (?, ?)', params: ['新用户', 'new@example.com'] },
      ],
    }),
    'table.applyChanges': () => ({
      items: [{ kind: 'insert', tempId: 't-1', rowKey: { id: 5001 }, sql: 'INSERT INTO `demo`.`users` (`name`) VALUES (?)', affectedRows: 1 }],
      executionMs: 9,
    }),
    'table.getDdl': () => ({
      ddl: "CREATE TABLE `users` (\n  `id` int NOT NULL AUTO_INCREMENT COMMENT '主键',\n  `name` varchar(64) NOT NULL,\n  PRIMARY KEY (`id`)\n) ENGINE=InnoDB;\n",
    }),
    'export.run': () => ({ filePath: '/tmp/export.csv', rows: 30, bytes: 2048 }),
  },
};
