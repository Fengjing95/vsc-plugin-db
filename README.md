# 数据库浏览器 DB Explorer（VSCode 插件）

在 VSCode 内提供统一的、可插拔的数据库访问入口，覆盖“看结构 → 查数据 → 改数据 → 写 SQL”的完整链路。

**当前状态：M0 骨架 ✅ + M1 连接管理 ✅ + M2 元数据树 ✅ + M3 表格视图-只读 ✅ + M4 表格编辑 ✅**

- M4：ChangeSet 权威副本在 Host（`ChangeSetService`，ADR D-06）+ Webview 覆盖层 300ms debounce 同步；单元格编辑（双击/Enter/F2 进入、Esc 取消、Enter 下移、Tab 右移）、NULL↔空串右键切换、新增行/标记删除、脏黄底+三角/增行绿/删行红/错误行红条视觉；`table.editChanges/previewChanges/applyChanges/revertChanges` RPC + `evt:changeset.updated/row.error` 事件；变更预览 Modal（参数化 SQL 逐条展开、>50 条折叠+虚拟滚动）；MySQL `buildChangeStatements`（WHERE=主键+变更列原值、NULL→`IS NULL`、DELETE 仅主键）+ 单事务 `applyChanges`（`LAST_INSERT_ID()` 回填、affectedRows≠1→E_CONFLICT 整体回滚）；mock 驱动共享物化存储 + 内存版编辑（冲突可两视图构造）；契约测试“变更集”组（insert 回填主键 / 冲突无半提交 / 混合原子性 / NULL 原值 IS NULL）；无主键表 D-03（默认只读，`dbExplorer.edit.allowNoPrimaryKey` 开全列匹配，含二进制列仍禁）；prod DangerGuard 输入表名确认；握手回放快照（编辑+视图状态，强杀可恢复）；M4 DoD：100 条变更提交 638ms（<2s）。
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

运行后：活动栏“数据库”图标 → 视图标题栏 ＋ 新建连接（内置 Mock 数据源可直接体验）→ 展开连接 → `表` → 单击表名打开表格视图。表格页支持：列头点击排序（下推）、筛选构造器（列/操作符/类型化值）、全局搜索（防抖下推）、列设置（显隐即服务端投影）、列宽拖拽、分页栏（每页 50/100/200/500）、导出 CSV/JSON（当前页/全部结果，带进度与取消）。**M4 编辑**：双击/Enter/F2 编辑单元格、右键 NULL↔空串切换、工具栏 ＋新增行 / 提交变更(N) / 撤销；提交前弹参数化 SQL 预览，单事务提交、冲突自动回滚并定位错误行。`big` 库 t001~t100 每表 5 万行、`demo.wide` 为 1000 行×20 列，可用于滚动/翻页性能体验；Mock 双视图同时打开同一表可演示乐观锁冲突（一方提交后另一方触发 E_CONFLICT）。

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

M0 骨架 ✅ → M1 连接管理 ✅ → M2 元数据树 ✅ → M3 表格视图-只读 ✅ → **M4 表格编辑 ✅** → M5 SQL Console（下一步）→ M6 Redis 驱动（验证可插拔）→ M7 增强。规划与 DoD 见[概要设计 第 10 章](docs/概要设计.md)。

### M4 交接备忘（2026-09-30 完成）

交付对齐概要设计 §10 DoD：契约测试“变更集”组通过（insert 回填主键 / update 冲突 → E_CONFLICT 且无半提交 / 混合原子性 / NULL 原值 IS NULL 匹配）；冲突场景提示 E_CONFLICT 文案 + “刷新并放弃 / 保留我的修改”（重取→校验变更列→基于新基线重新预览，不静默覆写）；Webview 强杀后经 `sys.handshake` 回放 ChangeSet + 视图状态（筛选/排序/分页/搜索）；提交 100 条变更 638ms（DoD <2s，`dod.perf.test.ts`）。

**与设计稿的有意偏差（评审追踪项）**：
- prod“输入表名确认”集中在 Host 层 `EditGuard.confirmApply`（概要 §5.8 单一护栏服务），预览 Modal 只显示红条提示，不在 Modal 内重复输入框
- 预览 Modal 的 UPDATE 摘要行显示 SQL（PreviewItem 契约未携带结构化旧值→新值，扩展该契约放 M7 一并评估）
- “保留我的修改”在变更列也被他人修改时提示无法自动保留（交互稿 §9.2 的逐列选择保留方 UI 简化为提示 + 刷新并放弃）
- `EditGuard` 编辑权限按 connId/db/obj 进程级缓存，改驱动配置/表结构后需重开表格视图生效

**M4 评审反馈修复（2026-09-30）**：单元格编辑失焦即确认（原仅 Enter 记录导致“编辑后无法提交”的假象）；行选择（行首点击/拖拽/Shift 范围）+ 工具栏「删除选中行 (N)」显式删除入口（原仅右键菜单不可见）；树目录节点（表/视图/列/键/索引）显示纯数字统计、表节点移除 `~N 行` 估算（交互稿 v0.1.2 同步修订）。

**Redis 语义预演（M4 开工清单 #7，结论）**：`applyChanges` 的 PreviewItem/ApplyResult 形状与驱动规范 §8-5“逐条顺序执行 + 失败即停、items 如实汇报部分成功”语义，对 Redis Hash/List/Set/ZSet 的 SET/HSET 映射兼容；RowKey 恒 `['key']`、虚拟列（field/value、`__ttl`）只读由 ChangeSet 生成侧约束——**M6 无需改动编辑接口**。

### M6 前置债（Redis 接入前必须处理，M2/M3 的已知简化）

- **树层级硬编码**：`packages/extension/src/tree/treeDataProvider.ts` 目前无条件渲染“表/视图 → 列/键/索引”目录（MySQL 形状），尚未消费 `capabilities.hierarchy`。M6 前改造为能力感知渲染（概要设计 5.1.3），否则 Redis 连接会错误渲染出表/视图层级
- **cursor 分页链路**：core 契约已有 `FetchRowsRequest.cursor` / `ResultSet.nextCursor`，但 `packages/protocol/src/methods.ts` 的 `FetchRowsParamsSchema` 尚无 cursor 字段——接 Redis SCAN（禁止 KEYS，驱动规范 §5.3）前补齐
- **类型化展示验证**：key 类型图标、按前缀分组的 Keys 目录、`__ttl` 虚拟列——M6 交付物，以真实 Redis 验证收口

纪律：四道门禁（typecheck/test/lint/build）全绿再提交；陷阱备忘见 `packages/extension/src/views/webviewHtmlInject.ts` 头注释（Webview CSP nonce）。
