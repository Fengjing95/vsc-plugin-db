// M8-B2 表结构编辑器场景：alter 态预载基线 + ddl.preview 语句集（含 destructive）
window.__DBX_STUB__ = {
  delayMs: 30,
  bootstrap: {
    page: 'tableDesign',
    viewId: 'tableDesign:c1/demo/users',
    params: { connId: 'c1', db: 'demo', obj: 'users' },
  },
  handlers: {
    'ddl.load': () => ({
      kind: 'alter',
      spec: {
        name: 'users',
        comment: '用户表',
        columns: [
          { name: 'id', dataType: 'bigint', nullable: false, isPrimaryKey: true, autoIncrement: true, ordinal: 1 },
          { name: 'uname', dataType: 'varchar(64)', nullable: false, isPrimaryKey: false, defaultValue: 'anon', comment: '名称', ordinal: 2 },
          { name: 'amount', dataType: 'int', nullable: true, isPrimaryKey: false, ordinal: 3 },
        ],
      },
    }),
    'ddl.preview': () => ({
      kind: 'alter',
      statements: [
        { sql: 'ALTER TABLE `demo`.`users` ADD COLUMN `status` varchar(16) NULL' },
        { sql: 'ALTER TABLE `demo`.`users` DROP COLUMN `amount`', destructive: true },
      ],
    }),
    'ddl.execute': () => ({ executed: 2 }),
  },
};
