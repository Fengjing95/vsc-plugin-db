// 站点内容唯一事实源（zh/en 双词典，D-25 / C-15）——文案取自两份 README
// （zh = packages/extension/README.md 中文主体；en = 其英文摘要节 / README.en.md），禁止虚构、
// 禁止超出支持矩阵口径（en 同罪）。品牌渐变 #2b7fff → #1554c0 与扩展图标同源
// （packages/extension/media/extension-icon.svg）。
import type { SiteLang } from '../i18n/lang';

const REPO = 'https://github.com/Fengjing95/vsc-plugin-db';
// vite 配置加载期（build-all 双构建）也会 import 本模块——彼时 import.meta.env 未就绪，
// 可选链兜底 '/'（BASE_URL 在站点构建里恒 '/'，见 vite.config.ts base 口径）
const BASE = import.meta.env?.BASE_URL ?? '/'; // '/vsc-plugin-db/'（本地 dev 为 '/'）

export const withBase = (path: string) => `${BASE}${path.replace(/^\//, '')}`;

/** 语言中立数据（品牌/链接/引擎列表——引擎名本身免翻） */
export const site = {
  name: 'DB Kit',
  version: 'v0.12.0',
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

/** docs 区内容块：段落 / 无序列表 / 提示条（风险或要点），按 kind 渲染，不做 markdown 解析 */
export type DocsBlock =
  | { kind: 'p'; text: string }
  | { kind: 'ul'; items: string[] }
  | { kind: 'note'; text: string };
export type DocsSection = { h: string; blocks: DocsBlock[] };
export type DocsArticle = { id: string; title: string; intro: string; sections: DocsSection[] };

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
    quickStart: { kicker: string; heading: string; stepLabel: string; installHeading: string; downloadNote: string };
    footer: { tagline: string; linksAria: string; bugFeedback: string; designDocs: string; copyright: string };
    copy: { aria: string; copied: string; copy: string };
  };
  matrixRows: { label: string; cells: CellValue[] }[];
  matrixFootnote: string;
  features: Feature[];
  screenshots: Screenshot[];
  heroShot: { file: string; title: string; desc: string };
  quickStart: {
    install: { title: string; desc: string }[];
    steps: { title: string; desc: string }[];
  };
  docs: {
    kicker: string;
    heading: string;
    sub: string;
    navAria: string;
    articles: DocsArticle[];
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
        { href: '#docs', label: '文档' },
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
    { label: '数据库列表筛选（多库实例找库）', cells: ['yes', 'yes', 'yes', 'yes', 'yes', 'yes', 'yes'] },
    { label: '表格编辑', cells: ['yes', 'yes', 'yes', 'yes', 'yes', '文档编辑', '只读'] },
    { label: 'SQL Console / 命令控制台', cells: ['yes', 'yes', 'yes', 'yes', 'yes', 'mongosh', 'yes'] },
    { label: '结构编辑（表 / 列）', cells: ['yes', 'yes', 'yes', 'yes', 'yes', 'no', 'no'] },
    { label: '库级 DDL', cells: ['yes', '建/删 schema', '建/删 schema', '建/删 schema', 'no', 'yes', 'no'] },
    { label: 'SSL / SSH 隧道', cells: ['yes', 'yes', 'yes', '隧道', 'no', 'yes', 'yes'] },
    { label: '后台导出', cells: ['yes', 'yes', 'yes', 'yes', 'yes', 'yes', 'yes'] },
    { label: '数据导入（追加到既有表）', cells: ['yes', 'yes', 'yes', 'yes', 'yes', 'yes', 'no'] },
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
      icon: '📥',
      title: '数据导入，与导出同款护栏',
      desc: 'CSV / JSON / NDJSON / Excel 文件一键追加到既有表：列映射按名对齐可手调、类型不符行进错行报告不写入、空字段语义可选（默认 NULL 与导出互逆，往返一致）、500 行 / 批分事务提交（失败批回滚、已写批保留）、后台执行可取消；连接配置支持导出与批量导入 JSON——密码绝不随文件迁移，导入后首连一次性补录。',
    },
    {
      icon: '🔌',
      title: '连接开箱即用',
      desc: '每驱动动态连接表单；SSH 隧道（TOFU 指纹校验）与 SSL/TLS；密码只存系统密钥链，零遥测、不落盘。',
    },
    {
      icon: '📈',
      title: '图表与结构对比',
      desc: 'Console 结果一键生成图表 Tab：折线 / 柱状，可选 X 轴与数值列，大结果自动抽稀防卡顿，可导出 SVG/PNG；同连接跨库结构对比，表与列左右对齐——环境核对不用手写 diff SQL。',
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
    desc: '左侧资源树一键展开库 / 表 / 列 / 键 / 索引，多库实例可筛选显示的数据库（节点上带「已筛选 n/m」计数）；右侧筛选、排序、搜索全部参数化下推到数据库执行——不拉全表，千万行级也只取你看到的那一页。',
  },
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
  docs: {
    kicker: '使用文档',
    heading: '连接指南 · 核心概念 · 常见问题',
    sub: '面向使用者的三篇速查：把数据库连进来、把每个功能用明白、出问题时先查这里。',
    navAria: '文档导航',
    articles: [
      {
        id: 'connect',
        title: '连接指南',
        intro: '新建连接的通用设置、七类数据源各自的连接要点，以及 SSH 隧道与密码安全。',
        sections: [
          {
            h: '新建连接与通用设置',
            blocks: [
              {
                kind: 'p',
                text: '活动栏「数据库」图标 → 视图标题栏「＋ 新建连接」→ 选择数据源类型。连接表单由该数据源的驱动动态生成，必填项自带校验；所有连接都支持命名、颜色分组、环境标记与只读开关。',
              },
              {
                kind: 'ul',
                items: [
                  '环境标记：开发 / 测试 / 生产。生产环境连接的所有写操作与危险语句强制二次确认（表格提交需输入表名匹配），该约束不可关闭',
                  '只读开关：开启后任何非读语句 / 命令在扩展内直接拒绝（fail-closed），适合只看不改的场景',
                  '连接超时：默认值可在设置 dbExplorer.connection.connectTimeoutMs 调整（含 SSH 隧道建立时间）',
                ],
              },
              {
                kind: 'note',
                text: '密码只存 VSCode 系统密钥链（SecretStorage），不写入配置文件、日志与导出文件；扩展零遥测。',
              },
            ],
          },
          {
            h: 'MySQL',
            blocks: [
              {
                kind: 'ul',
                items: [
                  '主机 / 端口（默认 3306）/ 用户名 / 密码',
                  '「数据库」可留空：树上会列出该账号可见的全部库；留空时新建 Console 会提示选择',
                  'SSL 开关与连接池上限（并发查询复用池内连接）',
                ],
              },
            ],
          },
          {
            h: 'PostgreSQL',
            blocks: [
              {
                kind: 'ul',
                items: [
                  '连接的是数据库（database），树上按 schema 组织表、视图等对象',
                  'SSL 开关 +「跳过证书校验」：开启后不校验服务器证书（sslmode=require），存在中间人风险，仅建议开发 / 自签证书环境使用',
                ],
              },
            ],
          },
          {
            h: 'SQL Server',
            blocks: [
              {
                kind: 'ul',
                items: [
                  '主机 / 端口（默认 1433）/ 用户名 / 密码，可指定默认库',
                  '「跳过证书校验」（trustServerCertificate）带同样的中间人风险标注',
                  '跨库访问用三段名对象名（库.schema.对象），不要依赖 USE——连接池下 USE 只作用于单个物理连接',
                ],
              },
            ],
          },
          {
            h: 'Oracle',
            blocks: [
              {
                kind: 'ul',
                items: [
                  '服务名（service name）寻址，通常连 PDB；thin 纯 JS 驱动，支持 Oracle 19c 及以上',
                  'TCPS（TLS 直连加密）暂不支持；需要加密链路时可用 SSH 隧道',
                ],
              },
            ],
          },
          {
            h: 'SQLite',
            blocks: [
              {
                kind: 'ul',
                items: [
                  '本地数据库文件路径，可点「浏览」按钮选择',
                  '打开前校验 SQLite 文件魔数：误选普通小文件会被拒绝而不是被清空；0 字节文件视为新库',
                  '整库载入内存 + 写批次原子落盘，建议文件 ≤ 100MB',
                  '同步执行：正在运行的查询不可取消（见 FAQ）',
                ],
              },
            ],
          },
          {
            h: 'MongoDB',
            blocks: [
              {
                kind: 'ul',
                items: [
                  '主机 / 端口（默认 27017）/ 用户名（可留空）/ 密码',
                  '认证库 authDatabase 默认 admin；「数据库」可留空（树上列全部库）',
                  '直连单节点（本地单机 / 指定副本成员）时开启 directConnection',
                ],
              },
            ],
          },
          {
            h: 'Redis',
            blocks: [
              {
                kind: 'ul',
                items: [
                  '主机 / 端口（默认 6379）/ 密码 / db 编号',
                  'TLS 开关 +「跳过证书校验」：开启后连接可被中间人窃听 / 篡改，仅限自签证书的受信内网环境',
                ],
              },
            ],
          },
          {
            h: 'SSH 隧道（通用）',
            blocks: [
              {
                kind: 'p',
                text: '数据库在内网时，在连接表单的 SSH 区块填入跳板机地址、端口、用户与认证方式（密码或私钥），扩展先建隧道再连数据库。',
              },
              {
                kind: 'ul',
                items: [
                  '首次连接记录跳板机主机指纹（TOFU）；后续连接指纹变化会被拒绝并明确提示（防中间人劫持）',
                  '确认是跳板机正常变更（重装 / 换机）后，可在连接的高级选项临时开启「跳过主机指纹校验」重连，之后建议关闭该开关',
                ],
              },
            ],
          },
        ],
      },
      {
        id: 'concepts',
        title: '核心概念手册',
        intro: '资源树、表格编辑、Console、事务、结构管理到 AI 辅助——每个功能的行为与默认值。',
        sections: [
          {
            h: '资源树与懒加载',
            blocks: [
              {
                kind: 'p',
                text: '树按需展开（连接 → 库 → 表 → 列 / 键 / 索引），不预取全量元数据。库列表缓存默认 60 秒、列 / 键 / 索引缓存默认 300 秒（dbExplorer.tree.databaseTtlSeconds / columnTtlSeconds，修改后重载窗口生效）；节点右键可强制刷新。',
              },
            ],
          },
          {
            h: '表格视图与数据编辑',
            blocks: [
              {
                kind: 'ul',
                items: [
                  '筛选、排序、搜索全部参数化下推到数据库执行，不拉全表；单次传输上限 5000 行 / 5MB，取数行数上限默认 1000（dbExplorer.query.maxRows）',
                  '双击 / Enter / F2 编辑单元格，改动先进入「变更集」；工具栏「提交变更(N)」→ 参数化 SQL 预览 → 单事务提交',
                  '提交用乐观锁（WHERE 携带原值）：并发冲突会精确定位到错误行，其余变更不半提交',
                  'NULL 与空串严格区分，单元格右键可切换',
                  '无主键表默认只读：可用 dbExplorer.edit.allowNoPrimaryKey 开启「全列匹配」编辑模式（含二进制列的表仍不可编辑）',
                ],
              },
            ],
          },
          {
            h: '单元格查看器与大字段',
            blocks: [
              {
                kind: 'p',
                text: '超长文本 / 二进制单元格默认按 262,144 字符（256KB，dbExplorer.edit.cellMaxChars）截断传输预览前缀；点击 ▤ 打开查看器（大文本 / JSON 树 / 二进制十六进制与图片预览），打开查看器、编辑或复制时会自动取整值，不受截断影响。',
              },
            ],
          },
          {
            h: 'SQL Console',
            blocks: [
              {
                kind: 'ul',
                items: [
                  '树查询目录「新增查询」或任意 .sql 文件；Ctrl+Enter 执行光标所在语句，Ctrl+Shift+Enter 执行全部',
                  '按上下文补全库 / 表 / 列与方言关键字；查询历史上限 500 条',
                  '每条语句行内注记耗时 / 错误 / 取消状态；EXPLAIN 结果自动树形缩进',
                  '结果面板跟随 Console 绑定的库；跨库 SQL（如三段名对象名）按数据库原生语义执行',
                ],
              },
              {
                kind: 'note',
                text: '危险语句默认拦下要求确认：无 WHERE 的 UPDATE / DELETE、DROP、TRUNCATE 等在开发 / 测试环境弹结果面板横幅（继续 / 取消），生产环境弹模态确认；取消后语句不落历史。只读连接的非读语句直接拒绝。',
              },
            ],
          },
          {
            h: '交互式事务',
            blocks: [
              {
                kind: 'p',
                text: 'Console 工具栏 BEGIN / COMMIT / ROLLBACK；会话空闲默认 5 分钟自动 ROLLBACK 并通知（dbExplorer.transaction.idleTimeoutMs），防遗忘占锁。单连接同一时刻一个交互会话。',
              },
            ],
          },
          {
            h: '结构管理',
            blocks: [
              {
                kind: 'ul',
                items: [
                  '表设计器：可视化建表 / 改列 / 键 / 外键 / 索引，语句预览 + 破坏性操作红条告警',
                  '库级操作：MySQL 建 / 改 / 删库；PostgreSQL 与 SQL Server 建 / 删 schema；MongoDB 建 / 删库',
                  '「查看 DDL」随时打开建表语句；结构对比：同连接跨库的表 / 列结构 diff，适合环境核对',
                ],
              },
            ],
          },
          {
            h: 'ER 图',
            blocks: [
              {
                kind: 'p',
                text: '自动从外键收集表间关系，以某表为中心可做 1~3 度邻接展开；边标注外键级联动作（ON DELETE / ON UPDATE）。支持导出 SVG / PNG；表数超过 300 的库会先让用户选表再出图。',
              },
            ],
          },
          {
            h: '结果图表',
            blocks: [
              {
                kind: 'p',
                text: 'Console 结果一键生成图表 Tab：折线 / 柱状，可选 X 轴与数值列；大结果自动抽稀防卡顿；可导出 SVG / PNG。',
              },
            ],
          },
          {
            h: '导出',
            blocks: [
              {
                kind: 'ul',
                items: [
                  '六种格式：CSV / JSON / XLSX / NDJSON / Markdown / SQL INSERT（表格视图与 Console 结果都可导出；INSERT 仅表格视图——结果集没有单一目标表）',
                  '导出在后台任务执行：通知中心看进度、随时取消、多任务并发，完成后一键定位文件',
                  '默认格式与分页批量可配（dbExplorer.export.defaultFormat / chunkRows）',
                ],
              },
            ],
          },
          {
            h: 'AI 辅助（BYOK）',
            blocks: [
              {
                kind: 'ul',
                items: [
                  '六个能力：自然语言生成 SQL（直插编辑器，可「再来一个」）、选中 SQL 即时解释、EXPLAIN 结果一键解读、报错一键生成修复建议（编辑器内联 diff，确认后才落地）、表格筛选栏自然语言生成 WHERE 条件、生成结果重试',
                  '设置中心接入自己的 OpenAI 兼容服务（DeepSeek / Moonshot / ollama 等）：填 endpoint / 模型 / API Key，密钥只存系统密钥链',
                  '采样参数（temperature / maxTokens）与 token 用量统计在设置中心可见',
                ],
              },
              {
                kind: 'note',
                text: '隐私边界：默认只发送表结构（表 / 列 / 类型 / 注释），不发送任何数据行；AI 产物照常经过危险语句拦截。',
              },
            ],
          },
        ],
      },
      {
        id: 'faq',
        title: 'FAQ / 故障排查',
        intro: '只收使用中真实会遇到的问题：安装、连接、编辑、行为与环境。',
        sections: [
          {
            h: 'Marketplace 与 Open VSX 有什么区别？',
            blocks: [
              {
                kind: 'p',
                text: 'VSCode 官方发行版从 VSCode Marketplace 安装（扩展面板搜索 DB Kit）；VSCodium 等使用 Open VSX 源的兼容发行版从 Open VSX 安装；也可以从 GitHub Releases 下载 VSIX 手动安装（任何桌面版 VSCode 系发行版通用，1.85+）。VSCode Web 版（github.dev）暂不支持。',
              },
            ],
          },
          {
            h: '连接不上数据库，按什么顺序排查？',
            blocks: [
              {
                kind: 'ul',
                items: [
                  '先看错误提示：连接超时多是主机 / 端口 / 防火墙问题；认证失败核对用户名、密码与认证库',
                  '网络慢可调大 dbExplorer.connection.connectTimeoutMs；查询慢 / 超时调大 dbExplorer.query.timeoutMs',
                  'SSL 报证书错误：自签 / 内网环境可按表单风险提示临时开「跳过证书校验」（仅限受信网络）',
                  '走 SSH 隧道的先确认跳板机可登录；指纹变更被拒见下一条',
                ],
              },
            ],
          },
          {
            h: 'SSH 连接提示「主机指纹已变更」？',
            blocks: [
              {
                kind: 'p',
                text: '这是 TOFU 保护：首连记录的跳板机指纹与本次不符（跳板机重装 / 换机，或潜在中间人）。先人工确认跳板机确有变更，再在连接的高级选项临时开启「跳过主机指纹校验」重连；确认无误后建议关闭该开关。',
              },
            ],
          },
          {
            h: 'SQLite 打开文件被拒 / 提示不是数据库？',
            blocks: [
              {
                kind: 'p',
                text: '扩展在打开前校验 SQLite 文件魔数，误选普通文件会被拒绝（而不是当作空库清空内容）；0 字节文件视为新库。SQLite 整库载入内存，建议 ≤ 100MB；正在执行的查询不可取消。',
              },
            ],
          },
          {
            h: 'Oracle 报 TCPS / 加密相关错误？',
            blocks: [
              {
                kind: 'p',
                text: 'Oracle 驱动为 thin 纯 JS 模式（19c+），暂不支持 TCPS（TLS 直连）；需要加密链路时用 SSH 隧道。另注意 Oracle 引擎语义：空串即 NULL，Console 中超大整数精度受限。',
              },
            ],
          },
          {
            h: '树上「数据库」和表之间多了一层 schema？',
            blocks: [
              {
                kind: 'p',
                text: 'PostgreSQL / SQL Server / Oracle 的库节点下按 schema 组织对象（如 public / dbo），这是数据库原生层级；SQLite 是单库单 schema，MongoDB 树上为库 → collection → 字段目录。',
              },
            ],
          },
          {
            h: '为什么这张表不能编辑？',
            blocks: [
              {
                kind: 'ul',
                items: [
                  '无主键表默认只读（无法定位行）；可开 dbExplorer.edit.allowNoPrimaryKey 全列匹配模式，但含二进制列的表仍不可编辑',
                  '连接开了「只读」开关：所有非读语句直接拒绝',
                  'Redis 为只读浏览（键值数据源暂未开放编辑）',
                ],
              },
            ],
          },
          {
            h: '提交变更提示乐观锁冲突？',
            blocks: [
              {
                kind: 'p',
                text: '该行在你编辑期间被其他会话修改过。冲突行会精确定位，其余变更未提交（无半提交）；刷新数据后对最新值重做该行变更即可。',
              },
            ],
          },
          {
            h: 'SQL Server 提交 / 插入报触发器相关错误？',
            blocks: [
              {
                kind: 'p',
                text: '带触发器的表不支持 INSERT 回填（OUTPUT 子句被服务端拒绝），也不支持 GO 批；可先预览生成的 SQL 手动执行。',
              },
            ],
          },
          {
            h: 'MongoDB 能建索引 / 改集合吗？',
            blocks: [
              {
                kind: 'p',
                text: '结构类 mongosh 命令（建索引、改集合等）不支持——结构变更请用 mongosh 等原生工具；文档浏览、命令控制台与文档编辑（字段级 $set 乐观锁、逐条应用失败即停）在支持范围内。',
              },
            ],
          },
          {
            h: '长查询怎么取消？SQLite 卡住了？',
            blocks: [
              {
                kind: 'p',
                text: 'SQL 类驱动的查询可取消（扩展向服务端下发取消请求）；SQLite 为进程内同步执行，不可取消——大表查询先加条件或缩小范围。',
              },
            ],
          },
          {
            h: 'VSCode 弹「Unable to resolve your shell environment」通知？',
            blocks: [
              {
                kind: 'p',
                text: '这是 VSCode 自身的 shell 环境解析提示，与本插件无关，也不影响插件功能，可忽略或在 VSCode 设置中处理。',
              },
            ],
          },
          {
            h: '界面语言 / 我的数据会传到哪里？',
            blocks: [
              {
                kind: 'ul',
                items: [
                  '界面语言跟随 VSCode 显示语言（中文为源语言，英文为辅助翻译）',
                  '扩展零遥测：不收集、不上报任何使用数据',
                  '密码 / API 密钥只存系统密钥链；AI 辅助默认只发送表结构、不发送数据行',
                ],
              },
            ],
          },
        ],
      },
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
        { href: '#docs', label: 'Docs' },
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
    { label: 'Database list filter (multi-schema instances)', cells: ['yes', 'yes', 'yes', 'yes', 'yes', 'yes', 'yes'] },
    { label: 'Table editing', cells: ['yes', 'yes', 'yes', 'yes', 'yes', 'Document edit', 'Read-only'] },
    { label: 'SQL Console / command console', cells: ['yes', 'yes', 'yes', 'yes', 'yes', 'mongosh', 'yes'] },
    { label: 'Schema editing (tables / columns)', cells: ['yes', 'yes', 'yes', 'yes', 'yes', 'no', 'no'] },
    { label: 'Database-level DDL', cells: ['yes', 'Create/drop schema', 'Create/drop schema', 'Create/drop schema', 'no', 'yes', 'no'] },
    { label: 'SSL / SSH tunnel', cells: ['yes', 'yes', 'yes', 'Tunnel', 'no', 'yes', 'yes'] },
    { label: 'Background export', cells: ['yes', 'yes', 'yes', 'yes', 'yes', 'yes', 'yes'] },
    { label: 'Data import (append to existing table)', cells: ['yes', 'yes', 'yes', 'yes', 'yes', 'yes', 'no'] },
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
      icon: '📥',
      title: 'Data import with the same guardrails as export',
      desc: 'Append CSV / JSON / NDJSON / Excel files to an existing table in one go: column mapping auto-aligned by name and hand-tunable, type-mismatched rows go to a bad-row report instead of the database, empty-field semantics selectable (defaults to NULL — the inverse of export, round-trip safe), 500-row batches committed per transaction (failed batch rolls back, written batches stay), background execution with cancel; connection configs can also be exported and bulk-imported as JSON — passwords never travel with the file, one-time prompt on first connect.',
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
    desc: 'Expand databases / tables / columns / keys / indexes from the tree on the left; filter the visible databases on multi-schema instances (with an "n/m shown" counter on the node); filtering, sorting and search on the right are all pushed down to the database with parameterized SQL — no full-table scans; at tens of millions of rows you still fetch only the page you see.',
  },
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
  docs: {
    kicker: 'Documentation',
    heading: 'Connect · Concepts · FAQ',
    sub: 'Three quick references for users: get connected, understand every feature, and know where to look when something misbehaves.',
    navAria: 'Docs navigation',
    articles: [
      {
        id: 'connect',
        title: 'Connection Guide',
        intro: 'General connection settings, per-engine essentials for all seven data sources, plus SSH tunneling and password safety.',
        sections: [
          {
            h: 'New connection & general settings',
            blocks: [
              {
                kind: 'p',
                text: 'Click the Database icon in the activity bar → ＋ New Connection in the view title bar → pick a data source type. The connection form is generated dynamically by that engine\u2019s driver, with validation on required fields; every connection supports naming, color groups, an environment label and a read-only switch.',
              },
              {
                kind: 'ul',
                items: [
                  'Environment label: dev / test / prod. On prod connections every write or dangerous statement requires a forced second confirmation (table edits require typing the table name) — this cannot be turned off',
                  'Read-only switch: once enabled, any non-read statement / command is rejected outright inside the extension (fail-closed) — for browse-only scenarios',
                  'Connect timeout: adjust the default in dbExplorer.connection.connectTimeoutMs (includes SSH tunnel establishment)',
                ],
              },
              {
                kind: 'note',
                text: 'Passwords live only in the VSCode system keychain (SecretStorage) — never in settings files, logs or exports; the extension has zero telemetry.',
              },
            ],
          },
          {
            h: 'MySQL',
            blocks: [
              {
                kind: 'ul',
                items: [
                  'Host / port (default 3306) / username / password',
                  'The "database" field is optional: the tree lists all databases visible to the account; if left empty, a new Console will prompt you to pick one',
                  'SSL switch and connection pool size (concurrent queries reuse pooled connections)',
                ],
              },
            ],
          },
          {
            h: 'PostgreSQL',
            blocks: [
              {
                kind: 'ul',
                items: [
                  'You connect to a database; the tree organizes tables and views by schema',
                  'SSL switch + "skip certificate verification": skips server certificate validation (sslmode=require) — man-in-the-middle risk, recommended only for dev / self-signed environments',
                ],
              },
            ],
          },
          {
            h: 'SQL Server',
            blocks: [
              {
                kind: 'ul',
                items: [
                  'Host / port (default 1433) / username / password, with an optional default database',
                  '"Skip certificate verification" (trustServerCertificate) carries the same man-in-the-middle warning',
                  'Cross-database access: use three-part object names (db.schema.object) — do not rely on USE, which under connection pooling only affects a single physical connection',
                ],
              },
            ],
          },
          {
            h: 'Oracle',
            blocks: [
              {
                kind: 'ul',
                items: [
                  'Addressed by service name, usually a PDB; thin pure-JS driver, Oracle 19c and above',
                  'TCPS (TLS direct encryption) is not supported yet; use an SSH tunnel when you need an encrypted link',
                ],
              },
            ],
          },
          {
            h: 'SQLite',
            blocks: [
              {
                kind: 'ul',
                items: [
                  'Path to a local database file; use the "Browse" button to pick one',
                  'The SQLite file magic number is verified before opening: accidentally picking a regular small file is rejected rather than wiped; a 0-byte file counts as a new database',
                  'Whole database loads into memory + atomic flush per write batch; files up to 100MB recommended',
                  'Synchronous execution: a running query cannot be canceled (see FAQ)',
                ],
              },
            ],
          },
          {
            h: 'MongoDB',
            blocks: [
              {
                kind: 'ul',
                items: [
                  'Host / port (default 27017) / username (optional) / password',
                  'Auth database defaults to admin; the "database" field is optional (the tree lists all databases)',
                  'Enable directConnection when connecting straight to a single node (local standalone / a chosen replica member)',
                ],
              },
            ],
          },
          {
            h: 'Redis',
            blocks: [
              {
                kind: 'ul',
                items: [
                  'Host / port (default 6379) / password / db number',
                  'TLS switch + "skip certificate verification": the connection can be intercepted or tampered with — only for trusted internal networks with self-signed certificates',
                ],
              },
            ],
          },
          {
            h: 'SSH tunnel (general)',
            blocks: [
              {
                kind: 'p',
                text: 'When the database sits behind a jump host, fill in the SSH section of the connection form (host, port, user and password or private key); the extension establishes the tunnel before connecting to the database.',
              },
              {
                kind: 'ul',
                items: [
                  'The jump host fingerprint is recorded on first connect (TOFU); a changed fingerprint on later connections is rejected with an explicit warning (anti man-in-the-middle)',
                  'After confirming the jump host legitimately changed (reinstall / replacement), you can temporarily enable "skip host fingerprint verification" in the advanced options to reconnect — then turn it back off',
                ],
              },
            ],
          },
        ],
      },
      {
        id: 'concepts',
        title: 'Core Concepts',
        intro: 'From the resource tree, table editing and the Console to transactions, schema management and the AI assistant — how each feature behaves, with defaults.',
        sections: [
          {
            h: 'Resource tree & lazy loading',
            blocks: [
              {
                kind: 'p',
                text: 'The tree expands on demand (connection → database → table → columns / keys / indexes) without prefetching everything. The database list is cached for 60 seconds and column / key / index metadata for 300 seconds by default (dbExplorer.tree.databaseTtlSeconds / columnTtlSeconds; changes apply after a window reload); right-click any node to force refresh.',
              },
            ],
          },
          {
            h: 'Table view & data editing',
            blocks: [
              {
                kind: 'ul',
                items: [
                  'Filtering, sorting and search are all pushed down to the database with parameterized SQL — no full-table pulls; transfer is capped at 5000 rows / 5MB per query, with a default row cap of 1000 (dbExplorer.query.maxRows)',
                  'Double-click / Enter / F2 to edit a cell; changes first land in the change set; "Commit Changes (N)" in the toolbar → parameterized SQL preview → single-transaction commit',
                  'Commits use optimistic locking (WHERE carries original values): concurrent conflicts are pinpointed to the offending rows, and the rest of the batch is not half-committed',
                  'NULL and empty string are strictly distinct; right-click a cell to switch between them',
                  'Tables without a primary key are read-only by default: enable dbExplorer.edit.allowNoPrimaryKey for "all-column match" editing (tables containing binary columns remain non-editable)',
                ],
              },
            ],
          },
          {
            h: 'Cell viewer & large values',
            blocks: [
              {
                kind: 'p',
                text: 'Oversized text / binary cells transfer a preview prefix truncated at 262,144 characters (256KB, dbExplorer.edit.cellMaxChars) by default; click ▤ to open the viewer (long text / JSON tree / binary hex and image preview). Opening the viewer, editing or copying fetches the full value automatically — truncation never affects those paths.',
              },
            ],
          },
          {
            h: 'SQL Console',
            blocks: [
              {
                kind: 'ul',
                items: [
                  '"New Query" in the tree query folder or any .sql file; Ctrl+Enter runs the statement at the cursor, Ctrl+Shift+Enter runs all',
                  'Context-aware completion for databases / tables / columns and dialect keywords; query history keeps the last 500 entries',
                  'Per-statement inline annotations for duration / error / canceled status; EXPLAIN results are auto-indented as a tree',
                  'The result panel follows the Console\u2019s bound database; cross-database SQL (e.g. three-part names) follows native database semantics',
                ],
              },
              {
                kind: 'note',
                text: 'Dangerous statements stop for confirmation by default: UPDATE / DELETE without WHERE, DROP, TRUNCATE and friends show a result-panel banner on dev / test (proceed / cancel) and a modal on prod; a canceled run leaves no history. Non-read statements on read-only connections are rejected outright.',
              },
            ],
          },
          {
            h: 'Interactive transactions',
            blocks: [
              {
                kind: 'p',
                text: 'BEGIN / COMMIT / ROLLBACK from the Console toolbar; an idle session is rolled back automatically after 5 minutes by default with a notification (dbExplorer.transaction.idleTimeoutMs), so forgotten locks never linger. One interactive session per connection at a time.',
              },
            ],
          },
          {
            h: 'Schema management',
            blocks: [
              {
                kind: 'ul',
                items: [
                  'Table designer: visual create / alter for tables, columns, keys, foreign keys and indexes, with statement preview and red-bar warnings for destructive operations',
                  'Database-level operations: MySQL create / alter / drop database; PostgreSQL and SQL Server create / drop schema; MongoDB create / drop database',
                  '"View DDL" opens the CREATE statement anytime; schema compare diffs tables / columns across databases within a connection — handy for environment checks',
                ],
              },
            ],
          },
          {
            h: 'ER diagram',
            blocks: [
              {
                kind: 'p',
                text: 'Relationships are collected automatically from foreign keys, with 1- to 3-degree neighbor expansion centered on any table; edges are labeled with referential actions (ON DELETE / ON UPDATE). SVG / PNG export included; databases with more than 300 tables ask you to pick a table first.',
              },
            ],
          },
          {
            h: 'Result charts',
            blocks: [
              {
                kind: 'p',
                text: 'One click turns a Console result into a chart tab: line / bar with selectable X axis and numeric series; large results are downsampled automatically to stay smooth; export as SVG / PNG.',
              },
            ],
          },
          {
            h: 'Export',
            blocks: [
              {
                kind: 'ul',
                items: [
                  'Six formats: CSV / JSON / XLSX / NDJSON / Markdown / SQL INSERT (both the table view and Console results export; INSERT is table-view-only — a result set has no single target table)',
                  'Exports run as background tasks: progress in the notification center, cancel anytime, tasks run concurrently, one click to reveal the file when done',
                  'Default format and batch size are configurable (dbExplorer.export.defaultFormat / chunkRows)',
                ],
              },
            ],
          },
          {
            h: 'AI assistant (BYOK)',
            blocks: [
              {
                kind: 'ul',
                items: [
                  'Six abilities: generate SQL from natural language (inserted into the editor, with "Try Again"), explain a selection instantly, one-click EXPLAIN interpretation, one-click fix suggestions for SQL errors (inline editor diff, applied only after confirmation), natural-language WHERE conditions in the table filter bar, and retrying a generation',
                  'Plug in your own OpenAI-compatible service (DeepSeek / Moonshot / ollama and more) from the Settings hub: endpoint / model / API key, with the key kept only in the system keychain',
                  'Sampling parameters (temperature / maxTokens) and token usage stats are visible in the Settings hub',
                ],
              },
              {
                kind: 'note',
                text: 'Privacy boundary: only table structure is sent by default (tables / columns / types / comments) — never data rows; AI output still passes danger checks.',
              },
            ],
          },
        ],
      },
      {
        id: 'faq',
        title: 'FAQ / Troubleshooting',
        intro: 'Only problems users actually hit, grouped by install, connection, editing, behavior and environment.',
        sections: [
          {
            h: 'VSCode Marketplace vs Open VSX?',
            blocks: [
              {
                kind: 'p',
                text: 'The official VSCode distribution installs from the VSCode Marketplace (search DB Kit in the Extensions panel); VSCodium and other Open VSX-based distributions install from Open VSX; you can also download a VSIX from GitHub Releases for a manual install (works on any desktop VSCode-based distribution, 1.85+). VSCode for the Web (github.dev) is not supported.',
              },
            ],
          },
          {
            h: 'Cannot connect — what to check, in order?',
            blocks: [
              {
                kind: 'ul',
                items: [
                  'Read the error first: connect timeouts are usually host / port / firewall; auth failures mean username, password or auth database',
                  'Raise dbExplorer.connection.connectTimeoutMs on slow networks; raise dbExplorer.query.timeoutMs for slow queries',
                  'SSL certificate errors: on self-signed / internal networks you can temporarily enable "skip certificate verification" per the form\u2019s risk note (trusted networks only)',
                  'For SSH tunnels, first confirm the jump host is reachable; a rejected fingerprint is covered next',
                ],
              },
            ],
          },
          {
            h: 'SSH says "host fingerprint changed"?',
            blocks: [
              {
                kind: 'p',
                text: 'That is TOFU protection: the fingerprint recorded on first connect no longer matches (the jump host was reinstalled / replaced, or there is a man in the middle). Confirm the host legitimately changed, then temporarily enable "skip host fingerprint verification" in the advanced options to reconnect — and turn it back off afterwards.',
              },
            ],
          },
          {
            h: 'SQLite refuses to open a file / says it is not a database?',
            blocks: [
              {
                kind: 'p',
                text: 'The SQLite file magic number is verified before opening: accidentally picking a regular file is rejected (instead of treating it as an empty database and wiping content); a 0-byte file counts as a new database. The whole database loads into memory — 100MB or less recommended; a running query cannot be canceled.',
              },
            ],
          },
          {
            h: 'Oracle errors about TCPS / encryption?',
            blocks: [
              {
                kind: 'p',
                text: 'The Oracle driver is thin pure-JS (19c+) and does not support TCPS (TLS direct encryption) yet; use an SSH tunnel when you need an encrypted link. Also note Oracle engine semantics: empty string is NULL, and very large integers have reduced precision in the Console.',
              },
            ],
          },
          {
            h: 'There is a schema layer between the database and tables?',
            blocks: [
              {
                kind: 'p',
                text: 'PostgreSQL / SQL Server / Oracle organize objects under a database by schema (public / dbo and friends) — that is the native hierarchy; SQLite is single-database single-schema, and MongoDB shows database → collection → field catalog.',
              },
            ],
          },
          {
            h: 'Why is this table not editable?',
            blocks: [
              {
                kind: 'ul',
                items: [
                  'Tables without a primary key are read-only by default (rows cannot be addressed); enable dbExplorer.edit.allowNoPrimaryKey for all-column match — tables with binary columns stay read-only',
                  'The connection has the read-only switch on: non-read statements are rejected outright',
                  'Redis is browse-only (key-value sources have no editing yet)',
                ],
              },
            ],
          },
          {
            h: 'Committing says optimistic-lock conflict?',
            blocks: [
              {
                kind: 'p',
                text: 'That row was modified by another session while you were editing. The conflicting rows are pinpointed and the rest of the batch is not committed (no half-commit); refresh and redo that row against the latest values.',
              },
            ],
          },
          {
            h: 'SQL Server errors about triggers on commit / insert?',
            blocks: [
              {
                kind: 'p',
                text: 'Tables with triggers do not support INSERT back-fill (the OUTPUT clause is rejected by the server), and GO batches are not supported; preview the generated SQL and run it manually instead.',
              },
            ],
          },
          {
            h: 'Can MongoDB create indexes / alter collections?',
            blocks: [
              {
                kind: 'p',
                text: 'Structural mongosh commands (create index, alter collection, etc.) are not supported — do structural changes with mongosh or other native tools; document browsing, the command console and document editing (field-level $set optimistic locking, applied one by one and stopping at the first failure) are supported.',
              },
            ],
          },
          {
            h: 'How do I cancel a long query? SQLite is stuck?',
            blocks: [
              {
                kind: 'p',
                text: 'Queries on SQL drivers can be canceled (the extension sends a cancellation to the server); SQLite executes synchronously in-process and cannot be canceled — narrow big-table queries with conditions first.',
              },
            ],
          },
          {
            h: 'VSCode shows "Unable to resolve your shell environment"?',
            blocks: [
              {
                kind: 'p',
                text: 'That is VSCode\u2019s own shell-resolution notice, unrelated to this extension and harmless to it — ignore it or address it in VSCode settings.',
              },
            ],
          },
          {
            h: 'UI language / where does my data go?',
            blocks: [
              {
                kind: 'ul',
                items: [
                  'The UI language follows the VSCode display language (Chinese is the source language; English is the auxiliary translation)',
                  'Zero telemetry: nothing is collected or reported',
                  'Passwords / API keys live only in the system keychain; the AI assistant sends table structure only by default — never data rows',
                ],
              },
            ],
          },
        ],
      },
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
