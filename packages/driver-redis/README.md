# @db-explorer/driver-redis

Redis 驱动（node-redis v5）。M6 交付：Key 树、SCAN 分页、类型化展示、命令控制台。

## 能力矩阵（capabilities）

| 能力 | 值 | 说明 |
|---|---|---|
| supportsSQL | `false` | 无 SQL；命令控制台复用 Console UI，危险/只读判定走 core 命令白名单（驱动规范 §5.3） |
| supportsTransaction | `false` | Redis 无可回滚事务；无表格编辑场景 |
| supportsMultiStatement | `false` | 命令控制台按行切分逐条执行 |
| supportsCancel | `false` | node-redis 无法可靠中止已下发命令（契约如实声明，规范 §7） |
| supportsDdl | `false` | — |
| supportsMultipleDatabases | `true` | db0..N-1（CONFIG GET databases，默认 16）；每库独立客户端（SELECT 是连接级状态） |
| hierarchy | connection → database → folder → collection | 三级 Keys 目录（概要设计 §5.1.3），集合节点打开表格视图 |
| editable | `false` | 表格编辑不支持；变更集契约组按 P-19 以 E_UNSUPPORTED 跳过 |
| pagination | `'cursor'` | opaque 游标 = 服务端游标 + 批内未消费单元；offset 翻译为「SCAN 起始跳过」 |
| lazyCell | 无 | 值随行传输（受 5000 行 / 5MB 上限约束） |

## 树层级与取数路径

```
▾ 连接
  ▾ db0
    ▸ 字符串 (3)      ← 按数据类型分组（schema 字段 = 分组 id，驱动虚拟化）
    ▸ 哈希 (1)
    ▸ 列表 (1)
    ▸ 集合 (1)
    ▸ 有序集合 (1)
    ▸ 流 (1)          ← stream 键可列出；单击打开内容表报 E_UNSUPPORTED（M6 未支持）
    ▸ Keys (1)
      ▸ *（模式浏览）  ← 全键空间 SCAN 分页表格（含 key/type/__ttl 列与筛选/搜索）
```

- **类型目录**下的键为单键节点（key 图标），单击打开该键的类型化内容表：
  | 类型 | 列 | 底层命令 |
  |---|---|---|
  | string | value | GET |
  | hash | field / value | HSCAN |
  | list | index / value | LRANGE |
  | set | member | SSCAN |
  | zset | member / score | ZRANGE WITHSCORES |
  | stream | 不支持（E_UNSUPPORTED，M6 范围外） | — |
- **`*` 模式节点**：表格视图列出全部键（`key / type / __ttl`，TTL 只读虚拟列，-1=无过期），
  支持结构化筛选/搜索/排序/翻页——大键空间浏览入口；也可在连接命令控制台用 SCAN 自查
- 类型分组依据 SCAN 采样（≤500 键，COUNT 提示 200）；更大键空间用 `*` 模式浏览或精确模式
- `primaryKey` 恒为 `['key']`（模式浏览）；内容表为 field/member/index（仅定位展示用，不可编辑）
- 目录分组协议：键值驱动的 `ObjectMeta.schema` 复用为「所属分组 id」，树（extension 层）按
  schema 值归组渲染目录、无 schema 条目归默认 Keys 目录——树不感知具体数据源类型（概要 §5.1.3）

## 值编码（驱动规范 §5.3，违反即契约失败）

- bulk string 统一以 Buffer 接收（`sendCommand` + `typeMapping`），**二进制保真**
- 无效 UTF-8 / 控制字符 → `binary`（base64 字符串）
- 整数形状（`^-?(0|[1-9]\d*)$` 且 ≤ MAX_SAFE_INTEGER）→ `integer`；前导零（`007`）/超限保 string
- JSON 数组/对象（`[` / `{` 开头且可解析）→ `json`（已解析对象）
- 其余 → `string` 原样

## 分页语义与已知限制

- **cursor 分页**：`nextCursor` 闭环（沿游标走完 = 全量，无重复无遗漏，契约测试覆盖）。SCAN 一批可能
  覆盖整个 keyspace，批内位置随游标携带（base64 不透明串）。
- **offset 翻页**：翻译为「SCAN 起始跳过」，深页复杂度 O(offset)；webview 分页栏（offset 语义）零改动兼容。
  大库深页性能不足时，后续在 protocol/webview 增加 cursor 透传（增量适配，不动 core 契约）。
- **排序为页内局部排序**（`sorts: 'page'` 契约语义）：SCAN 无服务端排序，且 C-9 禁止取全表——
  只对已取回的页排序，全局序以 SCAN 稳定序为准。契约组合用例（filters+sorts+offset 全局序）按此跳过。
- **list/zset 位置分页无法下推筛选**：过滤后行数可能少于页大小（筛过的行跳过显示）。
- 筛选（`filters`）与搜索（`search`）为 SCAN 结果上的内存过滤（键值源无服务端谓词下推；
  `whereSql` / `orderBySql` 片段不支持 → E_VALIDATION）。

## 命令控制台

- 每行一条命令（空行与 `#` 注释跳过）；`Ctrl+Enter` 执行光标所在行命令
- 只读连接 fail-closed：仅白名单读命令放行（core `redisCommands.ts`，未知命令一律拒绝）
- 危险命令（FLUSHALL/SHUTDOWN/SCRIPT/CLUSTER 等）触发横幅/生产 Modal；普通写命令（SET/DEL）直接执行
- 写命令成功后自动失效该库元数据缓存并联动树刷新
- `HGETALL` 结果类型化为 field/value 两列；其余回复单列展示；错误按错误码映射
  （unknown command → E_UNSUPPORTED、参数错误 → E_SYNTAX、WRONGPASS → E_AUTH）

## 连接参数（FormSchema）

host / port / username（ACL，可选）/ password（SecretStorage）/ 默认库编号（database）/
**ssl（SSL/TLS 加密连接，默认关）** / **sslInsecure（跳过证书校验，高级，默认关）** / 连接超时（高级）。
SSH 隧道：M7 范围，未实现。

### SSL/TLS（M7）

- 云托管 Redis（Upstash / Redis Cloud / Aiven Valkey 等）强制 TLS：开启 `ssl` 即可（证书有效时无需其他配置）
- 自签/私有 CA 证书的实例须同时开启 `sslInsecure`——**不校验服务器证书，存在中间人风险**，
  表单该项旁已按规范 §10 标注风险提示，仅限受信内网使用
- 默认严格校验：证书不通过 → `E_CONN`（错误文案给出指引），不静默降级为明文
- 驱动内置建连死线（connectTimeout，默认 10s）：node-redis 在明文连 TLS 端口等场景 connect()
  永不 resolve（P-30），死线兜底报 `E_CONN` 连接超时

## 本地测试

**即起即用（M7 起，launchd 常驻已移除，AGENTS.md P-28）**：契约测试经 `src/testEnv.ts` 探测端口——
空闲则自动 spawn 本地二进制（含 TLS 实例起 TLS 版），测试结束后停掉；已有服务（CI service /
手起）直接复用，不重复启停。本地二进制保留：`~/tools/redis/`（常规）与 `~/tools/redis-tls/`
（BUILD_TLS=yes + 自签证书，TLS 端口 6392；端口避开契约组「不可达端口」占用的 6391）。
手动起实例（可选，测试自起自停一般不需要）：

```bash
~/tools/redis/redis-server --port 6379 --save '' --appendonly no --daemonize yes   # 常规契约
~/tools/redis/redis-server --port 6390 --requirepass m6cipass --daemonize yes      # 错误密码用例
~/tools/redis-tls/redis-server ~/tools/redis-tls/redis-tls.conf                    # TLS 6392
pnpm vitest run packages/driver-redis
```

实例应专用（测试只触碰 `cf:*` 与 fixture 键，不执行 FLUSHDB）；CI 矩阵见 `.github/workflows/ci.yml`
（redis:7 ×2，评审 P2-3 补齐）。

## 依赖与平台

- `redis`（node-redis）v5：纯 JS，无 native 模块（不触发 D-05 隔离评估的 native 崩溃条件）
- Node ≥ 20（engines 基线，ADR D-11）；VSCode 桌面版
