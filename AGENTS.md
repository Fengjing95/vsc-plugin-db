# AGENTS.md — Agent 开发约束与踩坑库

> 目的：供 AI agent（及新成员）在本仓库工作时直接引用，避免重踩已知坑。
> 定位：docs/ 是**设计**的单一事实源；本文件是**工程执行层**的约束与实战经验。
> 二者冲突时以 docs/ 为准。
> 维护规则：新踩到坑或新增约束时，随当次代码改动一并更新本文件并在提交信息提及。

---

## 一、硬性约束（违反即返工）

### 流程纪律
- **C-1 四道门禁**：`pnpm typecheck` / `test` / `lint` / `build` 全绿才允许 `git commit`。
- **C-2 提交信息**：`feat(mN):` / `fix(mN):` / `chore:` / `test:` 前缀 + 中文摘要，风格参照 `git log`。
- **C-3 契约测试先行**：driver-conformance 新增契约组必须先写测试跑红、再补实现（TDD 红绿节奏）。
- **C-4 里程碑边界**：严格按概要设计 §10 的当前里程碑范围工作，范围外功能（如 P2/P3 项）不做。

### 协议与契约
- **C-5 RPC 消息单一来源**：Webview ↔ Host 的全部消息只能定义在 `packages/protocol`（zod schema 双端运行时校验，ADR D-06）。禁止在 extension/webview 各自定义消息形状。
- **C-6 错误码**：只用 `DriverErrorCode`（+ RPC 层 E_UNKNOWN_METHOD/E_STATE_LOST）；UI 不解析错误文本，文案映射在 `webview-ui/src/lib/errors.ts` 按 code 维护（交互稿 §9.2）。
- **C-7 值编码契约**（概要 §4.4 / 驱动规范 §5，全链路含编辑回传）：NULL=`null` 与 `''` 严格区分；DECIMAL/超限整数=字符串；DATETIME=`'YYYY-MM-DD HH:mm:ss.SSS'` 不带时区；binary=base64；JSON=已解析对象。
- **C-8 行定位**：编辑/删除/回填一律用 RowKey（主键值映射），**禁止行号**（翻页后行号失义）。
- **C-9 下推与性能**：筛选/排序必须在驱动 SQL 层下推（参数化），禁止取全表内存过滤；默认不执行全表 `COUNT(*)`；单次传输上限 5000 行 / 5MB。
- **C-10 密钥安全**：密码只存 SecretStorage（`dbExplorer.secrets.<connId>`），永不写入 settings/日志/错误/导出文件；SQL 强制参数化，禁止字符串拼接用户值。

### Webview
- **C-11 CSP/nonce**：所有 `<script>` 必须带 nonce；HTML 构建统一走 `packages/extension/src/views/webviewHtmlInject.ts`，禁止绕过自拼 HTML。
- **C-12 颜色零硬编码**：UI 只允许引用 `webview-ui/src/styles/tokens.css` 的语义 token（`--color-*`，映射到 `--vscode-*`，交互稿 §11）。
- **C-13 重活不进 Webview**：导出、大批量数据处理在 Extension Host 执行（概要 §5.7）。

---

## 二、踩坑与解法（技能库）

格式：**症状 → 根因 → 解法**。

### Base UI / shadcn 组件（packages/webview-ui/src/components/ui）
- **P-1 弹层飘到视图左上角** → Base UI 的 `Trigger render={<组件/>}` 依赖 **ref** 测量锚点；React 18 函数组件默认丢弃 ref → 锚点为 null，弹层落 (0,0)。→ `Button`/`Input` 已改 `forwardRef`；**今后所有可能作为 render prop 传入的组件必须 forwardRef**。
- **P-2 弹层被数据网格表头遮盖** → `z-50` 写在 Popup 上无效；真正参与定位/层叠的是外层 **Positioner**（无 z-index），被 sticky 表头（z-30）压制。→ z-index 必须加在 Popover/Menu/Select 的 `Positioner` 上（已加 `z-50`）。
- **P-3 Select 下拉覆盖触发器** → Base UI Select 的 `Positioner` 默认 `alignItemWithTrigger=true`（原生 macOS 式对齐覆盖）。→ 已设 `alignItemWithTrigger={false}` + `align="start"`，固定从下方展开。
- **P-4 下拉选中项看不清** → `text-primary`（按钮蓝）配面板底色对比不足。→ 选中项用 `--vscode-list-activeSelection*` 前景/背景对 + `font-medium`；悬停高亮用 `not-data-[selected]:` 与选中态隔离，避免两状态叠色。

### 布局
- **P-5 数据量少也出现整页滚动条** → 表格页根节点 `h-screen`（100vh）+ 任何 body padding 都会溢出视口。→ `body` 必须保持 `padding: 0`（legacy.css 有注释）；留白只加在页面内容容器上（如连接表单 `.form-wrap`）。表格页根节点带 `overflow-hidden` 兜底，滚动只发生在网格内部。

### 状态层（zustand）
- **P-6 快速操作时响应错乱** → 连续触发的 fetch 响应乱序回包。→ store 内以 `reqSeq` 自增做竞态防护，旧响应直接丢弃（tableStore.refresh 已实现，新异步 action 照此模式）。
- **P-7 列显隐后隐藏列从设置里消失** → 投影响应的 `rs.columns` 是子集，若直接覆盖全量列基线则无法恢复。→ store 的 `allColumns` 只在未投影（visibleColumns=null）取数时更新；列设置/筛选构造器选项一律取 `allColumns`；**M4 乐观锁 original 取全列原值时也用 allColumns**。

### 驱动与契约
- **P-8 筛选内存基准与驱动结果对不上** → SQL 三值逻辑：与 NULL 的比较一律 unknown（行被排除），仅 isNull/isNotNull 涉及 NULL；且基线样本若被 limit 截断，内存过滤就不完整。→ 内存过滤必须按 SQL 语义实现（conformance `sqlMatch` 是基准实现）；基线取数上限要 ≥ 表行数（conformance 用 SAMPLE_LIMIT=100k）。
- **P-9 “语句必须参数化”无法在契约套件断言** → `IConnection` 接口观测不到生成 SQL。→ 该契约由各驱动 SQL 构建层的单测覆盖（driver-mysql `sql.test.ts` 逐 FilterOp 断言占位符、无值拼接）。
- **P-10 offset 翻页不稳定** → 无 ORDER BY 的 LIMIT/OFFSET 顺序无保证。→ 驱动在 `req.sorts` 为空时默认按主键升序（mysql fetchRows 已实现；翻页稳定契约有测试）。
- **P-11 DoD 数据集**：mock 驱动 `big` 库 t001~t100 每表 5 万行、`demo.wide` 1000 行×20 列，配套 `dod.perf.test.ts`（阈值：wide <1.5s、5 万行分页取尽 <5s）。改数据集规模必须同步改该测试与 rowEstimate。

### 环境（Windows + Git Bash）
- **P-12 python heredoc 在本机 shell 不可靠**（exit 49）→ 不要用 `python - <<EOF` 改文件；用文件编辑工具（Edit/Write）或 `node -e`。
- **P-13 grep 实为 ugrep** → 转义/正则行为与 GNU grep 略有差异；复杂模式加 `-F` 或改用 `node -e` 脚本。
- **P-14 pnpm store 被外部改动**（`pnpm store status` 报 mutated，常见于磁盘清理/杀软）→ `pnpm install --force` 恢复；当前仓库无原生编译依赖，影响有限。
- **P-15 F5 卡"扩展未在 10 秒内启动"** → 日志含 `debugBrk: true` / "STOPPED on first line" 表示宿主被首行断点暂停（非代码错误）。→ launch.json 已显式 `"stopOnEntry": false`；检查用户设置 `debug.javascript.breakOnStart`、NODE_OPTIONS 是否含 `--inspect-brk`；应急用 Ctrl+F5（不调试运行）。
- **P-16 Webview "Could not register service worker: InvalidStateError"** → VSCode 上游 bug（microsoft/vscode#247035，更新后偶发），发生在插件代码执行前。→ 先"Developer: Reload Window"；顽固时关闭 IDE 后删 `%APPDATA%\Code\Service Worker\`（会自动重建）。

---

## 三、快速锚点

| 要做的事 | 去哪里 |
|---|---|
| 设计/ADR/里程碑/DoD | `docs/概要设计.md`（§10 里程碑、§11 ADR） |
| 驱动接口契约、错误码 | `docs/驱动开发规范.md`（§3/§5/§6/§8） |
| UI 状态机/键盘/文案 | `docs/交互设计稿.md`（§4 表格视图、§9.2 错误文案） |
| RPC 消息定义 | `packages/protocol/src/methods.ts`（zod 单一来源） |
| 单元格渲染契约 | `webview-ui/src/lib/cellDisplay.ts` |
| 查询参数/分页文案 | `webview-ui/src/lib/queryState.ts`（纯函数，有单测） |
| 契约测试套件 | `packages/driver-conformance/src/index.ts` |
| 调试运行 | VSCode 打开根目录 → F5（preLaunchTask 自动构建 webview+extension） |
| 测试 | 根目录 `pnpm test`（vitest，含 webview 纯函数与 DoD perf） |
