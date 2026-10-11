# 更新日志

本项目的所有重要变更记录在此文件中。格式参照 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)；版本遵循语义化版本（0.x 为预稳定阶段）。

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
