// M8-B2 表结构编辑器场景：alter 态预载基线 + ddl.preview 语句集（含 destructive）
// bootstrap.params.focusColumn 模拟「列节点 → 编辑列」入口：打开后应聚焦该列的列名输入框
window.__DBX_STUB__ = {
  delayMs: 30,
  bootstrap: {
    page: 'tableDesign',
    viewId: 'tableDesign:c1/demo/users',
    params: { connId: 'c1', db: 'demo', obj: 'users', focusColumn: 'amount' },
  },
  handlers: {
    'ddl.load': () => ({
      kind: 'alter',
      // 表设计器批次 A：类型建议词表（验证列 Tab 建议下拉）
      dataTypes: [
        { value: 'INT' },
        { value: 'BIGINT' },
        { value: 'VARCHAR', template: 'VARCHAR()' },
        { value: 'TEXT' },
        { value: 'DECIMAL', template: 'DECIMAL(,)' },
        { value: 'DATETIME' },
        { value: 'TIMESTAMP' },
        { value: 'DATE' },
        { value: 'BOOLEAN' },
        { value: 'JSON' },
      ],
      // 表设计器批次 B：Tab 能力（键/外键/索引全开）
      features: {
        uniqueKeys: true,
        foreignKeys: true,
        foreignKeyAlter: true,
        indexes: true,
        indexTypes: ['BTREE', 'HASH'],
      },
      spec: {
        name: 'users',
        comment: '用户表',
        columns: [
          { name: 'id', dataType: 'bigint', nullable: false, isPrimaryKey: true, autoIncrement: true, ordinal: 1 },
          { name: 'uname', dataType: 'varchar(64)', nullable: false, isPrimaryKey: false, defaultValue: 'anon', comment: '名称', ordinal: 2 },
          { name: 'amount', dataType: 'int', nullable: true, isPrimaryKey: false, ordinal: 3 },
        ],
        uniqueKeys: [{ name: 'uk_users_uname', columns: ['uname'] }],
        foreignKeys: [{ name: 'fk_users_dept', columns: ['amount'], refTable: 'department', refColumns: ['id'] }],
        indexes: [{ name: 'idx_users_uname', columns: ['uname'], unique: false }],
      },
    }),
    'ddl.refTables': () => ({ tables: ['department', 'orders', 'users'] }),
    'ddl.refColumns': (params) => ({ columns: params.table === 'department' ? ['id', 'dept_name'] : ['id'] }),
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
