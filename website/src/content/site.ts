// 站点内容唯一事实源（zh/en 双词典，D-25 / C-15）——文案取自两份 README
// （zh = packages/extension/README.md 中文主体；en = 其英文摘要节 / README.en.md），禁止虚构、
// 禁止超出支持矩阵口径（en 同罪）。品牌渐变 #2b7fff → #1554c0 与扩展图标同源
// （packages/extension/media/extension-icon.svg）。
import type { SiteLang } from '../i18n/lang';

const REPO = 'https://github.com/Fengjing95/vsc-plugin-db';
const BASE = import.meta.env.BASE_URL; // '/vsc-plugin-db/'（本地 dev 为 '/'）

export const withBase = (path: string) => `${BASE}${path.replace(/^\//, '')}`;

/** 语言中立数据（品牌/链接/引擎列表——引擎名本身免翻） */
export const site = {
  name: 'DB Kit',
  version: 'v0.11.0',
  extId: 'db-explorer-dev.db-kit',
  installCommand: 'ext install db-explorer-dev.db-kit',
  urls: {
    repo: REPO,
    marketplace: 'https://marketplace.visualstudio.com/items?itemName=db-explorer-dev.db-kit',
    releases: `${REPO}/releases`,
    issues: `${REPO}/issues`,
    changelog: `${REPO}/blob/main/CHANGELOG.md`,
    docs: `${REPO}/tree/main/docs`,
    /** 在线 Playground：内嵌在首页 Hero 图位（#playground 锚点），浏览器内跑真实 webview 界面 + mock 驱动 */
    playground: '#playground',
    /** 带模板直达 issue 表单（模板见 .github/ISSUE_TEMPLATE/）：Coming Soon 卡走需求、页脚「Bug 反馈」走 Bug */
    newFeatureIssue: `${REPO}/issues/new?template=feature_request.yml`,
    newBugIssue: `${REPO}/issues/new?template=bug_report.yml`,
  },
};

export type Engine = {
  key: string;
  name: string;
  logo?: string; // /assets/logos/*.svg（构建期从 webview-ui 拷入）
};

// 顺序与支持矩阵列序一致（extension README §支持矩阵）
export const engines: Engine[] = [
  { key: 'mysql', name: 'MySQL', logo: withBase('assets/logos/MySQL.svg') },
  { key: 'postgresql', name: 'PostgreSQL', logo: withBase('assets/logos/PostgreSql.svg') },
  { key: 'mssql', name: 'SQL Server', logo: withBase('assets/logos/SQLServer.svg') },
  { key: 'oracle', name: 'Oracle', logo: withBase('assets/logos/Oracle.svg') },
  { key: 'sqlite', name: 'SQLite', logo: withBase('assets/logos/sqlite.svg') },
  { key: 'mongodb', name: 'MongoDB', logo: withBase('assets/logos/mongoDB.svg') },
  { key: 'redis', name: 'Redis', logo: withBase('assets/logos/Redis.svg') },
];

export type CellValue = 'yes' | 'no' | string; // 'yes'=✓，'no'=—，其余为变体文案（如「文档编辑」「只读」）

export type Feature = { icon: string; title: string; desc: string };
export type Screenshot = { file: string; title: string; desc: string };
export type ComingItem = { name: string; desc: string; tags?: string[] };

/** 各语言文案包：zh/en 同构（形状由本类型锁定，缺键 = 编译错） */
export type SiteContent = {
  /** <title> 与 meta description（语言切换时客户端同步更新） */
  meta: { title: string; description: string };
  tagline: string;
  subTagline: string;
  ui: {
    skipToContent: string;
    nav: {
      links: { href: string; label: string }[];
      homeAria: string;
      navAria: string;
      githubAria: string;
      install: string;
      langAriaOn: string;
    };
    hero: {
      badge: string;
      titleBefore: string;
      titleAfter: string;
      statsAria: string;
      stats: { label: string }[];
      enginesAria: string;
      installBtn: string;
      vsixBtn: string;
      newBadge: string;
      playgroundLoading: string;
      figcaption: string;
      figHint: string;
    };
    matrix: { yesAria: string; noAria: string; kicker: string; heading: string; sub: string; capability: string };
    features: { kicker: string; heading: string; sub: string };
    screenshots: { kicker: string; heading: string; sub: string; alt: string };
    comingSoon: {
      kicker: string;
      heading: string;
      sub: string;
      badge: string;
      candidatesAria: string;
      cta: string;
      ctaAria: string;
    };
    quickStart: { kicker: string; heading: string; stepLabel: string; installHeading: string; downloadNote: string };
    footer: { tagline: string; linksAria: string; bugFeedback: string; designDocs: string; copyright: string };
    copy: { aria: string; copied: string; copy: string };
  };
  matrixRows: { label: string; cells: CellValue[] }[];
  matrixFootnote: string;
  features: Feature[];
  screenshots: Screenshot[];
  heroShot: { file: string; title: string; desc: string };
  comingSoon: ComingItem[];
  quickStart: {
    install: { title: string; desc: string }[];
    steps: { title: string; desc: string }[];
  };
  playground: {
    quickOpen: { name: string; desc: string }[];
    erTabPrefix: string;
    designTabPrefix: string;
    frameAria: string;
    titleBar: string;
    activityExplorer: string;
    activitySearch: string;
    activityAccount: string;
    sidebarHeader: string;
    openConsoleTitle: string;
    resetTitle: string;
    treeAria: string;
    treeRoot: string;
    erActionTitle: string;
    designActionTitle: string;
    sidebarFoot: string;
    closeTabAria: string;
    sqlInputAria: string;
    sqlPlaceholder: string;
    hintBar: string;
    runBtn: string;
    statusConnected: string;
    statusLimit: string;
    statusDemo: string;
    welcomeTitle: string;
    welcomeBody: string;
    welcomeBody2: string;
    cardConsoleTitle: string;
    cardConsoleDesc: string;
    cardErDesc: string;
    cardErHint: string;
    hint: string;
    hostNotReady: string;
    // host.ts 面向用户的提示（DriverError message 经 webview 弹出）
    errNoChanges: string;
    errDdlNotSupported: string;
    errCreateDdlNotSupported: string;
    errAlterDdlNotSupported: string;
    errMethodNotSupported: string;
    connLabel: string;
    useSwitched: string;
    errNotExportable: string;
    errInsertExport: string;
    resultFilePrefix: string;
    errRequestFailed: string;
    errInternal: string;
  };
};

const zh: SiteContent = {
  meta: {
    title: 'DB Kit — 在 VSCode 里搞定数据库的一切',
    description:
      'DB Kit：VSCode 数据库插件——资源树、表格编辑、SQL Console、结构管理与流式导出，支持 MySQL / PostgreSQL / SQL Server / Oracle / SQLite / MongoDB / Redis。',
  },
  tagline: '在 VSCode 里，搞定数据库的一切',
  subTagline: '浏览 · 查询 · 编辑 · 导出 —— 六类数据源统一入口，AI 助手自带钥匙、开箱即连、零遥测。',
  ui: {
    skipToContent: '跳到主要内容',
    nav: {
      links: [
        { href: '#playground', label: '✨ 在线体验' },
        { href: '#matrix', label: '支持矩阵' },
        { href: '#features', label: '功能亮点' },
        { href: '#screenshots', label: '界面' },
        { href: '#roadmap', label: '路线图' },
        { href: '#quickstart', label: '快速上手' },
      ],
      homeAria: 'DB Kit 首页',
      navAria: '页面导航',
      githubAria: 'GitHub 仓库',
      install: '免费安装',
      langAriaOn: 'Switch to English',
    },
    hero: {
      badge: '开源 · 已上架 VSCode Marketplace ·',
      titleBefore: '在 VSCode 里，',
      titleAfter: '搞定数据库的一切',
      statsAria: '关键数字',
      stats: [{ label: '类数据源统一入口' }, { label: '行 · 单次传输上限' }, { label: '% 开源（GitHub）' }],
      enginesAria: '支持的数据源',
      installBtn: '安装 DB Kit',
      vsixBtn: '下载 VSIX',
      newBadge: '✨ 新：在线 Playground — 浏览器里直接玩',
      playgroundLoading: 'Playground 加载中…',
      figcaption: '上面是活的：',
      figHint: '单击左侧表名打开表格 · 双击单元格直改 · 工具栏提交前可预览 SQL —— 全部在浏览器内完成，无需安装',
    },
    matrix: {
      yesAria: '支持',
      noAria: '不支持',
      kicker: '支持矩阵',
      heading: '七引擎，一套体验',
      sub: 'MySQL · PostgreSQL · SQL Server · Oracle · SQLite · MongoDB · Redis —— 能力逐格对齐，不夸大',
      capability: '能力',
    },
    features: { kicker: '功能亮点', heading: '为日常数据库工作流而造', sub: '从看结构、查数据到改数据、导数据，每一步都有护栏' },
    screenshots: { kicker: '界面一览', heading: '长在你的编辑器里', sub: '与 VSCode 深色主题同源，零割裂感', alt: 'DB Kit 界面：{0}' },
    comingSoon: {
      kicker: 'Coming Soon',
      heading: '在路上，由你定优先级',
      sub: '以下驱动在规划中，尚未开始适配——你的 issue 就是排期依据',
      badge: '规划中',
      candidatesAria: '候选范围',
      cta: '期待它？去 issue 说一句',
      ctaAria: '到 GitHub 提需求：{0}',
    },
    quickStart: { kicker: '快速上手', heading: '30 秒，从安装到看到数据', stepLabel: '第一步', installHeading: '安装（三选一）', downloadNote: '前往 GitHub Releases 下载 VSIX' },
    footer: {
      tagline: '在 VSCode 里搞定数据库的一切。',
      linksAria: '页脚链接',
      bugFeedback: 'Bug 反馈',
      designDocs: '设计文档',
      copyright: '基于 Apache-2.0 开源',
    },
    copy: { aria: '复制命令 {0}', copied: '已复制 ✓', copy: '复制' },
  },
  matrixRows: [
    { label: '资源树浏览', cells: ['yes', 'yes', 'yes', 'yes', 'yes', 'yes', 'yes'] },
    { label: '表格编辑', cells: ['yes', 'yes', 'yes', 'yes', 'yes', '文档编辑', '只读'] },
    { label: 'SQL Console / 命令控制台', cells: ['yes', 'yes', 'yes', 'yes', 'yes', 'mongosh', 'yes'] },
    { label: '结构编辑（表 / 列）', cells: ['yes', 'yes', 'yes', 'yes', 'yes', 'no', 'no'] },
    { label: '库级 DDL', cells: ['yes', '建/删 schema', '建/删 schema', '建/删 schema', 'no', 'yes', 'no'] },
    { label: 'SSL / SSH 隧道', cells: ['yes', 'yes', 'yes', '隧道', 'no', 'yes', 'yes'] },
    { label: '后台导出', cells: ['yes', 'yes', 'yes', 'yes', 'yes', 'yes', 'yes'] },
  ],
  matrixFootnote:
    'SQLite 限中小库（≤ 100MB）；MongoDB 结构类命令不支持；SQL Server 不支持 GO 批与触发器表的 INSERT 回填；Oracle 19c+（thin）：空串即 NULL、Console 超大整数精度受限、暂不支持 TCPS 加密。',
  features: [
    {
      icon: '📊',
      title: '表格即工作台',
      desc: '虚拟滚动流畅浏览大表；单元格双击直改，提交前给出参数化 SQL 预览，单事务提交 + 字段级乐观锁，并发冲突精准定位到错误行；无主键表默认只读保护。超长文本 / 二进制单元格按阈值传输预览前缀（可配置），▤ 查看器、编辑与复制自动取整值——大字段翻页不再卡传输。',
    },
    {
      icon: '⌨️',
      title: 'SQL Console 会补全也会踩刹车',
      desc: '按上下文补全库 / 表 / 列与方言关键字；UPDATE / DELETE 不带 WHERE 直接拦截，生产库分级二次确认；EXPLAIN 结果自动树形缩进；每条语句的耗时 / 错误 / 取消状态行内注记。',
    },
    {
      icon: '🧱',
      title: '结构管理不写 DDL',
      desc: '表与列的可视化增删改，语句预览 + 破坏性操作红条告警；库级操作开箱可用：MySQL 建 / 改 / 删库，PostgreSQL 与 SQL Server 建 / 删 schema，MongoDB 建 / 删库；PostgreSQL 物化视图独立目录（浏览 / 查 DDL）。',
    },
    {
      icon: '🤖',
      title: 'AI 助手，自带钥匙（BYOK）',
      desc: '自然语言生成 SQL（CodeLens / Alt+\\ 直插编辑器，不满意「再来一个」）、表格筛选栏用自然语言生成 WHERE 条件（回填后过目再应用）、选中即解释、EXPLAIN 结果一键解读执行计划、报错一键生成修复建议（编辑器内联 diff，确认后才落地）——接入你自己的 OpenAI 兼容服务（DeepSeek / Moonshot / ollama 等均可）；密钥只存系统密钥链，默认只发表结构、不发数据行，AI 产物照常过危险语句拦截；采样参数与用量统计在设置中心一目了然。',
    },
    {
      icon: '📤',
      title: '百万行导出不卡界面',
      desc: 'CSV / JSON / NDJSON / Markdown / SQL INSERT / XLSX 六种格式流式导出转入后台执行：通知中心看进度、随时取消、多任务并发，导完一键定位文件。',
    },
    {
      icon: '🔌',
      title: '连接开箱即用',
      desc: '每驱动动态连接表单；SSH 隧道（TOFU 指纹校验）与 SSL/TLS；密码只存系统密钥链，零遥测、不落盘。',
    },
  ],
  screenshots: [
    { file: 'console.png', title: 'SQL Console', desc: '上下文补全、危险语句拦截、EXPLAIN 树形缩进与行内执行注记' },
    { file: 'schema-editor.png', title: '表结构编辑器', desc: '可视化增删改表与列，语句预览、破坏性操作红条告警' },
    { file: 'database-ddl.png', title: '库级操作', desc: '驱动动态表单建库，预览确认后才执行' },
    { file: 'ai-fix-error.png', title: 'AI 修复建议', desc: 'SQL 报错一键生成修复建议，编辑器内联 diff 对照、确认后才落地' },
  ],
  heroShot: {
    file: 'overview-table.png',
    title: '资源树 + 表格工作台',
    desc: '左侧资源树一键展开库 / 表 / 列 / 键 / 索引；右侧筛选、排序、搜索全部参数化下推到数据库执行——不拉全表，千万行级也只取你看到的那一页。',
  },
  comingSoon: [
    {
      name: '国产数据库（信创）',
      desc: '三家均已纳入规划、尚未开始适配——呼声越高，排期越早。',
      tags: ['达梦', '人大金仓', 'openGauss'],
    },
  ],
  quickStart: {
    install: [
      { title: '扩展面板安装', desc: 'VSCode 扩展面板搜索 DB Kit，一键安装' },
      { title: '命令行安装', desc: '在终端执行下方命令' },
      { title: 'VSIX 手动安装', desc: '从 GitHub Releases 下载 VSIX，扩展视图「…」→ Install from VSIX' },
    ],
    steps: [
      { title: '新建连接', desc: '安装后点活动栏「数据库」图标 → ＋ 新建连接' },
      { title: '浏览与编辑', desc: '单击表名打开表格视图；双击单元格直改，提交前给出参数化 SQL 预览' },
      { title: '写 SQL', desc: '树中「新增查询」写 SQL，Ctrl+Enter 执行' },
    ],
  },
  playground: {
    quickOpen: [
      { name: 'demo.users', desc: '常规业务表 · 可编辑' },
      { name: 'demo.wide', desc: '20 列全类型宽表' },
      { name: 'big.t001', desc: '50,000 行 · 虚拟滚动' },
    ],
    erTabPrefix: 'ER ·',
    designTabPrefix: '设计 ·',
    frameAria: 'DB Kit 在线 Playground（Mock 演示数据）',
    titleBar: 'DB Kit — Playground（Mock 演示数据 · 无需安装）',
    activityExplorer: '数据库资源管理器',
    activitySearch: '搜索（Playground 未开放）',
    activityAccount: '账号（Playground 未开放）',
    sidebarHeader: '数据库 · 资源管理器',
    openConsoleTitle: '打开 SQL Console',
    resetTitle: '重置演示数据（清空内存库与未提交变更）',
    treeAria: '数据库资源树',
    treeRoot: 'Mock 数据源（演示）',
    erActionTitle: '查看 {0} 的 ER 图',
    designActionTitle: '设计 {0} 表结构',
    sidebarFoot: '演示数据存于浏览器内存，刷新或 ⟳ 重置即还原',
    closeTabAria: '关闭 {0}',
    sqlInputAria: 'SQL 输入',
    sqlPlaceholder: '-- 输入 SQL，Ctrl+Enter 运行',
    hintBar: 'Ctrl+Enter 运行 · USE 可切库（demo/analytics/big）· 试一试不带 WHERE 的 UPDATE 看危险横幅',
    runBtn: '▶ 运行（Ctrl+Enter）',
    statusConnected: 'Mock 数据源 · 已连接',
    statusLimit: '传输上限 5000 行 / 次',
    statusDemo: '演示：表格编辑 · SQL Console · ER 图 · 表结构设计（其余面板陆续接入）',
    welcomeTitle: '这是真的 DB Kit，跑在你的浏览器里',
    welcomeBody: '界面与交互是插件的真实 Webview 产物，数据来自内置 Mock 驱动（无需安装、不连任何数据库）。',
    welcomeBody2: '单击左侧表名开始；双击单元格直改 → 工具栏「提交变更」查看参数化 SQL 预览 → 应用后数据真实变更。',
    cardConsoleTitle: 'SQL Console',
    cardConsoleDesc: '真跑 SQL · 危险语句横幅',
    cardErDesc: 'shop ER 图',
    cardErHint: '8 表 9 关系 · 自引用/多对多/复合外键',
    hint: '试试：demo.users 改邮箱触发乐观锁；demo.wide 体验 NULL/DECIMAL/二进制等值编码；big.t001 感受 5 万行虚拟滚动；表行悬停「✎」进入表结构设计。',
    hostNotReady: 'Playground host 未就绪，请刷新页面',
    errNoChanges: '没有可提交的变更',
    errDdlNotSupported: '当前驱动未实现 DDL 查看',
    errCreateDdlNotSupported: '当前驱动未实现建表语句生成',
    errAlterDdlNotSupported: '当前驱动未实现改表语句生成',
    errMethodNotSupported: 'Playground 暂不支持 "{0}"',
    connLabel: 'Mock 数据源（演示）',
    useSwitched: '已切换到数据库 {0}（Console 绑定已更新）',
    errNotExportable: '该结果不可导出',
    errInsertExport: 'Console 结果无单一目标表，INSERT 导出请在表格视图使用',
    resultFilePrefix: '结果-',
    errRequestFailed: '请求失败',
    errInternal: 'Playground 内部错误',
  },
};

const en: SiteContent = {
  meta: {
    title: 'DB Kit — Do everything with databases inside VSCode',
    description:
      'DB Kit: a database extension for VSCode — resource tree, table editing, SQL Console, schema management and streaming export for MySQL / PostgreSQL / SQL Server / Oracle / SQLite / MongoDB / Redis.',
  },
  tagline: 'Do everything with databases, inside VSCode',
  subTagline:
    'Browse · Query · Edit · Export — one entry for six kinds of data sources, with a bring-your-own-key AI assistant and zero telemetry.',
  ui: {
    skipToContent: 'Skip to main content',
    nav: {
      links: [
        { href: '#playground', label: '✨ Live Playground' },
        { href: '#matrix', label: 'Support Matrix' },
        { href: '#features', label: 'Features' },
        { href: '#screenshots', label: 'Screenshots' },
        { href: '#roadmap', label: 'Roadmap' },
        { href: '#quickstart', label: 'Quick Start' },
      ],
      homeAria: 'DB Kit home',
      navAria: 'Page navigation',
      githubAria: 'GitHub repository',
      install: 'Install Free',
      langAriaOn: '切换到中文',
    },
    hero: {
      badge: 'Open source · on the VSCode Marketplace ·',
      titleBefore: 'Databases, ',
      titleAfter: 'all inside VSCode',
      statsAria: 'Key numbers',
      stats: [{ label: 'kinds of data sources, one entry' }, { label: 'rows · per-query transfer cap' }, { label: '% open source (GitHub)' }],
      enginesAria: 'Supported data sources',
      installBtn: 'Install DB Kit',
      vsixBtn: 'Download VSIX',
      newBadge: '✨ New: live Playground — try it in your browser',
      playgroundLoading: 'Loading Playground…',
      figcaption: 'This one is alive:',
      figHint: 'Click a table name on the left to open it · double-click a cell to edit · preview SQL before commit — all in your browser, nothing to install',
    },
    matrix: {
      yesAria: 'Supported',
      noAria: 'Not supported',
      kicker: 'Support Matrix',
      heading: 'Seven engines, one experience',
      sub: 'MySQL · PostgreSQL · SQL Server · Oracle · SQLite · MongoDB · Redis — capability by capability, no overpromising',
      capability: 'Capability',
    },
    features: { kicker: 'Features', heading: 'Built for the daily database workflow', sub: 'From schema browsing to querying, editing and exporting — with guardrails at every step' },
    screenshots: { kicker: 'Screenshots', heading: 'Lives inside your editor', sub: 'Same dark theme as VSCode — no visual disconnect', alt: 'DB Kit screenshot: {0}' },
    comingSoon: {
      kicker: 'Coming Soon',
      heading: 'On the roadmap — you set the priority',
      sub: 'The drivers below are planned but not started — your issue drives the schedule',
      badge: 'Planned',
      candidatesAria: 'Candidate scope',
      cta: 'Want it sooner? Say so on GitHub',
      ctaAria: 'Request on GitHub: {0}',
    },
    quickStart: { kicker: 'Quick Start', heading: 'From install to data in 30 seconds', stepLabel: 'Step', installHeading: 'Install (choose one)', downloadNote: 'Download the VSIX from GitHub Releases' },
    footer: {
      tagline: 'Do everything with databases inside VSCode.',
      linksAria: 'Footer links',
      bugFeedback: 'Report a Bug',
      designDocs: 'Design Docs',
      copyright: 'Open source under Apache-2.0',
    },
    copy: { aria: 'Copy command {0}', copied: 'Copied ✓', copy: 'Copy' },
  },
  matrixRows: [
    { label: 'Resource tree', cells: ['yes', 'yes', 'yes', 'yes', 'yes', 'yes', 'yes'] },
    { label: 'Table editing', cells: ['yes', 'yes', 'yes', 'yes', 'yes', 'Document edit', 'Read-only'] },
    { label: 'SQL Console / command console', cells: ['yes', 'yes', 'yes', 'yes', 'yes', 'mongosh', 'yes'] },
    { label: 'Schema editing (tables / columns)', cells: ['yes', 'yes', 'yes', 'yes', 'yes', 'no', 'no'] },
    { label: 'Database-level DDL', cells: ['yes', 'Create/drop schema', 'Create/drop schema', 'Create/drop schema', 'no', 'yes', 'no'] },
    { label: 'SSL / SSH tunnel', cells: ['yes', 'yes', 'yes', 'Tunnel', 'no', 'yes', 'yes'] },
    { label: 'Background export', cells: ['yes', 'yes', 'yes', 'yes', 'yes', 'yes', 'yes'] },
  ],
  matrixFootnote:
    'SQLite is limited to small-to-medium databases (≤ 100MB); MongoDB structural commands are not supported; SQL Server does not support GO batches or INSERT back-fill for tables with triggers; Oracle 19c+ (thin): empty string is NULL, very large integers have reduced precision in the Console, TCPS encryption not yet supported.',
  features: [
    {
      icon: '📊',
      title: 'The table is the workbench',
      desc: 'Smoothly browse huge tables with virtual scrolling; double-click any cell to edit, review the parameterized SQL preview before commit, single-transaction commit with field-level optimistic locking that pinpoints conflicting rows; tables without a primary key are read-only by default. Oversized text / binary cells transfer a configurable preview prefix — the ▤ viewer, editing and copy fetch the full value automatically.',
    },
    {
      icon: '⌨️',
      title: 'A SQL Console that completes — and brakes',
      desc: 'Context-aware completion for databases / tables / columns and dialect keywords; UPDATE / DELETE without WHERE is blocked outright, with tiered confirmation on production; EXPLAIN results are auto-indented as a tree; per-statement duration / error / canceled status annotations inline.',
    },
    {
      icon: '🧱',
      title: 'Schema management without writing DDL',
      desc: 'Visual create/alter/drop for tables and columns with statement preview and red-bar warnings for destructive operations; database-level operations out of the box: MySQL create/alter/drop database, PostgreSQL and SQL Server create/drop schema, MongoDB create/drop database; PostgreSQL materialized views get their own tree folder (browse / view DDL).',
    },
    {
      icon: '🤖',
      title: 'AI assistant with its own key (BYOK)',
      desc: 'Generate SQL from natural language (CodeLens / Alt+\\ inserts straight into the editor; "Try Again" if you want another take), describe a table filter in plain words and get a WHERE condition filled in for review before applying, explain a selection instantly, one-click query-plan explanation on EXPLAIN results, one-click fix suggestions for SQL errors (inline editor diff, applied only after confirmation) — plug in your own OpenAI-compatible service (DeepSeek / Moonshot / ollama and more); keys stay in the system keychain, only schema is sent by default — never data rows — AI output still passes danger checks, and sampling parameters plus usage stats live in the Settings hub.',
    },
    {
      icon: '📤',
      title: 'Million-row exports that never freeze the UI',
      desc: 'Streaming export in six formats — CSV / JSON / NDJSON / Markdown / SQL INSERT / XLSX — runs in the background: track progress from the notification center, cancel anytime, run tasks concurrently, reveal the file when done.',
    },
    {
      icon: '🔌',
      title: 'Connections that just work',
      desc: 'Per-driver dynamic connection forms; SSH tunneling (TOFU fingerprint verification) and SSL/TLS; passwords live only in the system keychain — zero telemetry, nothing written to disk.',
    },
    {
      icon: '📈',
      title: 'Charts & schema compare',
      desc: 'One click turns any Console result into a Chart tab: line / bar with selectable X axis and numeric series, automatic downsampling for large results, exportable as SVG/PNG; cross-database schema compare within a connection aligns tables and columns side by side — no diff SQL required.',
    },
  ],
  screenshots: [
    { file: 'console.png', title: 'SQL Console', desc: 'Context completion, dangerous-statement blocking, EXPLAIN tree indent and inline run annotations' },
    { file: 'schema-editor.png', title: 'Table Schema Editor', desc: 'Visually create/alter/drop tables and columns with statement preview and red-bar destructive warnings' },
    { file: 'database-ddl.png', title: 'Database-level Operations', desc: 'Create databases via driver-provided dynamic forms, executed only after preview confirmation' },
    { file: 'ai-fix-error.png', title: 'AI Fix Suggestion', desc: 'One-click fix suggestions for SQL errors, inline diff in the editor, applied only after confirmation' },
  ],
  heroShot: {
    file: 'overview-table.png',
    title: 'Resource tree + table workbench',
    desc: 'Expand databases / tables / columns / keys / indexes from the tree on the left; filtering, sorting and search on the right are all pushed down to the database with parameterized SQL — no full-table scans; at tens of millions of rows you still fetch only the page you see.',
  },
  comingSoon: [
    {
      name: 'Chinese domestic databases (Xinchuang)',
      desc: 'All three are on the roadmap, adaptation not yet started — the louder the demand, the earlier the slot.',
      tags: ['DM', 'KingbaseES', 'openGauss'],
    },
  ],
  quickStart: {
    install: [
      { title: 'From the Extensions panel', desc: 'Search for DB Kit in the VSCode Extensions panel and install with one click' },
      { title: 'From the command line', desc: 'Run the command below in a terminal' },
      { title: 'Manual VSIX install', desc: 'Download the VSIX from GitHub Releases, then in the Extensions view "…" → Install from VSIX' },
    ],
    steps: [
      { title: 'Create a connection', desc: 'After installing, click the Database icon in the activity bar → + New Connection' },
      { title: 'Browse and edit', desc: 'Click a table name to open the table view; double-click a cell to edit, with a parameterized SQL preview before commit' },
      { title: 'Write SQL', desc: 'Use "New Query" in the tree to write SQL, Ctrl+Enter to run' },
    ],
  },
  playground: {
    quickOpen: [
      { name: 'demo.users', desc: 'Regular business table · editable' },
      { name: 'demo.wide', desc: '20-column all-types table' },
      { name: 'big.t001', desc: '50,000 rows · virtual scrolling' },
    ],
    erTabPrefix: 'ER ·',
    designTabPrefix: 'Design ·',
    frameAria: 'DB Kit online Playground (mock demo data)',
    titleBar: 'DB Kit — Playground (mock demo data · nothing to install)',
    activityExplorer: 'Database Explorer',
    activitySearch: 'Search (not available in Playground)',
    activityAccount: 'Account (not available in Playground)',
    sidebarHeader: 'Databases · Explorer',
    openConsoleTitle: 'Open SQL Console',
    resetTitle: 'Reset demo data (clears the in-memory database and unsaved changes)',
    treeAria: 'Database resource tree',
    treeRoot: 'Mock source (demo)',
    erActionTitle: 'View ER diagram of {0}',
    designActionTitle: 'Design table {0}',
    sidebarFoot: 'Demo data lives in browser memory; reload or ⟳ reset to restore',
    closeTabAria: 'Close {0}',
    sqlInputAria: 'SQL input',
    sqlPlaceholder: '-- Type SQL, Ctrl+Enter to run',
    hintBar: 'Ctrl+Enter to run · USE switches database (demo/analytics/big) · try an UPDATE without WHERE to see the danger banner',
    runBtn: '▶ Run (Ctrl+Enter)',
    statusConnected: 'Mock source · connected',
    statusLimit: 'Transfer cap 5,000 rows / query',
    statusDemo: 'Demo: table editing · SQL Console · ER diagram · table designer (more panels coming)',
    welcomeTitle: 'This is the real DB Kit, running in your browser',
    welcomeBody:
      'The UI and interactions are the extension\u2019s real webview build, backed by the built-in mock driver (nothing to install, connects to no database).',
    welcomeBody2:
      'Click a table on the left to start; double-click a cell to edit → "Commit Changes" in the toolbar shows the parameterized SQL preview → applied changes take real effect in the demo data.',
    cardConsoleTitle: 'SQL Console',
    cardConsoleDesc: 'Real SQL · danger banners',
    cardErDesc: 'shop ER diagram',
    cardErHint: '8 tables, 9 relationships · self-references / many-to-many / composite FKs',
    hint: 'Try: edit an email in demo.users to trigger optimistic locking; explore NULL/DECIMAL/binary value encoding in demo.wide; feel the 50k-row virtual scrolling in big.t001; hover a table row and click "✎" to open the table designer.',
    hostNotReady: 'Playground host not ready, please reload the page',
    errNoChanges: 'No changes to commit',
    errDdlNotSupported: 'The current driver does not implement DDL viewing',
    errCreateDdlNotSupported: 'The current driver does not implement CREATE TABLE generation',
    errAlterDdlNotSupported: 'The current driver does not implement ALTER TABLE generation',
    errMethodNotSupported: 'Playground does not support "{0}" yet',
    connLabel: 'Mock source (demo)',
    useSwitched: 'Switched to database {0} (Console binding updated)',
    errNotExportable: 'This result cannot be exported',
    errInsertExport: 'Console results have no single target table; use the table view for INSERT export',
    resultFilePrefix: 'result-',
    errRequestFailed: 'Request failed',
    errInternal: 'Playground internal error',
  },
};

export const siteContent: Record<SiteLang, SiteContent> = { zh, en };

export function getSiteContent(lang: SiteLang): SiteContent {
  return siteContent[lang];
}
