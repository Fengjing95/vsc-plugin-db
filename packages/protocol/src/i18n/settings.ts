/** settings 域词表（D-25/C-17）：设置中心（分类导航 / AI 辅助 / 查询与导出 / 关于）。zh 值=原文案逐字节；en 同步对译。 */
export const zhSettings = {
  // ── 分类导航（SettingsPage）──
  'settings.category.ai': 'AI 辅助',
  'settings.category.queryExport': '查询与导出',
  'settings.category.about': '关于',
  'settings.aria.categories': '设置分类',

  // ── AI 辅助（AiSection）──
  'settings.ai.title': 'AI 设置',
  'settings.ai.desc': '配置 OpenAI 兼容的模型服务（OpenAI / DeepSeek / Moonshot / ollama / 企业网关等均可）。',
  'settings.ai.endpoint': 'API 地址',
  'settings.ai.apiKey': 'API 密钥',
  'settings.ai.keyConfigured': '••••••••（已配置，留空保持不变）',
  'settings.ai.clear': '清除',
  'settings.ai.keyNote': '密钥只保存在系统密钥库（SecretStorage），不会写入设置文件，也不会回显。',
  'settings.ai.model': '模型',
  'settings.ai.loadFailed': '加载设置失败，请重载窗口重试',
  'settings.ai.cleared': '已清除 API 密钥',
  'settings.ai.saved': '设置已保存',
  'settings.ai.saveFailed': '保存失败：{0}',
  'settings.ai.testOk': '连接成功 · {0} · {1}ms',
  'settings.ai.saving': '保存中…',
  'settings.ai.testing': '测试中…',
  'settings.ai.testButton': '测试连接',
  'settings.ai.privacyLead': '使用 AI 功能时，当前库的',
  'settings.ai.privacySchema': '表结构',
  'settings.ai.privacyMid': '（表 / 列 / 类型 / 注释）将发送给你配置的服务；',
  'settings.ai.privacyNoData': '表数据不会发送',
  'settings.ai.privacyTail': '。单库表较多时会先让你选择提供给 AI 的表。',
  // ── AI 采样参数与用量（AI P2A 批次 A4，交互稿 §15.7 转正）──
  'settings.ai.samplingTitle': '采样参数',
  'settings.ai.samplingDesc': '与 VSCode 设置双向同步；留空或非法值走模型服务默认。',
  'settings.ai.temperature': 'Temperature（随机度）',
  'settings.ai.temperatureDesc': '0 = 确定性输出，2 = 最大随机度；生成 SQL 建议偏低（0–0.7）',
  'settings.ai.maxTokens': '最大生成 Token 数',
  'settings.ai.maxTokensDesc': '单次响应的生成上限（解释类回答较长时可调大）',
  'settings.ai.usageTitle': '用量统计',
  'settings.ai.usageLine': '{0} 次请求 · 输入 {1} / 输出 {2} / 合计 {3} tokens',
  'settings.ai.usageNote': '仅统计服务端在响应中上报用量的请求（OpenAI usage 口径）；本地累计，不上传。',
  'settings.ai.usageEmpty': '暂无用量记录',

  // ── 查询与导出（QueryExportSection）──
  'settings.qe.maxRows': '结果行数上限',
  'settings.qe.maxRowsDesc': '单次查询 / 表格取数 / Console 结果的行数上限',
  'settings.qe.unitRows': '行',
  'settings.qe.timeout': '查询超时',
  'settings.qe.timeoutDesc': '驱动调用的默认超时时间',
  'settings.qe.connectTimeout': '建连超时',
  'settings.qe.connectTimeoutDesc': '建立连接的超时时间（含 SSH 隧道建立）',
  'settings.qe.exportChunk': '导出批量',
  'settings.qe.exportChunkDesc': '导出时每批读取的行数',
  'settings.qe.txIdleTimeout': '交互式事务空闲超时',
  'settings.qe.txIdleTimeoutDesc': '超时未操作自动 ROLLBACK',
  'settings.qe.syncNote': '以下配置与 VSCode 设置（DB Kit 区域）双向同步。',
  'settings.qe.openInVscode': '在 VSCode 设置中打开',
  'settings.qe.defaultFormat': '导出默认格式',
  'settings.qe.defaultFormatDesc': '表格与结果面板导出的默认格式',
  'settings.qe.fmt.ndjson': 'NDJSON（换行分隔 JSON）',
  'settings.qe.queriesDir': '查询文件存储目录',
  'settings.qe.queriesDirDesc': '树「查询」目录与保存查询的磁盘位置；留空用扩展全局存储（不与工作区绑定），支持 ~/ 前缀',
  'settings.qe.dirPlaceholder': '（全局存储）',
  'settings.qe.noPkEdit': '无主键表编辑',
  'settings.qe.noPkEditDesc': '开启后无主键表可用「全列匹配」模式编辑（WHERE 含全部列原值；含二进制列的表仍不可编辑）',

  // ── 关于（AboutSection）──
  'settings.about.openLog': '打开日志',
  'settings.about.openLogDesc': '输出面板 Database Explorer 频道（问题排查第一现场）',
  'settings.about.github': 'GitHub 仓库',
  'settings.about.githubDesc': '源码与文档',
  'settings.about.issues': 'Issue 反馈',
  'settings.about.issuesDesc': '报 bug / 提需求',
  'settings.about.website': '产品官网',
  'settings.about.websiteDesc': '能力介绍与在线演示',
  'settings.about.tagline': '在 VSCode 内浏览、查询、编辑 MySQL / PostgreSQL / Redis / SQLite / MongoDB / SQL Server / Oracle 的数据库工具。',

  // ── 通用动作 ──
  'settings.save': '保存',
} as const;

export type SettingsKey = keyof typeof zhSettings;

export const enSettings: Partial<Record<SettingsKey, string>> = {
  // ── Category nav (SettingsPage) ──
  'settings.category.ai': 'AI Assist',
  'settings.category.queryExport': 'Query & Export',
  'settings.category.about': 'About',
  'settings.aria.categories': 'Settings categories',

  // ── AI Assist (AiSection) ──
  'settings.ai.title': 'AI Settings',
  'settings.ai.desc':
    'Configure an OpenAI-compatible model service (OpenAI / DeepSeek / Moonshot / ollama / enterprise gateways, etc.).',
  'settings.ai.endpoint': 'API Endpoint',
  'settings.ai.apiKey': 'API Key',
  'settings.ai.keyConfigured': '•••••••• (configured, leave empty to keep unchanged)',
  'settings.ai.clear': 'Clear',
  'settings.ai.keyNote':
    'The key is only stored in the system secret storage (SecretStorage); it is never written to settings files and never echoed back.',
  'settings.ai.model': 'Model',
  'settings.ai.loadFailed': 'Failed to load settings; reload the window and try again',
  'settings.ai.cleared': 'API key cleared',
  'settings.ai.saved': 'Settings saved',
  'settings.ai.saveFailed': 'Failed to save: {0}',
  'settings.ai.testOk': 'Connected · {0} · {1}ms',
  'settings.ai.saving': 'Saving…',
  'settings.ai.testing': 'Testing…',
  'settings.ai.testButton': 'Test Connection',
  'settings.ai.privacyLead': 'When using AI features, the',
  'settings.ai.privacySchema': 'schema',
  'settings.ai.privacyMid': '(tables / columns / types / comments) of the current database is sent to the service you configured;',
  'settings.ai.privacyNoData': 'table data is never sent',
  'settings.ai.privacyTail': '. When a database has many tables, you will first be asked to choose the tables to provide to the AI.',
  // ── AI sampling & usage (AI P2A batch A4) ──
  'settings.ai.samplingTitle': 'Sampling',
  'settings.ai.samplingDesc': 'Kept in sync with VSCode settings; empty or invalid values fall back to the model service defaults.',
  'settings.ai.temperature': 'Temperature (randomness)',
  'settings.ai.temperatureDesc': '0 = deterministic, 2 = most random; lower values (0–0.7) are recommended for SQL generation',
  'settings.ai.maxTokens': 'Max output tokens',
  'settings.ai.maxTokensDesc': 'Generation cap per response (raise it for long explanations)',
  'settings.ai.usageTitle': 'Usage',
  'settings.ai.usageLine': '{0} requests · {1} input / {2} output / {3} total tokens',
  'settings.ai.usageNote': 'Counts only requests whose response reports usage (OpenAI usage field); accumulated locally, never uploaded.',
  'settings.ai.usageEmpty': 'No usage recorded yet',

  // ── Query & Export (QueryExportSection) ──
  'settings.qe.maxRows': 'Max result rows',
  'settings.qe.maxRowsDesc': 'Row limit for a single query, table fetch, or Console result',
  'settings.qe.unitRows': 'rows',
  'settings.qe.timeout': 'Query timeout',
  'settings.qe.timeoutDesc': 'Default timeout for driver calls',
  'settings.qe.connectTimeout': 'Connect timeout',
  'settings.qe.connectTimeoutDesc': 'Timeout for establishing a connection (including SSH tunnel setup)',
  'settings.qe.exportChunk': 'Export batch size',
  'settings.qe.exportChunkDesc': 'Rows read per batch during export',
  'settings.qe.txIdleTimeout': 'Interactive transaction idle timeout',
  'settings.qe.txIdleTimeoutDesc': 'Automatically ROLLBACK when idle beyond the timeout',
  'settings.qe.syncNote': 'The settings below stay in sync with VSCode settings (DB Kit section).',
  'settings.qe.openInVscode': 'Open in VSCode Settings',
  'settings.qe.defaultFormat': 'Default export format',
  'settings.qe.defaultFormatDesc': 'Default format for exports from the table view and result panel',
  'settings.qe.fmt.ndjson': 'NDJSON (newline-delimited JSON)',
  'settings.qe.queriesDir': 'Query files directory',
  'settings.qe.queriesDirDesc':
    'Disk location for the tree "Queries" folder and saved queries; leave empty to use the extension global storage (not workspace-bound). Supports the ~/ prefix',
  'settings.qe.dirPlaceholder': '(global storage)',
  'settings.qe.noPkEdit': 'Editing tables without a primary key',
  'settings.qe.noPkEditDesc':
    'When enabled, tables without a primary key can be edited in "match all columns" mode (the WHERE clause contains the original values of all columns; tables with binary columns remain non-editable)',

  // ── About (AboutSection) ──
  'settings.about.openLog': 'Open Logs',
  'settings.about.openLogDesc': 'The Database Explorer channel in the Output panel (first stop for troubleshooting)',
  'settings.about.github': 'GitHub Repository',
  'settings.about.githubDesc': 'Source code and documentation',
  'settings.about.issues': 'Issue Feedback',
  'settings.about.issuesDesc': 'Report bugs / request features',
  'settings.about.website': 'Website',
  'settings.about.websiteDesc': 'Feature overview and online demo',
  'settings.about.tagline':
    'Database tool for browsing, querying, and editing MySQL / PostgreSQL / Redis / SQLite / MongoDB / SQL Server / Oracle inside VSCode.',

  // ── Common actions ──
  'settings.save': 'Save',
};
