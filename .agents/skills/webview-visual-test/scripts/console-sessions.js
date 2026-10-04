// M8-B1 会话 Tab 场景：3 个会话（活动/事务中/执行中），验证 Tab 栏渲染与点击切换
window.__DBX_STUB__ = {
  delayMs: 30,
  bootstrap: {
    page: 'console',
    viewId: 'console-result',
    params: { consoleId: '' },
  },
  handlers: {
    'console.list': () => ({
      consoles: [
        { consoleId: 'console-1', connLabel: '本地 Mock', db: 'demo', running: false, txnActive: false, hasRun: true, lastRunAt: 100 },
        { consoleId: 'console-2', connLabel: '生产库', db: 'orders', running: false, txnActive: true, hasRun: true, lastRunAt: 90 },
        { consoleId: 'console-3', connLabel: '本地 Mock', db: 'wide', running: true, txnActive: false, hasRun: false, lastRunAt: null },
      ],
      activeConsoleId: 'console-1',
    }),
    'console.getState': (p) => {
      const id = p && p.consoleId ? p.consoleId : 'console-1';
      if (id === 'console-2') {
        return {
          consoleId: 'console-2',
          bound: true,
          connLabel: '生产库',
          db: 'orders',
          banner: null,
          run: {
            consoleId: 'console-2',
            runId: 'run-2',
            startedAt: Date.now() - 80,
            durationMs: 80,
            status: 'ok',
            items: [
              {
                seq: 1,
                sql: "UPDATE orders SET status = 'shipped' WHERE amount > 100",
                executionMs: 21,
                affectedRows: 18,
              },
            ],
          },
        };
      }
      return {
        consoleId: 'console-1',
        bound: true,
        connLabel: '本地 Mock',
        db: 'demo',
        banner: null,
        run: {
          consoleId: 'console-1',
          runId: 'run-1',
          startedAt: Date.now() - 120,
          durationMs: 120,
          status: 'ok',
          items: [
            {
              seq: 1,
              sql: 'SELECT id, name, email FROM users LIMIT 3',
              executionMs: 12,
              resultSet: {
                columns: [
                  { name: 'id', type: 'integer' },
                  { name: 'name', type: 'string' },
                  { name: 'email', type: 'string' },
                ],
                rows: [
                  [1, '用户1', 'user1@example.com'],
                  [2, '用户2', 'user2@example.com'],
                  [3, '用户3', 'user3@example.com'],
                ],
                rowCount: 3,
                executionMs: 12,
              },
            },
          ],
        },
      };
    },
  },
};
