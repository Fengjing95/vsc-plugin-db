# 更新日志

本项目的所有重要变更记录在此文件中。格式参照 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)；版本遵循语义化版本（0.x 为预稳定阶段）。

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
