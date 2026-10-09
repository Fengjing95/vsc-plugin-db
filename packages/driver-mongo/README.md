# @db-explorer/driver-mongo

MongoDB 驱动（官方 [`mongodb`](https://www.npmjs.com/package/mongodb) Node 驱动，纯 JS）。M8-Mongo 交付，设计决议见概要设计 **D-17**、特化约定见[驱动开发规范 §5.5](../../docs/驱动开发规范.md)。

## 能力矩阵（首批，2026-10-09）

| 能力 | 声明 | 说明 |
|---|---|---|
| 树浏览 | ✅ | 库（系统库过滤）→ Collections 目录 → collection → 字段（采样推断动态列）/ 索引目录 |
| 文档浏览 | ✅ | cursor 游标分页（`_id` resume，opaque 自包含位点）；offset 兼容翻译 `skip` |
| 筛选下推 | ✅ | 13 个 FilterOp → 查询文档（值绑定语义，禁拼接）；search → string 列 `$or $regex` |
| 命令控制台 | ✅（只读） | mongosh 命令域（每行一条）；白名单 provablyRead fail-closed（core `mongoCommands`）；**非读命令一律 `E_UNSUPPORTED`** |
| 表格编辑 | ❌ | `editable=false`（`applyChanges`/`previewChanges` 抛 `E_UNSUPPORTED`）；文档编辑留后续批次（D-17） |
| 事务 | ❌ | 无交互式事务 |
| DDL / 表结构编辑 | ❌ | collection 无 DDL 编辑面 |
| 取消 | ✅ | `supportsCancel=true`——官方驱动操作响应 AbortSignal（契约组 `$where` 忙循环实跑） |
| SSL / TLS | ❌ | 后续批次（含 `mongodb+srv`） |

## 已知限制（README 声明义务）

- **动态列**：列集由前 200 篇文档采样推断（`_id` 恒为首列）；schema-free 下列集随采样波动，同字段异型取首个非 null 样本类型（无多型合并）。
- **字段缺失 = NULL 语义**：`isNull` 同时命中显式 `null` 与缺失字段（文档模型口径，D-17）。
- **命令控制台**：每行一条命令；游标链式调用（`.limit().sort()`）不支持（`E_SYNTAX`）；参数为受限 JS 字面量（**禁 eval**），支持 `ObjectId()/ISODate()/NumberLong()/NumberDecimal()/BinData()` 与 `function(){}`（按 BSON Code 服务端执行）。
- **首批只读**：写命令（insert/update/delete/drop/createIndex/…）经危险横幅（prod Modal）后仍被驱动拒绝；`use <db>` 由 Console 状态栏/绑定管理，不下发。
- 游标翻页期间修改排序属未定义（Webview 改排序即重置游标）。

## 契约测试

`MONGO_URI` 门控（PG 先例）：未设 → skip；CI `mongo:7` service 实跑。

```bash
MONGO_URI='mongodb://user:pass@host:27017/?authSource=admin' npx vitest run packages/driver-mongo
```

fixture 库 `cf_mongo` 由测试自持（drop 重建 + 种子经官方客户端写入，驱动只读不能自造数据）；测试只触碰 `cf_mongo`。

## 所需最小权限

只读使用：目标库 `find`/`listCollections`/`listIndexes` + 集群 `listDatabases`（`authorizedDatabases` 已开）。无写权限要求。
