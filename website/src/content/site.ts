// 站点内容唯一事实源 —— 全部文案取自 packages/extension/README.md 与根 README.md，禁止虚构。
// 品牌渐变 #2b7fff → #1554c0 与扩展图标同源（packages/extension/media/extension-icon.svg）。

const REPO = 'https://github.com/Fengjing95/vsc-plugin-db';
const BASE = import.meta.env.BASE_URL; // '/vsc-plugin-db/'（本地 dev 为 '/'）

export const withBase = (path: string) => `${BASE}${path.replace(/^\//, '')}`;

export const site = {
  name: 'DB Kit',
  version: 'v0.2.1',
  tagline: '在 VSCode 里，搞定数据库的一切',
  subTagline: '浏览 · 查询 · 编辑 · 导出 —— 六类数据源统一入口，开箱即连、零遥测。',
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
    /**
     * TODO(上线前)：建好「路线图征集」单一 roadmap issue 后，把此链接替换为该 issue 地址。
     * 当前用 Issues 列表占位（用户已选定单一 roadmap 策略，三卡共用）。
     */
    roadmapIssue: `${REPO}/issues`,
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
  { key: 'sqlite', name: 'SQLite', logo: withBase('assets/logos/sqlite.svg') },
  { key: 'mongodb', name: 'MongoDB', logo: withBase('assets/logos/mongoDB.svg') },
  { key: 'redis', name: 'Redis', logo: withBase('assets/logos/Redis.svg') },
];

export type CellValue = 'yes' | 'no' | string; // 'yes'=✓，'no'=—，其余为变体文案（如「文档编辑」「只读」）

// 逐格口径 = packages/extension/README.md §支持矩阵
export const matrixRows: { label: string; cells: CellValue[] }[] = [
  { label: '资源树浏览', cells: ['yes', 'yes', 'yes', 'yes', 'yes', 'yes'] },
  { label: '表格编辑', cells: ['yes', 'yes', 'yes', 'yes', '文档编辑', '只读'] },
  { label: 'SQL Console / 命令控制台', cells: ['yes', 'yes', 'yes', 'yes', 'mongosh', 'yes'] },
  { label: '结构编辑（表 / 列）', cells: ['yes', 'yes', 'yes', 'yes', 'no', 'no'] },
  { label: '库级 DDL', cells: ['yes', 'yes', '建/删 schema', 'no', 'yes', 'no'] },
  { label: 'SSL / SSH 隧道', cells: ['yes', 'yes', 'yes', 'no', 'yes', 'yes'] },
  { label: '后台导出', cells: ['yes', 'yes', 'yes', 'yes', 'yes', 'yes'] },
];

export const matrixFootnote =
  'SQLite 限中小库（≤ 100MB）；MongoDB 结构类命令不支持；SQL Server 不支持 GO 批与触发器表的 INSERT 回填。';

export type Feature = { icon: string; title: string; desc: string };

// 五大亮点文案逐字取自 packages/extension/README.md §亮点
export const features: Feature[] = [
  {
    icon: '📊',
    title: '表格即工作台',
    desc: '虚拟滚动流畅浏览大表；单元格双击直改，提交前给出参数化 SQL 预览，单事务提交 + 字段级乐观锁，并发冲突精准定位到错误行；无主键表默认只读保护。',
  },
  {
    icon: '⌨️',
    title: 'SQL Console 会补全也会踩刹车',
    desc: '按上下文补全库 / 表 / 列与方言关键字；UPDATE / DELETE 不带 WHERE 直接拦截，生产库分级二次确认；EXPLAIN 结果自动树形缩进；每条语句的耗时 / 错误 / 取消状态行内注记。',
  },
  {
    icon: '🧱',
    title: '结构管理不写 DDL',
    desc: '表与列的可视化增删改，语句预览 + 破坏性操作红条告警；库级操作开箱可用：MySQL 建 / 改 / 删库，PostgreSQL 与 SQL Server 建 / 删 schema，MongoDB 建 / 删库。',
  },
  {
    icon: '📤',
    title: '百万行导出不卡界面',
    desc: 'CSV / JSON / XLSX 流式导出转入后台执行：通知中心看进度、随时取消、多任务并发，导完一键定位文件。',
  },
  {
    icon: '🔌',
    title: '连接开箱即用',
    desc: '每驱动动态连接表单；SSH 隧道（TOFU 指纹校验）与 SSL/TLS；密码只存系统密钥链，零遥测、不落盘。',
  },
];

export type Screenshot = { file: string; title: string; desc: string };

export const screenshots: Screenshot[] = [
  {
    file: 'console.png',
    title: 'SQL Console',
    desc: '上下文补全、危险语句拦截、EXPLAIN 树形缩进与行内执行注记',
  },
  {
    file: 'schema-editor.png',
    title: '表结构编辑器',
    desc: '可视化增删改表与列，语句预览、破坏性操作红条告警',
  },
  {
    file: 'database-ddl.png',
    title: '库级操作',
    desc: '驱动动态表单建库，预览确认后才执行',
  },
  {
    file: 'export.png',
    title: '后台导出',
    desc: '通知中心看进度、随时取消，导完一键定位文件',
  },
];

export const heroShot = {
  file: 'overview-table.png',
  title: '资源树 + 表格工作台',
  desc: '左侧资源树一键展开库 / 表 / 列 / 键 / 索引；右侧筛选、排序、搜索全部参数化下推到数据库执行——不拉全表，千万行级也只取你看到的那一页。',
};

export type ComingItem = { name: string; desc: string; tags?: string[] };

export const comingSoon: ComingItem[] = [
  { name: 'Oracle', desc: '企业级关系型数据库' },
  {
    name: '国产数据库（信创）',
    desc: '国产数据库阵营合一张卡，优先级听你的',
    tags: ['达梦', '人大金仓', 'openGauss'],
  },
];

// 三步体验（口径 = 根 README §快速上手 / extension README §30 秒上手）
export const quickStart = {
  install: [
    { title: '扩展面板安装', desc: 'VSCode 扩展面板搜索 DB Kit，一键安装' },
    { title: '命令行安装', desc: '在终端执行下方命令' },
    { title: 'VSIX 手动安装', desc: '从 GitHub Releases 下载 VSIX，扩展视图「…」→ Install from VSIX' },
  ] as { title: string; desc: string }[],
  steps: [
    { title: '新建连接', desc: '安装后点活动栏「数据库」图标 → ＋ 新建连接' },
    {
      title: '浏览与编辑',
      desc: '单击表名打开表格视图；双击单元格直改，提交前给出参数化 SQL 预览',
    },
    { title: '写 SQL', desc: '树中「新增查询」写 SQL，Ctrl+Enter 执行' },
  ],
};
