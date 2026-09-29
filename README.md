# 数据库浏览器 DB Explorer（VSCode 插件）

在 VSCode 内提供统一的、可插拔的数据库访问入口，覆盖“看结构 → 查数据 → 改数据 → 写 SQL”的完整链路。

**当前状态：M0 骨架 ✅ + M1 连接管理 ✅ + M2 元数据树 ✅** —— 元数据层次缓存（TTL/并发去重/子树失效）、树五级展开（列/键/索引）、右键菜单（查看 DDL / 复制名称 / 生成 SELECT / 子树刷新）、MySQL + Mock 双驱动 DDL；M1：连接持久化（globalState）+ SecretStorage 密钥 + 动态连接表单（测试连接）；M0：monorepo + 驱动契约 + DriverRegistry + RPC handshake。

## 文档（docs/）

| 文档 | 说明 |
|---|---|
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

运行后：活动栏“数据库”图标 → 视图标题栏 ＋ 新建连接（按驱动 FormSchema 动态渲染表单，支持测试连接；密码存 SecretStorage）→ 展开连接 → `表` → 单击表名打开表格视图（演示完整 RPC 链路：Webview ↔ Host ↔ 驱动）。

## 工程结构

```
packages/
├── core/                 # 驱动接口契约、统一模型、DriverRegistry、DriverHost
├── protocol/             # Webview ↔ Host RPC 消息定义（zod 单一来源）
├── extension/            # VSCode 插件主体（树/命令/连接管理/表单与表格 Webview 宿主）
├── webview-ui/           # React + Vite（表格视图 + 连接表单；M3 起引入 TanStack Table + shadcn/ui）
├── driver-mock/          # M0 演示驱动（验证可插拔：核心 0 改动接入）
├── driver-mysql/         # MySQL 驱动（mysql2，M1）
└── driver-conformance/   # 驱动契约测试套件（随里程碑扩充）
```

## 关键决策（摘）

- 驱动可插拔三级接入（内置 / 配置扩展 / 扩展点），新增驱动核心零改动
- ChangeSet 权威副本在 Extension Host，Webview 崩溃可恢复
- 全部驱动调用经 `DriverHost` 中转，强制超时 + AbortSignal，进程隔离预案就绪
- 错误码统一（`DriverErrorCode`），UI 只认码不解析文本
- 详见 [概要设计 第 11 章 ADR](docs/概要设计.md)

## 里程碑

M0 骨架 ✅ → M1 连接管理 ✅ → M2 元数据树 ✅（均已人工验证）→ **M3 表格视图-只读（下一步）** → M4 表格编辑 → M5 SQL Console → M6 Redis 驱动（验证可插拔）→ M7 增强。规划与 DoD 见[概要设计 第 10 章](docs/概要设计.md)。

### M3 开工清单（交接备忘）

1. webview-ui 接入 Tailwind v4 + shadcn/ui（技术选型 T-07），建立 `--vscode-*` 变量映射层
2. 表格页重构：TanStack Table + TanStack Virtual 虚拟滚动（T-06），渲染行式 ResultSet
3. RPC 扩充：`table.fetchRows` 增加 filters/sorts/search（core 的 `FetchRowsRequest` 已支持，protocol schema 待扩展），Host 侧经 `DriverHost` 下推
4. 分页栏（totalCount 缺省细则见交互稿 §4.7）、列排序、筛选构造器（交互稿 §4.4）、全局搜索、列显示/隐藏
5. 导出 CSV/JSON：`ResultExporter`（概要 §5.7，Host 流式写 + withProgress + 可取消）
6. 契约测试：driver-conformance 增加"分页/筛选下推"组

纪律：四道门禁（typecheck/test/lint/build）全绿再提交；陷阱备忘见 `packages/extension/src/views/webviewHtmlInject.ts` 头注释（Webview CSP nonce）。
