// Console 结果面板场景（DoD-3：多结果 Tab + 消息 Tab + truncated 黄字 + 状态行）
window.__DBX_STUB__ = {
  delayMs: 30,
  bootstrap: {
    page: 'console',
    viewId: 'console-1',
    params: { consoleId: '' },
  },
  handlers: {
    'console.getState': () => ({
      consoleId: 'console-1',
      bound: true,
      connLabel: '本地 Mock 数据源',
      db: 'demo',
      run: {
        consoleId: 'console-1',
        runId: 'run-1',
        startedAt: Date.now() - 120,
        durationMs: 120,
        status: 'ok',
        items: [
          {
            seq: 1,
            sql: 'SELECT id, name, email, amount, created_at FROM users WHERE status = \'paid\' ORDER BY amount DESC',
            executionMs: 12,
            resultSet: {
              columns: [
                { name: 'id', type: 'integer' },
                { name: 'name', type: 'string' },
                { name: 'email', type: 'string' },
                { name: 'amount', type: 'decimal' },
                { name: 'created_at', type: 'datetime' },
              ],
              rows: Array.from({ length: 50 }, (_, i) => [
                i + 1,
                `用户${i + 1}`,
                `user${i + 1}@example.com`,
                `${(i * 15.5).toFixed(2)}`,
                '2024-02-01 12:00:00',
              ]),
              rowCount: 50,
              executionMs: 12,
            },
          },
          {
            seq: 2,
            sql: "UPDATE users SET status = 'paid' WHERE id < 51",
            executionMs: 8,
            affectedRows: 50,
            messages: ['Notes: 50 rows matched'],
          },
          {
            seq: 3,
            sql: 'SELECT id, name, note FROM demo.wide',
            executionMs: 45,
            resultSet: {
              columns: [
                { name: 'id', type: 'integer' },
                { name: 'name', type: 'string' },
                { name: 'note', type: 'string' },
              ],
              rows: Array.from({ length: 1000 }, (_, i) => [
                i + 1,
                `用户${i + 1}`,
                i % 4 === 0 ? null : `备注文本 ${i + 1}`,
              ]),
              rowCount: 1000,
              executionMs: 45,
              truncated: true,
            },
          },
        ],
      },
    }),
  },
};
