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
- **C-10 密钥安全**：密码只存 SecretStorage（`dbExplorer.secrets.<connId>`），永不写入 settings/日志/错误/导出文件；SQL 强制参数化，禁止字符串拼接用户值。唯一例外：`FetchRowsRequest.whereSql/orderBySql` 为用户在筛选栏手写的 SQL 片段（自撰 SQL 而非数据值，驱动规范 §4），按设计原样拼接。

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
- **P-21 Dialog 弹层内 useVirtualizer 列表空白**（M4 预览弹窗踩，真实环境必现）→ Base UI Dialog 的 portal 内容比持有 useVirtualizer 的组件**晚一个 commit 挂载**；useVirtualizer 的无依赖 layout effect（virtual-core `_willUpdate`）在滚动容器 ref 尚未挂载时执行，且组件自身此后未再渲染 → `scrollElement` 恒为 null、永不订阅 RO，`getVirtualItems()` 恒空（容器高度正常、内容全空）。→ **虚拟列表必须与其滚动容器抽成同一子组件**（同 commit 挂载，ref 就绪先于子组件 layout effect）；凡在 Dialog/Popover 等弹层内用 useVirtualizer 一律照此模式。排查：从滚动容器沿 fiber 链找 Virtualizer 实例看 `scrollElement` 是否 null。

### 布局
- **P-5 数据量少也出现整页滚动条** → 表格页根节点 `h-screen`（100vh）+ 任何 body padding 都会溢出视口。→ `body` 必须保持 `padding: 0`（legacy.css 有注释）；留白只加在页面内容容器上（如连接表单 `.form-wrap`）。表格页根节点带 `overflow-hidden` 兜底，滚动只发生在网格内部。

### 状态层（zustand）
- **P-6 快速操作时响应错乱** → 连续触发的 fetch 响应乱序回包。→ store 内以 `reqSeq` 自增做竞态防护，旧响应直接丢弃（tableStore.refresh 已实现，新异步 action 照此模式）。
- **P-7 列显隐后隐藏列从设置里消失** → 投影响应的 `rs.columns` 是子集，若直接覆盖全量列基线则无法恢复。→ store 的 `allColumns` 只在未投影（visibleColumns=null）取数时更新；列设置/筛选构造器选项一律取 `allColumns`；**M4 乐观锁 original 取全列原值时也用 allColumns**。
- **P-17 组件经 action 间接读 store 不触发重渲染**（M4 踩了两次）→ `rowEditState()` / `editCount()` 这类 action 内部用 `get()` 取状态，组件调用它只是普通函数调用，zustand 不会订阅其内部依赖。→ 组件必须显式订阅底层切片。已踩实例：DataGrid 脏视觉（订阅 `updates/deletes`）、Toolbar 提交变更(N)按钮（订阅三个计数切片——曾表现为"选中行后才刷新"，因为只有 selectedRows 订阅顺带触发了重渲染）、预览 Modal 统计行。新组件凡是渲染聚合计数/行状态，一律订阅底层切片再本地聚合。

### 驱动与契约
- **P-8 筛选内存基准与驱动结果对不上** → SQL 三值逻辑：与 NULL 的比较一律 unknown（行被排除），仅 isNull/isNotNull 涉及 NULL；且基线样本若被 limit 截断，内存过滤就不完整。→ 内存过滤必须按 SQL 语义实现（conformance `sqlMatch` 是基准实现）；基线取数上限要 ≥ 表行数（conformance 用 SAMPLE_LIMIT=100k）。
- **P-9 “语句必须参数化”无法在契约套件断言** → `IConnection` 接口观测不到生成 SQL。→ 该契约由各驱动 SQL 构建层的单测覆盖（driver-mysql `sql.test.ts` 逐 FilterOp、`changes.test.ts` 对变更语句断言占位符与 IS NULL）。
- **P-10 offset 翻页不稳定** → 无 ORDER BY 的 LIMIT/OFFSET 顺序无保证。→ 驱动默认按主键升序兜底（mysql fetchRows 已实现；翻页稳定契约有测试）。v0.1.3 起 ORDER BY 片段存在时，主键兜底改为**追加在其后**（且仅当片段未含主键列）——若保持前置，唯一主键下的用户排序会失效。
- **P-11 DoD 数据集**：mock 驱动 `big` 库 t001~t100 每表 5 万行、`demo.wide` 1000 行×20 列，配套 `dod.perf.test.ts`（阈值：wide <1.5s、5 万行分页取尽 <5s、100 条变更提交 <2s）。改数据集规模必须同步改该测试与 rowEstimate。
- **P-18 mock 数据是共享物化存储**（M4 起）→ `MockConnection` 的数据在模块级 `store` 首次访问时物化，**跨连接一致**（模拟真实服务端，冲突场景可两视图构造）；同一测试文件内先跑只读契约组再跑 changeset 组（会改 `demo.*` 数据），测试需要干净数据时调用导出的 `resetMockStore()`。
- **P-19 契约组按能力跳过的判定**（M4 踩）→ `runChangesetChecks` 的能力探测里，驱动对探测表抛 `E_NOT_FOUND` 恰说明编辑**已实现**（表不存在才报错），只有 `E_UNSUPPORTED` 才整组跳过；写成"任何错误都跳过"会让组静默全跳、测试假绿。
- **P-22 预览语句只显示 ?**（M4 踩）→ Webview 预览回填实际值依赖 `PreviewItem.params`（`interpolateSqlParams`），mock 驱动曾漏传导致预览只剩占位符（MySQL 驱动正常，问题只在该驱动复现）。→ 契约组已强制：语句含 ? 时 params 必须等长携带（`preview 语句带参数化 params` 检查）；新驱动实现 previewChanges 必须同源透传 params。
- **P-26 node-redis v5 的重连与销毁语义**（M6 踩）→ ① `reconnectStrategy` 在 `socket` 选项里（顶层传入被静默忽略）；**默认策略无限重试**，错误密码/不可达时 `connect()` 长时间不 resolve、失败后 `quit()` 永久挂起（QUIT 排在重连队列之后）。→ 驱动统一经 `createRedisClient` 注入有限重连（3 次），**失败路径必须 `destroy()` 不能 `quit()`**。② v5 无 v4 的 `withDataType`；二进制保真用 `client.sendCommand(args, { typeMapping: { [RESP_TYPES.BLOB_STRING]: Buffer } })`（`typeMapping` 是**命令级选项**，client 选项与 `withTypeMapping` 都不影响 sendCommand；对类型化命令才生效）。
- **P-27 SCAN 游标分页必须携带批内位置**（M6 踩）→ SCAN 的 COUNT 是提示，一批可能覆盖整个 keyspace（小库必然）——服务端游标已到 '0' 时仍有未消费数据，「只存服务端游标」的翻页第一页后就断流。→ 游标 = `{scan, pending}`（批内未消费单元随游标走，driver-redis `feedScan` 状态机）；初始 '0' 是「未开始」不是「已取尽」，状态机需区分。pending 若走 utf8 字符串通道会**丢二进制字节**（契约值编码 §5.3），游标内以 base64 承载。同构适用于 HSCAN（扁平 [f1,v1,…] 按 2 为单元消费）。
- **P-28 本机无可用容器运行时**（M6 起环境事实，macOS）→ Docker CLI 在但 daemon 未装（无 Docker Desktop/OrbStack/colima/podman），brew 在代理下 "no bottle available" 不可用（macOS 版本已被 Homebrew 降为 Tier 3，不再提供预编译 bottle，brew install 只能源码编译），github.com 不可达；**download.redis.io 可达**。→ Redis 源码编译（7.2.5，`make -j8 MALLOC=libc` 约 1 分钟）后**保留二进制、不起常驻服务**：`~/tools/redis/`（redis-server/redis-cli）与 `~/tools/redis-tls/`（BUILD_TLS=yes 重编译，`OPENSSL_PREFIX=/opt/homebrew/opt/openssl@3`，自签证书 `tls/server.{crt,key}` + `redis-tls.conf`）。源码在 `~/tools/redis-src/`（换编译选项重编前必须 `make distclean` 并删 `src/.make-settings`——残留 BUILD_TLS=yes 会让普通编译报 openssl/ssl.h 缺失）。**M7 起即起即用（2026-10-03 用户决定移除 launchd 自启）**：契约测试经 `driver-redis/src/testEnv.ts` 自动探测端口——空闲则 spawn 实例、afterAll 停掉；已有服务（CI service / 手起）直接复用不启停。手起命令：
  ```bash
  ~/tools/redis/redis-server --port 6379 --save '' --appendonly no --daemonize yes
  ~/tools/redis/redis-server --port 6390 --requirepass m6cipass --daemonize yes   # 错误密码用例
  ~/tools/redis-tls/redis-server ~/tools/redis-tls/redis-tls.conf                 # TLS 6392（conf 内 tls-port）
  ~/tools/redis/redis-cli -p 6392 --tls --insecure PING                           # TLS 连通验证
  ```
  注意：TLS 实例端口用 6392，**不得占用 6391**（契约组「不可达端口」用例固定该号，见 P-30）。写 redis-tls.conf 时 heredoc 静默失败过（P-12 应验）。
- **P-29 node --experimental-strip-types 跑不了本仓库 TS**（M6 踩）→ 驱动/服务类大量使用构造器参数属性（`constructor(private readonly cfg: …)`），strip-only 模式直接语法报错。→ 临时脚本/评估用 vitest 承载（esbuild 转换支持全量 TS 语法），门控用 `describe.skipIf(!process.env.XXX)`（如 D05_EVAL），不污染门禁。
- **P-30 node-redis v5 明文连 TLS 端口：connect() 永久挂起**（M7 踩）→ 明文 client 连 TLS-only 端口（`port 0 --tls-port`）时 TCP 能建立，服务端随即 reset，node-redis 重连循环不终止、`connect()` 永不 resolve，且 ECONNRESET 以**未捕获异常**逃逸（会毒化 vitest 进程）。socket 的 `connectTimeout` 是 TCP 层参数，此场景不触发。→ 驱动建连必须 race 死线（driver-redis `connectWithTimeout`：超时 reject 后由调用方 `destroy()` 报 E_CONN）。同族：重连耗尽后抛的是 `ReconnectStrategyError`，message 为策略自撰文案，**真实原因在 `.socketError`**——错误映射前必须解包（`toRedisError` 已处理，顺带修复「不可达主机误报 E_INTERNAL」的隐患）。契约组「不可达端口」用例固定用 6391，**本地附加实例不得占用 6391**（TLS 实例用 6392）。
- **P-31 sql-formatter 15.x 选项改名 keywordCasing → keywordCase**（M7 踩）→ 15.9.0 传 `keywordCasing` 被静默忽略（dist 无该字段），关键字保持原大小写。→ 用 `keywordCase: 'upper'`（另有 identifierCase/dataTypeCase/functionCase；identifierCase 默认 preserve，勿改动用户标识符大小写）。
- **P-32 ssh2 三连坑（@types 1.15 与 ssh2 1.17 运行时不一致）**（M7 踩）→ ① 服务端认证上下文的认证方法在 **`ctx.method`**（@types 声明的 `ctx.type` 运行时恒 undefined），密码取 `ctx.password` 需 Loose cast；② 客户端 `forwardOut` 签名是 `(srcIP, srcPort, dstIP, dstPort, cb(err, stream))`——**不接收 socket**，channel stream 与本地 socket 要手动 pipe（把 socket 当首参传会静默走 noop）；③ 进程内 `ssh2.Server` 做测试 fixture 时会被粗暴断开（认证拒绝/超时），协议层错误以未捕获异常逃逸（KEY_EXCHANGE_FAILED）——fixture 每个连接必须挂 `client.on('error', () => undefined)`。另：ssh2 本体纯 JS，`cpu-features` 是可选 native 加速（try/catch require，缺省降级），esbuild 打包必须把 `ssh2`/`cpu-features` 标 external（.node 无法打包）——按 D-05 口径无 native 硬依赖、不触发隔离评估。
- **P-33 断开连接后的「自动重连」与「收起失效」竞态**（M7 踩，M6 的收起机制回归）→ 断开 → 状态事件 → 树刷新，而 **展开着的连接节点会被刷新重新拉取子级**，`getChildren(connection)` 里的 `ensureConnected` 把刚断开的连接静默拉回——本地 TCP 握手毫秒级，稳赢任何延迟收起。且 **`reveal({ expand: false })` 收不起已展开节点**（实测当前 VSCode；M6 的 150ms 单次 reveal 方案两头的竞态都靠运气）→ 双保险修复：① `ConnectionManager.recentlyDisconnected` 断开保护窗口（800ms，只覆盖「根刷新处理中拉取旧展开节点子级」的瞬态；窗口内 `getChildren` 返回空子级不建连，重连成功即退出窗口）；② **TreeItem id 代数方案**：`getTreeItem` 给连接节点 id 追加 `#<代数>`（VSCode 按 TreeItem.id 记忆展开状态），断开时递增代数 + 元素级 `emitter.fire(node)` → 视图按新建节点渲染（构建时恒 Collapsed）→ 确定性收起，不依赖 reveal。教训：**「树刷新会重新拉取展开节点的子级」意味着 getChildren 里的建连调用会被刷新隐式触发；而 TreeView API 没有可靠的编程式收起，换 id 是唯一确定性手段。**
- **P-34 core `Emitter.event` 裸提取丢 `this`**（M7 踩）→ `readonly onDidChange = this.changeEmitter.event` 把实例方法抽成裸函数，调用时 `this` 指向外层实例 → emitter 内部 `listeners` 为 undefined 直接崩。→ 事件暴露一律包装：`readonly onDidChange = (fn) => this.changeEmitter.event(fn)`（箭头绑定）或普通方法 `onDidChange(fn) { return this.changeEmitter.event(fn); }`。现有 vscode.EventEmitter 的裸提取恰好可用（其 event 是闭包实现），但换 core Emitter 时必须改写。
- **P-35 exceljs 接入要点**（M7/D-14）→ ① `Row.values` 类型是 `CellValue[] | { [key]: CellValue }` 联合，读回侧先 `Array.isArray` 收窄；且它是**稀疏数组**（空单元格为洞），`Array.prototype.map` 跳过洞——补齐用 `Array.from`。② 流式写用 `stream.xlsx.WorkbookWriter`（逐行 commit 落盘，大导出内存有界），与 ResultExporter 的批量生成器对接。③ esbuild 必须标 `exceljs` external（体积大 + 动态 require，打包无收益且易碎），运行时从 node_modules 加载。
- **P-36 池化连接 + `USE` 语句 = 随机改写单个物理连接**（M7 踩）→ 连接池上执行 `USE db` 只影响当次抢到的那个连接，后续语句大概率拿到别的连接——**Console 里的 USE 语句不能下发驱动**。→ consoleService 拦截 `USE` 语句解析目标库、更新 Console 绑定（`state.db`），配合 mysql `query()` 按 `req.db` 切库（池内专用连接 USE 后执行）。同族坑：连接「默认库」留空时树节点新建的 Console 以 `db=null` 绑定（状态栏只显示连接名，用户误以为绑定了库）——执行前经 `pickDatabaseForConsole` 兜底选择。排查 No database selected 先看 dist 是否含修复（esbuild 非 ASCII 转义成 `\uXXXX`，中文 grep 会假阴性，用符号名 grep）。
- **P-37 带按钮的通知 Toast 会卡住 `finally` 里的终态清理**（M8 踩，F5 实机反馈）→ `showInformationMessage(msg, action)` 返回的 Promise **await 到用户点击/关闭为止**；后台任务若把「关进度通知」放进 `finally` 而前面 await 了回执 Toast，进度通知就驻留到 Toast 被处理——用户看到「成功提示弹出后原进度通知一直在」。→ 终态清理（关 withProgress / 出任务表）必须在任何 `await showMessage` **之前**完成，`finally` 只作幂等兜底（exportTasks.executeDetached）。
- **P-38 React 组件 prop 与 store 状态同名遮蔽**（M8 踩，F5 实机反馈）→ ConsolePage 的 prop `consoleId`（URL 引导参数，恒空串）与 store 的 `consoleId` 同名——组件内新代码写 `c.consoleId === consoleId` 引用的是 **prop** 而非 store 订阅，会话 Tab 选中高亮永不显示，点击除内容外零视觉反馈，实机观感即「点了没反应」。→ 同名场景一律给 store 订阅起独立名（`storeConsoleId`）；回看手段：stub 验证要断言 `aria-selected` 迁移而非只看内容切换（DOM 快照的 `[active]` 标记是焦点不是选中态）。

### 可视化验证（脱离 VSCode 宿主）
- **P-20 Webview 无法脱离 VSCode 直接预览**（工具栏改造时踩）→ `rpc/client.ts` 模块加载即调用 `acquireVsCodeApi()`，tokens.css 全部颜色依赖 `--vscode-*`（浏览器里整页黑底是变量缺失，不是渲染 bug）。→ 临时 stub 页验证：静态 HTML 先注入 `window.acquireVsCodeApi` 桩（postMessage 收 req、异步回放 res 帧）+ `__BOOTSTRAP__` + 一组 Dark Modern 变量，再加载 `dist/` 产物即可真实交互。

### 测试与门禁
- **P-23 dod.perf 阈值在并行跑时假失败**（M5 加测试后踩）→ vitest 默认并行跑测试文件，新增文件加剧 CPU 争抢，M4 perf（提交 100 条变更 <2s）在隔离跑 601ms、全量并行跑 2.5s+ 假红。→ `vitest.config.ts` 已设 `fileParallelism: false`（串行跑文件，全量耗时仅 +3s）；性能类阈值断言的稳定性依赖它，**不要再改回并行**。
- **P-24 语句切分不能用 node-sql-parser 定位**（M5 设计条文 vs 实现取舍）→ node-sql-parser 的 AST 解析不提供语句在原文中的范围映射，无法支撑 Ctrl+Enter「光标所在语句」定位。→ 切分用自研扫描器 `core/services/sqlScript.ts`（字符串/注释内分号不切分，同一目标）；node-sql-parser 仅用于危险判定与只读 fail-closed（`core/services/sqlDanger.ts`，解析失败正则降级）。另注意其 `astify` 单调用可吞多语句（返回数组），`isReadStatement` 已显式拒绝多语句文本。

### 环境（Windows + Git Bash / macOS 代理）
- **P-12 heredoc 在本机 shell 不可靠** → `python - <<EOF` 直接失败（exit 49）；**bash heredoc 内容较长时会被截断**（报 "here-document delimited by end-of-file"，文件写一半）。→ 改文件一律用文件编辑工具（Edit/Write）；追加大段内容用 Edit 锚定文件尾部，不要用 `cat >> file <<EOF`。
- **P-13 grep 实为 ugrep** → 转义/正则行为与 GNU grep 略有差异；复杂模式加 `-F` 或改用 `node -e` 脚本。
- **P-14 pnpm store 被外部改动**（`pnpm store status` 报 mutated，常见于磁盘清理/杀软）→ `pnpm install --force` 恢复；当前仓库无原生编译依赖，影响有限。
- **P-15 F5 卡"扩展未在 10 秒内启动"** → 日志含 `debugBrk: true` / "STOPPED on first line" 表示宿主被首行断点暂停（非代码错误）。→ launch.json 已显式 `"stopOnEntry": false`；检查用户设置 `debug.javascript.breakOnStart`、NODE_OPTIONS 是否含 `--inspect-brk`；应急用 Ctrl+F5（不调试运行）。
- **P-16 Webview "Could not register service worker: InvalidStateError"** → VSCode 上游 bug（microsoft/vscode#247035，更新后偶发），发生在插件代码执行前。→ 先"Developer: Reload Window"；顽固时关闭 IDE 后删 `%APPDATA%\Code\Service Worker\`（会自动重建）。
- **P-25 npm registry TLS 被代理拦截**（M5 装 node-sql-parser 时踩，macOS）→ `pnpm add` 报 `Cert does not contain a DNS name` / curl 报 self signed certificate，系统代理做 TLS 中间人且 Node 不读钥匙串。→ 单次安装绕过：`pnpm --filter <pkg> add <dep> --registry=https://registry.npmmirror.com`（不改全局配置）。

---

## 三、快速锚点

| 要做的事 | 去哪里 |
|---|---|
| 设计/ADR/里程碑/DoD | `docs/概要设计.md`（§10 里程碑、§11 ADR） |
| 驱动接口契约、错误码 | `docs/驱动开发规范.md`（§3/§5/§6/§8） |
| UI 状态机/键盘/文案 | `docs/交互设计稿.md`（§4 表格视图、§9.2 错误文案） |
| RPC 消息定义 | `packages/protocol/src/methods.ts`（zod 单一来源） |
| 单元格渲染契约 | `webview-ui/src/lib/cellDisplay.ts` |
| 编辑覆盖层/RowKey/取数列保障 | `webview-ui/src/lib/editOverlay.ts`（纯函数，有单测） |
| 编辑输入→值编码 | `webview-ui/src/lib/editValues.ts`（C-7 落地点） |
| 查询参数/分页文案 | `webview-ui/src/lib/queryState.ts`（纯函数，有单测） |
| ChangeSet 权威副本 | `packages/core/src/services/changeSetService.ts`（合并语义单测覆盖） |
| MySQL 变更语句生成 | `packages/driver-mysql/src/changes.ts`（preview/apply 同源） |
| Redis 驱动（M6） | `packages/driver-redis`（SCAN/cursor/值编码见其 README；纯函数层 `keys.ts`、错误映射 `errors.ts`） |
| Redis 命令白名单 / 命令行切分 | `packages/core/src/services/redisCommands.ts`（provablyRead fail-closed / dangerous / known，纯函数有单测） |
| 编辑权限 + prod 护栏 + Console 危险判定 | `packages/extension/src/services/editGuard.ts`（DangerGuard §5.8；命令模式同构方法 assessCommandDanger/assertCommandsReadable） |
| SQL 语句切分 / 会话状态 / DDL 识别 | `packages/core/src/services/sqlScript.ts`（扫描器纯函数，P-24） |
| 危险语句判定（AST + 正则降级）/ 只读 fail-closed | `packages/core/src/services/sqlDanger.ts`（纯函数，有单测） |
| Console 执行链（绑定/取消/横幅/历史/DDL 失效） | `packages/extension/src/services/consoleService.ts` |
| Console 补全（上下文规则 / 缓存命中 <100ms） | `packages/core/src/services/completionContext.ts` + metadataCache `getCompletionSource`；provider 注册在 `extension/src/services/consoleCompletion.ts`（P1-1 隔离） |
| Console 执行历史 | `packages/extension/src/services/consoleHistory.ts`（workspaceState，上限 500） |
| Console 结果面板页 | `webview-ui/src/pages/ConsolePage.tsx` + `lib/consoleView.ts`（Tab/消息/状态行/会话 Tab 标签徽标纯函数）+ `store/consoleStore.ts`（M8 会话 Tab：consoles 列表 + switchConsole）；Host 侧会话列表推导 `packages/extension/src/services/consoleTabs.ts`（纯函数有单测） |
| 契约测试套件 | `packages/driver-conformance/src/index.ts`（M6 起含 cursor-pagination / scan-semantics / value-encoding 组） |
| Redis 契约测试 | `packages/driver-redis/src/redis.conformance.test.ts`（需本地 Redis，环境见 P-28；D-05 评估 `D05_EVAL=1` 跑 `d05.eval.test.ts`） |
| Redis SSL/TLS 契约 | `packages/driver-redis/src/ssl.test.ts`（schema 断言常驻；TLS 集成探测 6392，环境见 P-28/P-30） |
| SSH 隧道（cfg.ssh / TOFU 指纹 / 错误映射 / 表单字段注入） | `packages/extension/src/services/sshTunnel.ts`（进程内 ssh2 Server 单测，P-32；表单走 resolveSshTarget 与建连同源） |
| 复制为多种格式（IN/JSON/Markdown/TS/INSERT） | `webview-ui/src/lib/copyFormats.ts`（纯函数有单测）+ `sys.copyText`（rpcHost 剪贴板）+ 工具栏「复制」菜单 |
| 由表结构生成代码（TS/Java/Go/Prisma） | `packages/extension/src/services/codegen.ts`（纯函数有单测）+ 树右键命令 `dbExplorer.generateCode` |
| SQL 格式化 | `packages/core/src/services/sqlFormat.ts`（sql-formatter 封装，P-31 选项名；命令 `dbExplorer.formatSql` 在 commands.ts） |
| 交互式事务（SessionManager / BEGIN-COMMIT-ROLLBACK） | `packages/extension/src/services/sessionManager.ts`（空闲超时自动回滚，单连接 1 会话，§4.6/D-09）；契约组 `runInteractiveTransactionChecks`（driver-conformance，mock+mysql 实现）；Console 拦截在 consoleService.runStatements |
| Excel 导出（xlsx） | `packages/extension/src/services/xlsxWriter.ts`（exceljs 流式，D-14）+ 导出菜单；P-35 |
| 导出任务引擎（M8 后台化 #16） | `packages/extension/src/services/exportTasks.ts`（纯层：调度即回执/后台流式写/终态回执，有单测）+ `resultExporter.ts`（vscode 胶水 createResultExporter）；协议 `ExportRunResult={exportId}` + `evt:export.done` |
| 执行计划树形缩进（D-13） | `webview-ui/src/lib/consoleView.ts`（isExplainResultSet/explainIndentLevels 纯函数）+ ConsoleGrid 首列缩进 |
| 保存查询 | `packages/extension/src/services/savedQueries.ts`（纯函数）+ `savedQueryActions.ts`（VSCode 交互），落盘 `.vscode/db-queries/*.sql` |
| Webview 可视化验证（无宿主） | skill `webview-visual-test`：`node .agents/skills/webview-visual-test/scripts/make-stub.mjs` 起 stub 页（P-20，**单实例串行**，两实例并行争输出目录互崩，见 pitfalls），Console 页场景见 `scripts/console-scenario.js` / `console-banner.js` / `console-sessions.js`（M8 会话 Tab）、表格导出场景 `scripts/table-export.js`（M8 导出 chip）、连接表单场景 `scripts/connection-form-ssl.js`，坑与排查见其 `references/pitfalls.md`（P-21 等） |
| 调试运行 | VSCode 打开根目录 → F5（preLaunchTask 自动构建 webview+extension） |
| 测试 | 根目录 `pnpm test`（vitest，含 webview 纯函数与 DoD perf） |
