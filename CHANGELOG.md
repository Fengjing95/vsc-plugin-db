# 更新日志

本项目的所有重要变更记录在此文件中。格式参照 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)；版本遵循语义化版本（0.x 为预稳定阶段）。

## [Unreleased]

### 修复

- **表格视图筛选栏改为单行输入**：WHERE / ORDER BY 输入框不再支持换行——Shift+Enter 不产生换行，粘贴或 AI 回填进来的多行内容连同相邻空白折叠为单空格；内容超宽时横向滚动。修复多行内容在单行高度中无法滚动查看的问题（0.8.0 的 AI 回填使该问题显性化）
- **筛选栏横向滚动时语法高亮层不跟随**：单行输入框拖动滚动条 / 滚轮横向滚动时只有光标在动、可见内容原地不动（React 的 `onScroll` 对非冒泡 scroll 事件不触发）——滚动同步改原生事件监听，高亮层实时跟随

## [0.8.0] - 2026-10-28

两批能力合并发版：MySQL Console 语句取消（能力缺口清单 ①）+ AI P2 面批次 A（交互稿 §15.7 四项转正）。

### 特性

- **AI 自然语言筛选**：表格视图筛选栏新增「✨ AI」——用自然语言描述筛选需求，AI 按本表列结构生成 WHERE 条件并**回填到筛选栏**（语法高亮、可改），确认后点「应用」才生效，不自动执行；片段经 fail-closed 消毒（分号 / 注释 / 超长一律拒绝）。只发送本表结构，不发送数据行
- **AI 解释执行计划**：Console 结果面板的 EXPLAIN 结果 Tab 新增「✨ 解释执行计划」——计划文本送 AI 解读访问路径、连接顺序、潜在瓶颈与优化建议，流式呈现在「AI 解释」Tab（支持重试）。计划是查询元信息，隐私边界不变
- **AI 生成「再来一个」**：生成 SQL 直插后的通知新增「再来一个」——同一需求重新生成并替换刚插入的结果（原结果被编辑过则拒绝盲替换）
- **AI 采样参数与用量统计**：设置中心 AI 分类新增「采样参数」（`dbExplorer.ai.temperature` 0–2、`dbExplorer.ai.maxTokens`，与 VSCode 设置双向同步，留空走模型默认）与「用量统计」（累计请求数 / 输入 / 输出 / 合计 tokens，仅统计服务端上报用量的请求；本地累计不上传）
- **MySQL Console 语句取消**：mysql 驱动 `supportsCancel` 转为 true——Console「取消」（与语句超时死线）经**专用临时连接**下发 `KILL QUERY <threadId>`（只杀语句不断连接，取消后连接可复用），在途语句回包 `ER_QUERY_INTERRUPTED` 映射 `E_CANCELED`；归还前有界等待结算（pg 同构，防归还竞态）。契约 cancellation 组三检查（预中止 / 在途取消 / 连接复用）随 CI `mysql:8` service 实跑
- **MySQL Console 语句超时生效**：`dbExplorer.query.timeoutMs`（默认 15s）此前被 mysql 驱动忽略，现按驱动规范 §7 对齐 pg 口径——超时请求服务端取消并抛 `E_TIMEOUT`

### 修复

- **e2e 通知气泡兜底失效**（本地 macOS 偶发两连红定因）：`dismissNotifications` 的清除按钮选择器在 VSCode DOM 中不存在，错误级「shell 环境解析超时」toast 穿透时拦截 Save 点击——修正为 codicon 类选择器 + `notifications.hideToasts` 命令兜底，关键点击改「清气泡→点击」重试

### 已知限制

- AI 能力依赖用户自配的 OpenAI 兼容服务，不进 e2e 回归（D-26 明确排除外部 LLM）——回归面为纯函数单测 + 实机手测
- 用量统计只覆盖响应中携带 `usage` 字段的服务（OpenAI `stream_options.include_usage` 口径）；不上报用量的服务不计入
- 自然语言筛选只携带当前表结构（列名 / 注释），复杂跨表条件需手写
- AI P2 面批次 B（`@dbkit` chat participant / 采样行 opt-in / 多 provider 配置位）经 ADR D-27 决议不做，重开条件见概要设计 §11

## [0.7.1] - 2026-10-26

### 修复

- **英文界面未生效**（0.7.0 回归定级）：VSCode 在显示语言为英文时**不加载**扩展的 `bundle.l10n.en.json`（官方按「源文案 = 英文」假定设计，microsoft/vscode#168127）——命令面板/资源树/通知等约 310 处 extension 侧文案在英文环境恒回落中文；manifest 层（视图标题/菜单，`package.nls.en.json`）不受影响，造成「标题英文、内容中文」的分裂。修复：extension 侧不再依赖 `vscode.l10n` 的 bundle 加载，门面按显示语言自行读取随包词典文件（`l10n/bundle.l10n.<lang>.json`，语言码回退 `en-us`→`en`；zh 源语言零文件依赖，未翻译语言静默回落原文）。Webview / 官网 / README 不受此问题影响（各自词典链路不同）

## [0.7.0] - 2026-10-25

i18n 中英双语（概要 §14 #7 收口，ADR D-25）：UI / 官网 / GitHub·Marketplace README 三面四件套。

### 特性

- **界面语言跟随 VSCode 显示语言**（中文为源语言、英文为翻译，v1 不设插件内语言切换项）：
  - **Extension 侧**走 VSCode 官方 l10n——命令面板 / 资源树 / 各类通知与确认框 / 连接表单（SSH 字段）/ CodeLens / 执行注记等约 310 处文案全部 `t()` 化；`package.json` contributes（命令标题 / 视图名 / 配置描述）`%key%` 化并随显示语言自动切换
  - **Webview 侧**（表格 / Console / 连接表单 / 表设计器 / ER 图 / 库级 DDL / 设置中心）约 540 处文案键化入 protocol 十域词典（zh 权威键集 ~570 键 + en 全量对译，键集全等有测试守卫）；错误码 → 文案映射（C-6）本地化，驱动错误 message 仍按 detail 原文展示
  - **连接表单驱动字段键化**：八驱动 label / placeholder / hint / 分节标题统一 form.* 域键，webview 渲染时解析（未登记文本原样展示，第三方驱动天然兼容）
- **官网双语**（dbkit.easyremember.cn）：导航 / 页脚双语言切换器，localStorage 持久化、首访按浏览器语言；全部板块（亮点 / 支持矩阵 / 界面 / Coming Soon / 快速上手 / 页脚）+ Playground 外壳与嵌入的 webview 界面随站点语言
- **README 双语**：仓库根新增 `README.en.md`（完整英文版，顶部互链）；Marketplace 详情页（extension README）顶部新增英文摘要节（Highlights / Quick Start / Support Matrix / Install）

### 修复

- 设置项 `dbExplorer.export.defaultFormat` 枚举停在旧三格式（v0.2.33 已扩六格式，漏同步）——补齐 ndjson / markdown / insert 并附 enumDescriptions
- 官网支持矩阵标题「五引擎」与实际七引擎不符（sub 行本就列 7 引擎）
- PostgreSQL「库级 DDL」能力格三处低报为纯 ✓（实际支持建/删 schema，D-19 口径）——根 README 原本正确，extension README 与官网已对齐
- 官网静态 `<title>` / meta description 与词典口径不一致（引擎清单 5→7）

### 已知限制

- 英文词表与官网 en 首版为辅助翻译（B6 批次做过术语一致性校对，欢迎 issue 指正）；Issue 模板等社区面暂为中文
- 官网静态首屏 SEO 标签为中文（客户端切换机制下 en 内容在 bundle 内，`/en/` 独立路由双构建列 P2）
- 界面截图为中文界面（英文界面以 VSCode 显示语言为准，截图暂未重制）

## [0.6.0] - 2026-10-25

能力丰富批次：单元格查看器、导出格式补齐、ER 图导出（概要 §6 #12 / §5.7 / 交互稿 §13.9 收口）。

### 特性

- **单元格查看器**（大文本 / JSON / 二进制）：binary/json 类型或超长文本（>200 字符）的单元格右上角 ▤ 角标打开——大文本等宽编辑 + 格式化 + 保存写回 ChangeSet（主键列 / 只读连接与内联编辑同口径降级）；JSON 折叠树 / 原文编辑双 Tab，语法非法时禁用保存；二进制只读 hex（前 64KB）+ PNG/JPEG/GIF 预嗅探直接预览 + 另存为文件。协议新增 `cell.fetch`（`capabilities.lazyCell` 能力门控，按需拉取整值）与 `sys.saveFile`（Host 原生保存对话框），驱动契约组 `lazy-cell` 上线（未实现自动跳过，后续驱动接入即受契约把守）
- **导出格式补齐（六格式）**：表格导出在 CSV / JSON / XLSX 之上新增 **NDJSON**（每行独立 JSON 对象，取消任意时刻均合法）/ **Markdown**（管道转义 + NULL 显式标注）/ **SQL INSERT**（MySQL 方言反引号、限定 `db`.`obj`，每批一条完整多值语句规避 max_allowed_packet）；Console 结果面板同步新增 ⇩ NDJSON / ⇩ MD；设置中心「导出默认格式」六选一；保存对话框按格式过滤
- **ER 图导出**：工具栏「导出 SVG / 导出 PNG」——SVG 从图数据模型直接生成（节点卡片 / 列行 / PK·FK 标记 / 鸦爪边与画布同源，色值随主题 token），PNG 为 2x 光栅化；空图禁用，结果提示在状态行

### 修复

- 「复制为 INSERT / Markdown」对 JSON 列输出 `[object Object]`（mysql2/sqlstring 同族值编码坑，Webview 与 Host 双侧生成器收口为 JSON 文本 + 引号转义）
- ER PNG 导出被 webview CSP 拦截（`blob:` 不在 img-src 白名单，改 data: URL 内联，AGENTS P-67）

### 已知限制

- SQL INSERT 导出为 MySQL 方言（反引号 + 单引号转义），跨方言（PostgreSQL / SQL Server）回灌需先转换；二进制列以 base64 文本字面量写入
- Console 结果导出不提供 INSERT（结果可能来自任意 JOIN，无单一目标表；请在表格视图使用）
- `cell.fetch` 按需拉取当前仅内置基准驱动声明（`capabilities.lazyCell`）；真实驱动的行内值本就完整、查看器直接使用，后续驱动接入大字段截断时契约组自动生效
- ER 导出不含悬停 / 搜索等视图态（全图全透明度）；PNG 尺寸 = 布局尺寸 2x

## [0.5.0] - 2026-10-24

新增 AI 辅助（BYOK）与设置中心（M9-AI / ADR D-24）。

### 特性

- **AI 辅助三能力**（就地嵌入，不自建聊天面板）：
  - **自然语言生成 SQL**：编辑器 CodeLens「✨ 生成 SQL」（与「▶ 执行」同排，空行光标跟随）/ 快捷键 `Alt+\` → QuickPick 输入自然语言（单库 >50 表先圈选上下文）→ 结果直插编辑器并选中新文本；插入后通知附「放弃这次修改」一键还原
  - **SQL 解释**：编辑器右键（选区优先）→ Console 结果面板「AI 解释」Tab 流式 Markdown；错误态可重试
  - **错误修复建议**：执行失败的语句行 CodeLens「✨ 修复建议」或消息 Tab 错误项按钮 → 编辑器内联 diff 预览（建议 SQL 真实插入原语句之后：原语句红底删除线 + 建议绿底多行对照）→ 行首「✓ 保留更改 / ✕ 放弃」确认——AI 产物绝不直接执行，危险语句拦截 / 生产库确认 / 只读拦截照常生效
- **BYOK provider**：OpenAI 兼容 chat completions（DeepSeek / Moonshot / ollama / 企业网关均可），流式 SSE 解析零新依赖；支持思考过程通道（reasoning_content）
- **设置中心**：AI 设置升级为分类侧栏总设置面板（AI 辅助 / 查询与导出 / 关于）——查询与导出分类代理编辑插件常用 VSCode 设置（即改即存、双向同步，key 白名单 fail-closed）；关于页聚合版本与日志 / 仓库 / Issue / 官网入口
- **AI 上下文与隐私**：默认只发当前库表结构（表 / 列 / 类型 / 注释）、不发数据行；prompt 组装收口纯函数（单测断言密钥 / 密码 / 连接串不入 prompt）；AI 调用全链路日志（脱敏口径）

### 已知限制（AI 辅助）

- 需自备 OpenAI 兼容服务（不内置任何默认 endpoint，API 密钥只存系统密钥链、不回显明文）
- 仅支持 SQL 数据源（MongoDB / Redis 命令控制台不适用）；修复建议仅对编辑器执行的错误生效（结果面板重跑 / 历史重跑无文档来源）
- 修复建议预览期间文档处于「已修改」态（放弃即还原）；解释 Tab 不展示模型思考过程
- 大数 / 时区等既有驱动限制不受 AI 影响（见 0.4.0 各驱动已知限制）

## [0.4.0] - 2026-10-18

新增 Oracle Database 驱动——支持矩阵扩展为七类外部数据源（M8-Oracle / ADR D-23）。

### 特性

- **Oracle 驱动**（`oracledb` thin 纯 JS 内核，无需 Oracle Instant Client，要求数据库 12.1+）：连接绑定单个 PDB（服务名寻址 + SYSDBA 角色可选，树上「库」= schema）；表格编辑（短事务 + 字段级乐观锁 + `RETURNING` 主键回填，NUMBER 全精度保真）；SQL Console（方言全量补全、plsql 格式化、危险语句拦截）；表结构编辑器全 Tab（IDENTITY 自增、`COMMENT ON` 注释、键 / 外键 / 索引）；库级 DDL（建 / 删 schema = `CREATE` / `DROP USER`，预览与日志对密码掩码）；ER 图；真实服务端取消（`connection.break()`，取消后连接可复用）；交互式事务
- **Oracle 契约 CI**：增 `gvenzl/oracle-free` 独立 job（GB 级镜像与主 job 磁盘隔离）——契约十二组在本地常驻 19c 实例实跑全绿 + CI 23ai 实跑（`ORACLE_*` 门控，双版本行为矩阵）
- **变更预览参数回填扩展**：`$N`（PostgreSQL）/ `:N`（Oracle）/ `@pN`（SQL Server）按编号回填实际值，字符串字面量内不替换——此前 PG / SQL Server 的提交预览只显示裸占位符

### 修复

- **空表格点「新增行」白屏（全部驱动）**——新增行聚焦索引差一，空表算出 -1 后取不存在的行抛渲染异常整树卸载；非空表此前误聚焦最后一条数据行，一并修正
- **Oracle Console DML 不生效**——Oracle 隐式事务 + 池化逐语句执行下，INSERT / UPDATE 悬挂在未决事务（下一条查询换连接即不可见）；Console 改自动提交，手动事务走交互式事务入口（专用连接 + 显式 COMMIT）
- 连接表单 Oracle 卡片图标回落 emoji（别名映射漏项；树图标正常的不对称）

### 已知限制（Oracle）

- 空串即 NULL（引擎语义：空串写入存为 NULL、永远读不回；预览 / 回执有提示）
- Console 结果中超过 2^53 的 NUMBER 精度失真（表格路径经按列取回保真，无此问题）
- DATE / TIMESTAMP 按客户端本地时区解释；`TIMESTAMP WITH TIME ZONE` 渲染为 UTC 墙上时间、原始偏移丢失
- PL/SQL 匿名块含分号会被 Console 语句切分器腰斩（暂不可用，切分器 BEGIN/END 感知列为待修）
- 同形外键禁止重复（引擎约束 ORA-02275，设计器给出明确报错）；IDENTITY 自增不可原地增删（提示需重建表）
- 暂不支持 TCPS / SSL 加密与 Oracle Wallet 认证；物化视图不入树

## [0.3.0] - 2026-10-16

表结构编辑器 Tab 化 + ER 图查看 + 官网在线演示。

### 特性

- **表结构编辑器 Tab 化**：列 / 键 / 外键 / 索引四个 Tab 可视化编辑（M8 表设计器批次 A/B）——TableSpec 扩展 uniqueKeys / foreignKeys / indexes，基线回读防误删（键/索引的 DROP 语句先于删列生成，P-57）、五驱动 DDL 生成器 + `capabilities.tableDesign` 能力裁剪；列 Tab 类型建议下拉（五驱动方言词表）与字段级错误归属提示；外键引用表 / 引用列统一为主题化清单控件（聚焦弹出、键入过滤、Enter 回填）
- **ER 图查看（D-22）**：树上库节点打开库级关系图——关系收集只消费 listObjects / listColumns / listKeys 自省，core 简化 Sugiyama 分层布局（最长路径分层 + 重心排序 + DFS 打环，纯函数）；支持复合外键与自引用（分类树 / 汇报线），节点双击直接打开表格视图；表 300 上限超出走选表引导
- **官网在线 Playground**：官网首页 Hero 内嵌可交互演示——浏览器内运行插件真实界面 + 内置 Mock 驱动（无需安装、不连任何数据库），表格编辑（乐观锁 / SQL 预览提交）、SQL Console（真实执行 + 危险语句横幅）、ER 图、表结构设计四类面板可玩
- **mock 驱动新增 shop 电商示例库**：8 表 9 关系（自引用 ×2 / 多对多 junction / 复合外键），ER 能力的演示数据

### 修复

- **PostgreSQL：树上索引列集恒错（存量 bug）**——`listKeys` 的 `ARRAY(SELECT attname …)` 产出 `name[]` 无 builtin 解析器（回原始字符串直接崩）、`pg_get_indexdef` 列号 off-by-one（单列索引回空串）；改 `::text[]` + `WITH ORDINALITY` 保列序、传正确列号（P-59，CI 契约实跑抓到）
- **标识符校验误拒真实合法名**——白名单改危险字符黑名单：连字符 / 点 / 空格 / 中文等放行（`test-api` 类库名此前报「含非法字符」，而库里真实存在），方言引号字符 + 控制字符仍 fail-closed；MySQL charset / collate 关键字插值保持严格白名单（P-58）
- **契约套件（mysql / pg / mssql CI 实跑修正）**：增删唯一键 / 索引场景改复合列，避开 InnoDB 把同列新索引选作外键支撑索引导致的 DROP 失败（P-59）；新增契约组后各组断言计数同步（7→13）

## [0.2.1] - 2026-10-11

SQL Server 驱动缺陷修复（v0.2.0 发布后由 CI 契约实跑抓到，P-53 同族）。

### 修复

- **SQL Server：二进制列的 NULL 绑定报「Implicit conversion from data type nvarchar to varbinary(max) is not allowed」**——mssql 对 null 参数自动推断为 NVarChar 类型，而 nvarchar→varbinary 无隐式转换（T-SQL 转换表 CONVERT-only）。影响含 varbinary 列的表格新增行（该列留空）、清空二进制单元格、值编码契约的全 NULL 行写回。修复：binary 列的 NULL 经 `TypedNullParam` 显式 VarBinary 绑定
- **SQL Server：uniqueidentifier 读回大写**——tedious 默认经 `bufferToUpperCaseGuid` 返回大写，与写入惯例不一致；连接选项 `lowerCaseGuids: true` 源头小写（往返保真）
- **SQL Server：DECIMAL 读回为 number 形态**——tedious 对 Decimal 经 JS Number 运算返回，§5 要求 decimal 列为字符串形态；驱动读侧补 number → 字符串整形（超过 2^53 精度的值在客户端层已失真，见已知限制）
- **SQL Server：无别名表达式查询结果为空**——TDS 协议的 `SELECT COUNT(*)`/`GETDATE()` 等无别名表达式列名为空串，结果集列提取误按列名过滤导致空结果；空列名占位兜底（Console 跑 `SELECT GETDATE()` 即触发）
- **契约套件：混入 insert 跳过自增主键列**——SQL Server IDENTITY 禁止显式值（`Cannot insert explicit value for identity column`），变更集组「update 冲突/混合原子性」两项检查的全列 insert 构造对其必炸（MySQL/PG/mock 容忍显式自增值，故仅 mssql 暴露）；套件改为「插入缺省自增列」的通用口径（driver-conformance）
- **契约 fixture（SQL Server）**：① 种子 `input('avatar', null)` 裸 null 绑定改三参显式 `mssql.VarBinary`（CI 实跑首触发点）；② fixture 库开 `READ_COMMITTED_SNAPSHOT`（Azure SQL DB 默认行为）——SQL Server 默认锁式 READ COMMITTED 下，交互式事务组的「未提交不可见」检查会因 X 锁阻塞互等死锁
- **发布流水线补 mssql 契约 service**：release.yml 此前缺 `mssql/server:2022-latest` service，v0.2.0 的发布门禁里 mssql 契约被整组 skip（假绿通过）——现与 ci.yml 同款（service + sqlcmd 就绪步骤 + env），发布 Must 口径不再有契约缺考
- **已知限制补充（SQL Server）**：tedious 对 DECIMAL/NUMERIC 经 JS Number 返回，有效位超过 2^53 的精度在客户端层失真、无法恢复（常规精度不受影响）——README「已知限制」声明

## [0.2.0] - 2026-10-11

新增 Microsoft SQL Server 驱动——支持矩阵扩展为六类外部数据源（M8-MSSQL / ADR D-21）。

### 特性

- **SQL Server 驱动**（`mssql`/tedious 纯 JS 内核，无原生依赖）：资源树浏览（树上「库」= schema，D-15 同构）、表格编辑（字段级乐观锁 + 单事务提交 + `OUTPUT INSERTED` 主键回填）、T-SQL Console（方言全量补全、危险拦截、格式化）、表结构编辑器（建/改表/列、MS_Description 注释）、库级 DDL（建/删 schema）、SSL 加密、语句取消（TDS ATTENTION）、交互式事务
- **SQL Server 契约 CI**：CI 增 `mcr.microsoft.com/mssql/server:2022-latest` service，契约十组（连接/元数据/分页/筛选下推/变更集/取消/值编码/DDL/库级 DDL/交互式事务）CI 实跑（`MSSQL_HOST` 门控，同 mysql/pg 口径）

### 已知限制（SQL Server）

- SSMS 风格 `GO` 批分隔符不支持（Console 按 `;` 切分单语句执行）
- 带启用触发器的表不支持表格新增行（`OUTPUT` 子句的 T-SQL 约束；更新/删除不受影响）
- IDENTITY 自增不可原地增删（结构编辑器提示需重建表）；认证仅支持 SQL Server 登录（无 Windows 集成/Entra 认证）

## [0.1.1] - 2026-10-10

展示与文档优化（无功能变更）。

### 变更

- **Marketplace 详情页全面改版**：价值主张 hero + 界面截图（总览 / Console / 表结构 / 库级操作 / 后台导出）+ 按用户价值组织的亮点说明 + 紧凑支持矩阵；实现细节与已知限制长文移至仓库文档
- 详情页横幅配色（galleryBanner）与图标渐变对齐
- 扩展图标更换为矢量渲染版（0.1.0 上架素材的形变修正）

[0.3.0]: https://github.com/Fengjing95/vsc-plugin-db/releases/tag/v0.3.0
[0.2.0]: https://github.com/Fengjing95/vsc-plugin-db/releases/tag/v0.2.0
[0.1.1]: https://github.com/Fengjing95/vsc-plugin-db/releases/tag/v0.1.1

## [0.1.0] - 2026-10-10

首次发布（GitHub Release + VSIX 分发）。

### 特性

- **六驱动矩阵**：MySQL、PostgreSQL（schema 映射 database 层，D-15）、Redis（SCAN 分页 + 命令控制台）、SQLite（sql.js WASM 单引擎 + 写批次原子落盘，限中小库 ≤100MB，D-16）、MongoDB（树浏览 + 文档编辑 + mongosh 命令控制台，D-17/D-18）、内置 Mock（演示与契约绿基线）
- **连接管理**：动态连接表单（每驱动自定义字段、SSL、SSH 隧道 + TOFU 指纹）、SecretStorage 密钥存储（密码永不落盘/入日志）、测试连接、只读与生产库护栏
- **元数据树**：库/表/视图/列/键/索引懒加载 + 缓存失效、查看 DDL、由表结构生成代码（TS/Java/Go/Prisma）、库级 DDL（D-19：MySQL 建/改/删库，PG 建/删 schema，Mongo 建/删库）
- **表格视图**：虚拟滚动、筛选/排序/搜索服务端下推（参数化）、列显隐投影、分页、单元格编辑（ChangeSet + 字段级乐观锁 + 单事务提交、冲突定位错误行）、NULL↔空串切换、无主键表默认只读（D-03 可开关）
- **SQL Console**：上下文补全（方言全量词表 + 库/表/列元数据）、执行历史、危险语句拦截（无 WHERE UPDATE/DELETE fail-closed、生产库逐条确认）、EXPLAIN 树形缩进（D-13）、行内执行结果注记（耗时/错误/取消）、CodeLens 逐语句执行、交互式事务（空闲超时自动回滚，D-09）
- **导出**：CSV / JSON / XLSX（exceljs 流式写），后台任务化（即时回执、通知中心进度、可取消、多任务并发）
- **表结构编辑器**（M8-B2）：建表/改表结构（加列/改列/主键/注释，驱动方言生成）、SQL 预览与变更统计
- **操作日志**：LogOutputChannel 分级打点 + 查询全链路统一拦截日志（凭证脱敏）

### 已知限制

- UI 文案仅中文（i18n / `vscode.l10n` 未落地，D-11 顺延）
- e2e（@vscode/test-electron）未建——行为面由驱动契约测试套件（mock 恒跑 + redis/pg/mysql CI 实跑）与四道门禁覆盖
- `perf/` 基准脚本未建（mock 侧 dod.perf 在门禁内；性能指标在各里程碑 DoD 有实测记录）
- 部分设计配置项未实现（`dbExplorer.drivers` / `edit.cellMaxChars` / `tree.databaseTtlSeconds` / `tree.columnTtlSeconds` / `safety.confirmOnNonProd` / `telemetry.enabled`，对账见概要设计 §13）
- Web 版 VSCode（github.dev）不支持（遗留 #1，P3 前评估）
- AI 辅助未实现（遗留 #3，P2 启动时）

[0.1.0]: https://github.com/Fengjing95/vsc-plugin-db/releases/tag/v0.1.0
