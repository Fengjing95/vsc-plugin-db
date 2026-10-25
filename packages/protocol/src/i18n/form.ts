/** form 域词表（D-25/C-17）：连接表单（驱动 FormSchema label/placeholder/hint/section 键化——webview 渲染时经 formText 解析，未登记文本原样展示以兼容第三方驱动）。zh 值=原文案逐字节；en 同步对译。 */
export const zhForm = {
  // ── 跨驱动共用字段（同义字段同键）──
  'form.host': '主机',
  'form.port': '端口',
  'form.username': '用户名',
  'form.password': '密码',
  'form.database': '默认库',
  'form.connectTimeout': '连接超时（ms）',
  'form.poolMax': '连接池上限',
  'form.ssl.enable': '启用 SSL',
  'form.ssl.insecure': '跳过证书校验',
  'form.group.advanced': '高级',
  'form.section.timeoutPool': '超时与连接池',
  'form.section.timeout': '超时',
  'form.section.ssl': 'SSL',
  'form.section.sslTls': 'SSL/TLS',

  // ── PostgreSQL 特有 ──
  'form.pg.dbHint': 'PG 数据库名（连接级绑定，PG 协议不可跨库切换）；树上展开的「库」为该数据库内的 schema',
  'form.pg.sslInsecureHint': '不校验服务器证书（sslmode=require）——存在中间人风险，仅用于开发/自签环境',

  // ── MongoDB 特有 ──
  'form.mongo.usernameOptional': '用户名（可选）',
  'form.mongo.passwordHint': '留空 = 免认证实例',
  'form.mongo.authDatabase': '认证库（authSource）',
  'form.mongo.databaseOptional': '默认库（可选）',
  'form.mongo.dbHint': '树上的「库」为 MongoDB database（非库内 schema）',
  'form.mongo.directConnection': '单机直连',
  'form.mongo.directConnectionHint': 'IP 直连目标的最稳口径；副本集自动发现可关闭',

  // ── SQL Server 特有 ──
  'form.mssql.instanceName': '实例名',
  'form.mssql.instanceNameHint': '命名实例（SQLEXPRESS 等）经 SQL Browser 解析；填写后端口字段被忽略',
  'form.mssql.dbHint': '连接绑定的 SQL Server 数据库；树上展开的「库」为该数据库内的 schema',
  'form.mssql.encrypt': '启用加密（Encrypt）',
  'form.mssql.sslInsecureHint': '不校验服务器证书（trustServerCertificate）——存在中间人风险，仅用于开发/自签环境',

  // ── Oracle 特有 ──
  'form.oracle.serviceName': '服务名',
  'form.oracle.serviceNameHint':
    'Oracle 服务名（service name）或 SID：PDB 应用连接填其注册服务名（如 orcl）；CDB 默认服务与 SID 同名可直填。树上展开的「库」为该容器内的 schema（ADR D-23）',
  'form.oracle.connectString': '连接串（完整）',
  'form.oracle.connectStringPlaceholder': '(DESCRIPTION=…) 或 host:port/service',
  'form.oracle.connectStringHint': '完整 EZConnect/TNS 描述符或 tnsnames 别名——填写后忽略主机/端口/服务名（RAC/SCAN/LDAP 等场景）',
  'form.oracle.sysdba': '以 SYSDBA 连接',
  'form.oracle.sysdbaHint': '数据库管理员身份（privilege=SYSDBA），用于管理场景（如浏览全部 schema）；普通应用账号保持关闭',
  'form.section.descriptor': '连接描述符',
  'form.section.identity': '身份',

  // ── Redis 特有 ──
  'form.redis.usernameAcl': '用户名（ACL，可选）',
  'form.redis.dbIndex': '默认库编号',
  'form.redis.sslEnable': 'SSL/TLS 加密连接',
  'form.redis.sslEnableHint': '云托管 Redis（Upstash / Redis Cloud / Aiven 等）强制 TLS，须开启',
  'form.redis.sslInsecureHint': '⚠ 风险：不校验服务器证书，连接可被中间人窃听/篡改。仅限自签证书的受信内网环境使用',

  // ── SQLite 特有 ──
  'form.sqlite.path': '数据库文件路径',
  'form.sqlite.pathHint': 'SQLite 单文件数据库；支持 ~（主目录）与相对工作区路径；文件必须已存在（不会自动创建）',
  'form.sqlite.readonly': '以只读打开',
  'form.sqlite.readonlyHint': '只读模式下拒绝写入语句，且永不写回文件',

  // ── Mock 特有 ──
  'form.mock.readonly': '只读打开',

  // ── 页面自有文案（ConnectionFormPage）──
  'form.title.new': '新建连接',
  'form.title.edit': '编辑连接',
  'form.subtitle': '字段由驱动定义；保存不强制先测试，但建议先验证连通性',
  'form.driverType': '数据库类型',
  'form.driverLockedTitle': '编辑连接不可更改数据库类型',
  'form.driverLockedNote': '编辑连接不可更改数据库类型（如需更换请新建连接）',
  'form.name': '名称',
  'form.namePlaceholder': '如：本地 MySQL',
  'form.section.params': '连接参数',
  'form.section.env': '环境与保护',
  'form.aria.env': '环境',
  'form.env.dev': '开发',
  'form.env.test': '测试',
  'form.env.prod': '生产',
  'form.readonly': '只读保护',
  'form.readonlyHint': '开启后 Host 层拒绝一切写操作',
  'form.prodWarning': '生产环境：所有写操作与危险语句将强制二次确认（输入名称匹配），该约束不可关闭',
  'form.advanced': '高级选项',
  'form.chipOn': '{0} · 开',
  'form.on': '开启',
  'form.off': '关闭',
  'form.passwordStored': '●●●●●●（留空保持不变）',
  'form.hidePassword': '隐藏密码',
  'form.showPassword': '显示密码',
  'form.browse': '浏览…',
  'form.aria.browse': '浏览{0}',
  'form.pickFileTitle': '选择{0}',
  'form.aria.dbSuggest': '{0}建议',

  // ── 测试连接状态卡 ──
  'form.test.idle': 'ⓘ 尚未测试（保存不强制先测试）',
  'form.test.testing': '⏳ 正在测试连接…',
  'form.test.ok': '✓ 连接成功',
  'form.test.fail': '✗ [{0}] {1}',
  'form.test.failed': '连接失败',
  'form.test.button': '测试连接',
  'form.save': '保存',
  'form.switchDriverFailed': '切换驱动失败：{0}',

  // ── 校验消息 ──
  'form.err.nameRequired': '请输入连接名称',
  'form.err.driverRequired': '请选择数据库类型',
  'form.err.required': '请输入{0}',
  'form.err.number': '请输入数字',
  'form.err.port': '端口范围 1-65535',
  'form.err.format': '{0} 格式不正确',
} as const;

export type FormKey = keyof typeof zhForm;

export const enForm: Partial<Record<FormKey, string>> = {
  // ── Shared fields ──
  'form.host': 'Host',
  'form.port': 'Port',
  'form.username': 'Username',
  'form.password': 'Password',
  'form.database': 'Default database',
  'form.connectTimeout': 'Connect timeout (ms)',
  'form.poolMax': 'Max pool size',
  'form.ssl.enable': 'Enable SSL',
  'form.ssl.insecure': 'Skip certificate verification',
  'form.group.advanced': 'Advanced',
  'form.section.timeoutPool': 'Timeouts & Pool',
  'form.section.timeout': 'Timeout',
  'form.section.ssl': 'SSL',
  'form.section.sslTls': 'SSL/TLS',

  // ── PostgreSQL ──
  'form.pg.dbHint':
    'PostgreSQL database name (bound at connection level; the PG protocol cannot switch databases within a connection); "databases" shown in the tree are schemas inside this database',
  'form.pg.sslInsecureHint':
    'Skips server certificate verification (sslmode=require) — vulnerable to man-in-the-middle; development/self-signed environments only',

  // ── MongoDB ──
  'form.mongo.usernameOptional': 'Username (optional)',
  'form.mongo.passwordHint': 'Leave empty for instances without authentication',
  'form.mongo.authDatabase': 'Auth database (authSource)',
  'form.mongo.databaseOptional': 'Default database (optional)',
  'form.mongo.dbHint': '"Databases" in the tree are MongoDB databases (not schemas)',
  'form.mongo.directConnection': 'Direct connection',
  'form.mongo.directConnectionHint':
    'Most reliable mode for direct IP targets; disable for automatic replica set discovery',

  // ── SQL Server ──
  'form.mssql.instanceName': 'Instance name',
  'form.mssql.instanceNameHint':
    'Named instances (SQLEXPRESS etc.) are resolved via SQL Browser; the port field is ignored when set',
  'form.mssql.dbHint':
    'SQL Server database bound to the connection; "databases" in the tree are schemas inside this database',
  'form.mssql.encrypt': 'Enable encryption (Encrypt)',
  'form.mssql.sslInsecureHint':
    'Skips server certificate verification (trustServerCertificate) — vulnerable to man-in-the-middle; development/self-signed environments only',

  // ── Oracle ──
  'form.oracle.serviceName': 'Service name',
  'form.oracle.serviceNameHint':
    'Oracle service name or SID: PDB applications use the registered service name (e.g. orcl); the CDB default service shares its SID name and can be used directly. "Databases" in the tree are schemas inside this container (ADR D-23)',
  'form.oracle.connectString': 'Connect string (full)',
  'form.oracle.connectStringPlaceholder': '(DESCRIPTION=…) or host:port/service',
  'form.oracle.connectStringHint':
    'Full EZConnect/TNS descriptor or tnsnames alias — host/port/service name are ignored when set (RAC/SCAN/LDAP scenarios)',
  'form.oracle.sysdba': 'Connect as SYSDBA',
  'form.oracle.sysdbaHint':
    'Administrative privilege (privilege=SYSDBA) for management scenarios (e.g. browsing all schemas); keep off for regular application accounts',
  'form.section.descriptor': 'Connect descriptor',
  'form.section.identity': 'Identity',

  // ── Redis ──
  'form.redis.usernameAcl': 'Username (ACL, optional)',
  'form.redis.dbIndex': 'Default database index',
  'form.redis.sslEnable': 'SSL/TLS encrypted connection',
  'form.redis.sslEnableHint': 'Cloud-hosted Redis (Upstash / Redis Cloud / Aiven etc.) enforces TLS — enable this',
  'form.redis.sslInsecureHint':
    '⚠ Risk: the server certificate is not verified; the connection can be intercepted or tampered with. Trusted intranets with self-signed certificates only',

  // ── SQLite ──
  'form.sqlite.path': 'Database file path',
  'form.sqlite.pathHint':
    'SQLite single-file database; supports ~ (home directory) and workspace-relative paths; the file must already exist (it is never created automatically)',
  'form.sqlite.readonly': 'Open read-only',
  'form.sqlite.readonlyHint': 'Write statements are rejected in read-only mode and the file is never written back',

  // ── Mock ──
  'form.mock.readonly': 'Open read-only',

  // ── Page texts (ConnectionFormPage) ──
  'form.title.new': 'New Connection',
  'form.title.edit': 'Edit Connection',
  'form.subtitle': 'Fields are defined by the driver; testing before saving is not required, but verifying connectivity is recommended',
  'form.driverType': 'Database Type',
  'form.driverLockedTitle': 'Database type cannot be changed when editing a connection',
  'form.driverLockedNote': 'Database type cannot be changed when editing a connection (create a new connection to switch)',
  'form.name': 'Name',
  'form.namePlaceholder': 'e.g. Local MySQL',
  'form.section.params': 'Connection Parameters',
  'form.section.env': 'Environment & Protection',
  'form.aria.env': 'Environment',
  'form.env.dev': 'Development',
  'form.env.test': 'Test',
  'form.env.prod': 'Production',
  'form.readonly': 'Read-only',
  'form.readonlyHint': 'When enabled, the Host layer rejects all write operations',
  'form.prodWarning':
    'Production: all write operations and dangerous statements require a second confirmation (type the name to match); this cannot be disabled',
  'form.advanced': 'Advanced',
  'form.chipOn': '{0} · On',
  'form.on': 'On',
  'form.off': 'Off',
  'form.passwordStored': '●●●●●● (leave empty to keep unchanged)',
  'form.hidePassword': 'Hide password',
  'form.showPassword': 'Show password',
  'form.browse': 'Browse…',
  'form.aria.browse': 'Browse {0}',
  'form.pickFileTitle': 'Select {0}',
  'form.aria.dbSuggest': '{0} suggestions',

  // ── Test connection status card ──
  'form.test.idle': 'ⓘ Not tested yet (testing before saving is not required)',
  'form.test.testing': '⏳ Testing connection…',
  'form.test.ok': '✓ Connected',
  'form.test.fail': '✗ [{0}] {1}',
  'form.test.failed': 'Connection failed',
  'form.test.button': 'Test Connection',
  'form.save': 'Save',
  'form.switchDriverFailed': 'Failed to switch driver: {0}',

  // ── Validation ──
  'form.err.nameRequired': 'Enter a connection name',
  'form.err.driverRequired': 'Select a database type',
  'form.err.required': 'Enter {0}',
  'form.err.number': 'Enter a number',
  'form.err.port': 'Port must be 1-65535',
  'form.err.format': '{0} format is invalid',
};
