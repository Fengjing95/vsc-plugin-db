// M8-B2 新建表场景（create 态：obj 缺省 → 空白模板一行）
window.__DBX_STUB__ = {
  delayMs: 30,
  bootstrap: {
    page: 'tableDesign',
    viewId: 'tableDesign:c1/demo/:new',
    params: { connId: 'c1', db: 'demo', obj: '' },
  },
  handlers: {
    'ddl.load': () => ({ kind: 'create', spec: null }),
    'ddl.preview': () => ({
      kind: 'create',
      statements: [
        {
          sql: 'CREATE TABLE `demo`.`orders_new` (\n  `id` bigint NOT NULL AUTO_INCREMENT,\n  `title` varchar(64) NOT NULL,\n  PRIMARY KEY (`id`)\n) COMMENT=\'新表\'',
        },
      ],
    }),
    'ddl.execute': () => ({ executed: 1 }),
  },
};
