// Console 危险横幅场景（§7.4：无 WHERE 的 UPDATE → 面板顶部内联 [仍要执行][取消]）
window.__DBX_STUB__ = {
  delayMs: 30,
  bootstrap: {
    page: 'console',
    viewId: 'console-2',
    params: { consoleId: 'console-2' },
  },
  handlers: {
    'console.getState': () => ({
      bound: true,
      connLabel: '生产 MySQL',
      db: 'myapp',
      banner: {
        bannerId: 'banner-1',
        reasons: ['UPDATE 语句没有 WHERE 条件，将影响全表行'],
        sql: 'UPDATE users SET status = 1',
      },
      run: null,
    }),
  },
};
