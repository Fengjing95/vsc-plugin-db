// EXPLAIN 执行计划场景（D-13：树形缩进）+ 交互式事务消息 Tab（§4.6）
window.__DBX_STUB__ = {
  delayMs: 30,
  bootstrap: {
    page: 'console',
    viewId: 'console-plan',
    params: { consoleId: '' },
  },
  handlers: {
    'sys.copyText': (p) => ({ written: (p?.text ?? '').length }),
    'console.getState': () => ({
      consoleId: 'console-plan',
      bound: true,
      connLabel: '本地 MySQL',
      db: 'demo',
      run: {
        consoleId: 'console-plan',
        runId: 'run-plan',
        startedAt: Date.now() - 90,
        durationMs: 90,
        status: 'ok',
        items: [
          {
            seq: 1,
            sql: 'EXPLAIN SELECT u.name, o.amount FROM users u JOIN orders o ON o.user_id = u.id WHERE u.id = 7',
            executionMs: 9,
            resultSet: {
              columns: [
                { name: 'id', type: 'integer' },
                { name: 'select_type', type: 'string' },
                { name: 'table', type: 'string' },
                { name: 'type', type: 'string' },
                { name: 'key', type: 'string' },
                { name: 'rows', type: 'integer' },
                { name: 'Extra', type: 'string' },
              ],
              rows: [
                [1, 'PRIMARY', 'u', 'const', 'PRIMARY', 1, ''],
                [1, 'PRIMARY', 'o', 'ref', 'fk_user', 3, 'Using where'],
                [2, 'SUBQUERY', 's', 'index', 'idx_email', 500, 'Using index'],
                [3, 'SUBQUERY2', 'x', 'ALL', null, 2000, 'Using where'],
              ],
              rowCount: 4,
              executionMs: 9,
            },
          },
          {
            seq: 2,
            sql: 'BEGIN',
            executionMs: 1,
            affectedRows: 0,
            messages: ['事务已开启（COMMIT 提交 / ROLLBACK 回滚；空闲超时自动回滚）'],
          },
        ],
      },
    }),
    'console.export': () => ({ filePath: '/tmp/x.xlsx', rows: 4, bytes: 4096 }),
  },
};
