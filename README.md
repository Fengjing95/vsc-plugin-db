# 数据库浏览器 DB Explorer（VSCode 插件）

在 VSCode 内提供统一的、可插拔的数据库访问入口，覆盖“看结构 → 查数据 → 改数据 → 写 SQL”的完整链路。

**当前状态：M0 骨架 ✅ + M1 连接管理 ✅ + M2 元数据树 ✅ + M3 表格视图-只读 ✅**

- M3：Tailwind v4 + shadcn/ui（Base UI 基座，`--vscode-*` 变量映射层）、TanStack Table + Virtual 虚拟滚动、筛选/排序/搜索服务端下推（`table.fetchRows` 扩展 filters/sorts/search/columns）、行式筛选构造器、分页栏（`totalCount` 缺省显示“约 N 行”，交互稿 §4.7）、列显示/隐藏（服务端投影）、`export.run/export.cancel`（Host 流式写 CSV/JSON，withProgress 可取消）、契约测试“分页/筛选下推”组、DoD 基准测试（1000 行×20 列取数毫秒级，5 万行分页吞吐）。
- M2：元数据层次缓存（TTL/并发去重/子树失效）、树五级展开（列/键/索引）、右键菜单（查看 DDL / 复制名称 / 生成 SELECT / 子树刷新）、MySQL + Mock 双驱动 DDL。
- M1：连接持久化（globalState）+ SecretStorage 密钥 + 动态连接表单（测试连接）。
- M0：monorepo + 驱动契约 + DriverRegistry + RPC handshake。

## 文档（docs/）

| 文档 | 说明 |
|---|---|
| [AGENTS.md](AGENTS.md) | **Agent/新成员必读**：工程约束（门禁/协议/安全）与踩坑解法库 |
| [概要设计](docs/概要设计.md) | 产品边界、架构、模块详设、ADR 决策记录（v0.2.1，评审通过） |
| [驱动开发规范](docs/驱动开发规范.md) | `IDatabaseDriver` 契约全集、错误码、值编码、加载机制 |
| [交互设计稿](docs/交互设计稿.md) | 各界面线框、状态机、键盘与文案规范 |
| [技术选型](docs/技术选型.md) | T-01~T-14 候选对比与决策（2026-09-29 全部确认） |
| [评审记录](docs/评审记录-2026-09-29.md) | 设计评审结论与 16 项修订处置 |

## 快速开始

```bash
pnpm install        # 安装依赖
pnpm build          # 构建 webview-ui + extension
pnpm test           # 运行单元测试（vitest）
pnpm lint           # ESLint

# 调试运行：用 VSCode 打开本仓库根目录，按 F5
# （启动 Extension Development Host，活动栏出现数据库图标）
```

运行后：活动栏“数据库”图标 → 视图标题栏 ＋ 新建连接（内置 Mock 数据源可直接体验）→ 展开连接 → `表` → 单击表名打开表格视图。表格页支持：列头点击排序（下推）、筛选构造器（列/操作符/类型化值）、全局搜索（防抖下推）、列设置（显隐即服务端投影）、列宽拖拽、分页栏（每页 50/100/200/500）、导出 CSV/JSON（当前页/全部结果，带进度与取消）。`big` 库 t001~t100 每表 5 万行、`demo.wide` 为 1000 行×20 列，可用于滚动/翻页性能体验。

## 工程结构

```
packages/
├── core/                 # 驱动接口契约、统一模型、DriverRegistry、DriverHost
├── protocol/             # Webview ↔ Host RPC 消息定义（zod 单一来源）
├── extension/            # VSCode 插件主体（树/命令/连接管理/表单与表格 Webview 宿主/导出服务）
├── webview-ui/           # React + Vite + Tailwind v4 + shadcn/ui（表格视图 + 连接表单）
├── driver-mock/          # 演示驱动（内存数据源：含 5 万行 big 库与 1000×20 宽表）
├── driver-mysql/         # MySQL 驱动（mysql2，M1）
└── driver-conformance/   # 驱动契约测试套件（connection/metadata/pagination/filter-pushdown）
```

## 关键决策（摘）

- 驱动可插拔三级接入（内置 / 配置扩展 / 扩展点），新增驱动核心零改动
- ChangeSet 权威副本在 Extension Host，Webview 崩溃可恢复（M4 接入）
- 全部驱动调用经 `DriverHost` 中转，强制超时 + AbortSignal，进程隔离预案就绪
- 筛选/排序必须在 SQL 层下推（参数化），禁止取全表内存过滤；`COUNT(*)` 默认不执行
- 错误码统一（`DriverErrorCode`），UI 只认码不解析文本
- 详见 [概要设计 第 11 章 ADR](docs/概要设计.md)

## 里程碑

M0 骨架 ✅ → M1 连接管理 ✅ → M2 元数据树 ✅ → M3 表格视图-只读 ✅（代码完成，待人工验证 UI）→ **M4 表格编辑（下一步）** → M5 SQL Console → M6 Redis 驱动（验证可插拔）→ M7 增强。规划与 DoD 见[概要设计 第 10 章](docs/概要设计.md)。

### M4 开工清单（交接备忘）

1. ChangeSet 权威副本在 Host（`ChangeSetService`），Webview 编辑视图 300ms debounce 同步
2. 单元格编辑状态机（交互稿 §4.1）：dirty 态工具栏高亮、NULL/空串切换、错误行定位
3. `previewChanges`/`applyChanges` RPC + 变更预览 Modal（概要 §5.4.3，预览即执行）
4. 驱动侧：MySQL `applyChanges`（主键+变更列原值乐观锁、`IS NULL` 匹配、事务回滚）
5. 契约测试“变更集”组（insert 回填主键、冲突 → E_CONFLICT、混合原子性）
6. Webview 崩溃恢复（sys.handshake 回放快照，概要 §5.4.5）

纪律：四道门禁（typecheck/test/lint/build）全绿再提交；陷阱备忘见 `packages/extension/src/views/webviewHtmlInject.ts` 头注释（Webview CSP nonce）。
