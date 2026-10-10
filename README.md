# 数据库浏览器 DB Explorer（VSCode 插件）

在 VSCode 内提供统一的、可插拔的数据库访问入口，覆盖「看结构 → 查数据 → 改数据 → 写 SQL」的完整链路。支持 MySQL、PostgreSQL、SQLite、MongoDB、Redis 五类外部数据源 + 内置 Mock 演示源，单文件 VSIX 分发、零原生依赖。

## 功能总览

| 能力 | MySQL | PostgreSQL | SQLite | MongoDB | Redis | Mock（内置） |
|---|---|---|---|---|---|---|
| 资源树 | 库/表/视图/列/键/索引 | schema/表/视图/列/键/索引 | 单库/表/列 | 库/collection/字段目录 | Key 类型目录/键 | 演示库 |
| 数据浏览（筛选/排序/搜索下推 + 分页） | ✓ | ✓ | ✓ | ✓ | ✓ 类型化展示 | ✓ |
| 表格编辑（ChangeSet + 乐观锁 + 事务提交） | ✓ | ✓ | ✓ | ✓ 文档编辑 | —（只读） | ✓ |
| SQL Console（补全/历史/危险拦截） | ✓ | ✓ | ✓ | mongosh 命令控制台 | 命令控制台 | ✓ |
| 交互式事务（空闲超时回滚） | ✓ | ✓ | ✓ | — | — | ✓ |
| 表结构编辑器（建/改表、列） | ✓ | ✓ | ✓ | — | — | ✓ |
| 库级 DDL（新建/编辑/删除库） | ✓ | ✓ 建/删 schema | —（单库） | ✓ 建/删库 | —（库数固定） | — |
| SSL / SSH 隧道（TOFU 指纹） | ✓ | ✓ | — | ✓ | ✓ / TLS | — |
| 导出（CSV/JSON/XLSX，后台任务可取消） | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| 契约测试（CI 实跑） | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ 恒跑 |

其他能力：查看 DDL、由表结构生成代码（TS/Java/Go/Prisma）、复制为多种格式、SQL 格式化、保存查询与树内查询目录、EXPLAIN 树形缩进、行内执行结果注记、CodeLens 逐语句执行、操作日志（`dbExplorer.showLog`）。

## 安装

**VSIX（推荐，GitHub Release）**：从 [Releases](https://github.com/Fengjing95/vsc-plugin-db/releases) 下载 `db-explorer-0.1.0.vsix` → VSCode 扩展视图右上角「…」→ **Install from VSIX…**；或命令行：

```bash
code --install-extension db-explorer-0.1.0.vsix
```

**从源码运行（开发）**：见下文[开发](#开发)一节。

## 快速上手

1. 活动栏「数据库」图标 → 视图标题栏 **＋ 新建连接**（内置 Mock 数据源可直接体验，无需任何实例：`big` 库 t001~t100 每表 5 万行、`demo.wide` 1000 行×20 列）；
2. 展开连接 → 库 → `表` → 单击表名打开表格视图（列头排序、筛选构造器、全局搜索、列显隐、分页均为服务端下推）；
3. 编辑：双击/`Enter`/`F2` 编辑单元格 → 工具栏「提交变更(N)」→ 参数化 SQL 预览 → 单事务提交，冲突定位错误行；NULL↔空串右键切换；
4. 写 SQL：树查询目录「新增查询」或任意 `.sql` 文件 → `Ctrl+Enter` 执行（`Ctrl+Shift+Enter` 全部），结果面板多结果集 Tab + EXPLAIN 树形缩进；无 WHERE 的 UPDATE/DELETE 与生产库危险操作有分级确认护栏；
5. 导出：表格工具栏「导出」→ 选格式与范围 → 后台执行（通知中心进度、可取消、多任务并发）。

## 已知限制（0.1.0）

- UI 文案仅中文（i18n 未落地）
- Web 版 VSCode（github.dev）不支持；桌面版（`^1.85`）限定
- SQLite 驱动限中小库（建议 ≤ 100MB，整库内存 + 写批次原子落盘）；同步执行不可取消
- MongoDB 编辑为字段级 `$set` 乐观锁、逐条失败即停（无事务语义）；结构类 mongosh 命令（建索引/改集合等）不支持
- Redis 为只读浏览 + 命令控制台（无可回滚事务，未开编辑）
- 导出格式为 CSV/JSON/XLSX（NDJSON/Markdown/SQL INSERT 为后续批次）；e2e 与独立 perf 基准未建（契约套件 + 四道门禁覆盖）
- 无遥测；密码只存 VSCode SecretStorage，不落盘、不入日志

完整口径见 [概要设计 §14 遗留问题](docs/概要设计.md) 与 [CHANGELOG.md](CHANGELOG.md)。

## 文档（docs/）

| 文档 | 说明 |
|---|---|
| [AGENTS.md](AGENTS.md) | **Agent/新成员必读**：工程约束（门禁/协议/安全）与踩坑解法库 |
| [概要设计](docs/概要设计.md) | 产品边界、架构、模块详设、ADR 决策记录（D-01~D-20） |
| [驱动开发规范](docs/驱动开发规范.md) | `IDatabaseDriver` 契约全集、错误码、值编码、加载机制 |
| [交互设计稿](docs/交互设计稿.md) | 各界面线框、状态机、键盘与文案规范 |
| [技术选型](docs/技术选型.md) | T-01~T-14 候选对比与决策 |
| [评审记录](docs/评审记录-2026-09-29.md) | 设计评审结论与 16 项修订处置 |

## 开发

```bash
pnpm install        # 安装依赖
pnpm build          # 构建 webview-ui + extension（产物含 webview 拷贝与 external 依赖物化）
pnpm test           # vitest（含驱动契约与 DoD perf；redis/pg/mongo/mysql 契约经环境变量门控，本地无实例自动 skip）
pnpm lint           # ESLint
pnpm typecheck      # TS 全仓类型检查

# 调试运行：用 VSCode 打开本仓库根目录，按 F5
# （启动 Extension Development Host，活动栏出现数据库图标）

# 打包 VSIX（发布口径：--no-dependencies + external 闭包随包，见 esbuild.mjs）
pnpm --filter db-explorer exec vsce package --no-dependencies
```

### 工程结构

```
packages/
├── core/                 # 驱动接口契约、统一模型、DriverRegistry、DriverHost、危险判定/语句切分
├── protocol/             # Webview ↔ Host RPC 消息定义（zod 单一来源）
├── extension/            # VSCode 插件主体（树/命令/连接管理/表单与表格 Webview 宿主/导出/日志）
├── webview-ui/           # React + Vite + Tailwind v4 + shadcn/ui（表格/表单/Console/表结构/库设计页）
├── driver-mock/          # 内置演示驱动（内存：5 万行 big 库 + 1000×20 宽表，契约绿基线）
├── driver-mysql/         # MySQL 驱动（mysql2）
├── driver-postgres/      # PostgreSQL 驱动（pg，D-15 schema 上树）
├── driver-redis/         # Redis 驱动（node-redis，SCAN 游标分页 + 命令控制台）
├── driver-sqlite/        # SQLite 驱动（sql.js WASM 单引擎，D-16）
├── driver-mongo/         # MongoDB 驱动（官方 mongodb，D-17/D-18）
└── driver-conformance/   # 驱动契约测试套件（connection/metadata/pagination/pushdown/changeset/
                           #  cursor/scan/值编码/取消/交互事务/DDL/库级 DDL）
```

### 关键决策（摘）

- 驱动可插拔三级接入（内置 / 配置扩展 / 扩展点），新增驱动核心零改动
- ChangeSet 权威副本在 Extension Host，Webview 崩溃可恢复
- 全部驱动调用经 `DriverHost` 中转（统一超时/取消/日志），进程隔离预案就绪（D-05 多轮复核维持进程内）
- 筛选/排序必须在 SQL 层下推（参数化），禁止取全表内存过滤；默认不执行全表 `COUNT(*)`
- 密码只存 SecretStorage；错误码统一（`DriverErrorCode`），UI 只认码不解析文本
- 详见 [概要设计 第 11 章 ADR](docs/概要设计.md)（D-01~D-20）

## License

[Apache-2.0](LICENSE)
