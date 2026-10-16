# 更新日志

本项目的所有重要变更记录在此文件中。格式参照 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)；版本遵循语义化版本（0.x 为预稳定阶段）。

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
