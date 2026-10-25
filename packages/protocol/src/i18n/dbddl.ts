/** dbddl 域词表（D-25/C-17）：库级 DDL（新建/编辑库面板、驱动 getDatabaseFormSchema 键化与校验）。zh 值=原文案逐字节；en 同步对译。 */
export const zhDbddl = {
  // ── 驱动 getDatabaseFormSchema 字段 ──
  'dbddl.name': '库名',
  'dbddl.schemaName': 'Schema 名',
  'dbddl.charset': '字符集',
  'dbddl.collation': '排序规则',
  'dbddl.collection': '首个集合名',
  'dbddl.collectionHint': 'MongoDB 库在拥有首个集合后才会真正创建（空库不显示）',
  'dbddl.schemaNameHint.pg': '树上的「库」为 PostgreSQL schema（D-15，连接协议绑定单库）；删除 schema 将连带删其下全部表（CASCADE）',
  'dbddl.schemaNameHint.oracle': 'Oracle「库」= schema = 用户（ADR D-23）；创建后授予最小权限（会话/建对象/视图）并配 USERS 表空间无限配额',
  'dbddl.schemaNameHint.mssql': '树上的「库」为 SQL Server schema（ADR D-21，连接绑定单库）；删除 schema 仅对空 schema 成功（T-SQL 无 CASCADE）',
  'dbddl.password': '密码',
  'dbddl.passwordHint': 'CREATE USER 必需；预览 SQL 中掩码显示，仅随执行即时使用（C-10）',
  'dbddl.opt.charset.utf8mb4': 'utf8mb4（推荐，完整 Unicode）',
  'dbddl.opt.charset.utf8': 'utf8（3 字节，遗留）',
  'dbddl.opt.collation.utf8mb4_0900_ai_ci': 'utf8mb4_0900_ai_ci（MySQL 8 默认）',

  // ── 面板文案（DatabaseDesignPage）──
  'dbddl.title.new': '新建库',
  'dbddl.title.edit': '编辑库 · {0}',
  'dbddl.loadFailed': '加载失败：{0}',
  'dbddl.executeError': '第 {0} 条语句失败（{1}），已执行部分不回滚：{2}',
  'dbddl.previewButton': '预览 SQL',
  'dbddl.previewTitle': 'SQL 预览（{0} 条语句）',
  'dbddl.destructiveWarning': '⚠ {0} 条语句可能造成数据丢失，请逐条确认',
  'dbddl.backToEdit': '返回修改',
  'dbddl.executing': '执行中…',
  'dbddl.execute': '执行',

  // ── 校验消息（lib/databaseDesign.ts）──
  'dbddl.errRequired': '{0}为必填项',
  'dbddl.errNumber': '{0}需为数字',
  'dbddl.errFormat': '{0}格式不正确',
} as const;

export type DbddlKey = keyof typeof zhDbddl;

export const enDbddl: Partial<Record<DbddlKey, string>> = {
  // ── Driver getDatabaseFormSchema fields ──
  'dbddl.name': 'Database name',
  'dbddl.schemaName': 'Schema name',
  'dbddl.charset': 'Charset',
  'dbddl.collation': 'Collation',
  'dbddl.collection': 'First collection name',
  'dbddl.collectionHint':
    'A MongoDB database is only actually created once it owns its first collection (empty databases are not shown)',
  'dbddl.schemaNameHint.pg':
    '"Databases" in the tree are PostgreSQL schemas (D-15: the connection protocol binds a single database); dropping a schema also drops all tables inside it (CASCADE)',
  'dbddl.schemaNameHint.oracle':
    'An Oracle "database" = schema = user (ADR D-23); after creation the minimal privileges (session / create objects / views) are granted with an unlimited quota on the USERS tablespace',
  'dbddl.schemaNameHint.mssql':
    '"Databases" in the tree are SQL Server schemas (ADR D-21: the connection binds a single database); dropping a schema only succeeds when it is empty (T-SQL has no CASCADE)',
  'dbddl.password': 'Password',
  'dbddl.passwordHint': 'Required by CREATE USER; masked in the SQL preview and used only for immediate execution (C-10)',
  'dbddl.opt.charset.utf8mb4': 'utf8mb4 (recommended, full Unicode)',
  'dbddl.opt.charset.utf8': 'utf8 (3-byte, legacy)',
  'dbddl.opt.collation.utf8mb4_0900_ai_ci': 'utf8mb4_0900_ai_ci (MySQL 8 default)',

  // ── Panel texts (DatabaseDesignPage) ──
  'dbddl.title.new': 'New Database',
  'dbddl.title.edit': 'Edit Database · {0}',
  'dbddl.loadFailed': 'Failed to load: {0}',
  'dbddl.executeError': 'Statement {0} failed ({1}); executed statements are not rolled back: {2}',
  'dbddl.previewButton': 'Preview SQL',
  'dbddl.previewTitle': 'SQL Preview ({0} statements)',
  'dbddl.destructiveWarning': '⚠ {0} statements may cause data loss; review each one',
  'dbddl.backToEdit': 'Back to Edit',
  'dbddl.executing': 'Executing…',
  'dbddl.execute': 'Execute',

  // ── Validation (lib/databaseDesign.ts) ──
  'dbddl.errRequired': '{0} is required',
  'dbddl.errNumber': '{0} must be a number',
  'dbddl.errFormat': '{0} format is invalid',
};
