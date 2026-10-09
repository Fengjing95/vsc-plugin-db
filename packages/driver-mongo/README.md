# @db-explorer/driver-mongo

MongoDB 驱动（官方 [`mongodb`](https://www.npmjs.com/package/mongodb) Node 驱动，纯 JS）。M8-Mongo 交付，设计决议见概要设计 **D-17 / D-18**、特化约定见[驱动开发规范 §5.5](../../docs/驱动开发规范.md)。

## 能力矩阵

| 能力 | 声明 | 说明 |
|---|---|---|
| 树浏览 | ✅ | 库（系统库过滤）→ Collections 目录 → collection → 字段（采样推断动态列）/ 索引目录 |
| 文档浏览 | ✅ | cursor 游标分页（`_id` resume，opaque 自包含位点）；offset 兼容翻译 `skip` |
| 筛选下推 | ✅ | 13 个 FilterOp → 查询文档（值绑定语义，禁拼接）；search → string 列 `$or`（objectId 列走 `$toString+$regexMatch`） |
| 表格编辑 | ✅ | D-18：字段级 `$set`（乐观锁 = `_id` + 变更列原值，matched≠1 → `E_CONFLICT`）；insert 回填服务器 `_id`；清空 = `$set null` |
| 事务 | ❌ | `supportsTransaction=false`（多文档事务需副本集）：逐条 + 失败即停，错误定位 kind/tempId/rowKey（§8-5） |
| 命令控制台 | ✅ | mongosh 命令域（每行一条）；**读命令 + 文档写五类**（经危险横幅/prod Modal/只读 fail-closed 护栏）；结构类命令（drop/createIndex/createCollection/eval…）恒 `E_UNSUPPORTED` |
| DDL / 表结构编辑 | ❌ | collection 无 DDL 编辑面 |
| 取消 | ✅ | `supportsCancel=true`——官方驱动操作响应 AbortSignal（契约组 `$where` 忙循环实跑） |
| SSL / TLS | ❌ | 后续批次（含 `mongodb+srv`） |

## 已知限制（README 声明义务）

- **动态列**：列集由前 200 篇文档采样推断（`_id` 恒为首列且标自增——insert 可省略）；schema-free 下列集随采样波动，同字段异型取首个非 null 样本类型（无多型合并）；空页（筛选无命中/尽头页）回退采样列集保证列骨架。
- **字段缺失 = NULL 语义**：单元格编码为 `null`；`isNull` 同时命中显式 `null` 与缺失字段；update 乐观锁对原值 null/缺失统一条件 `{ f: null }`。
- **编辑值 schema-free 容错**：类型转换失败（如 decimal 列写入非数值字符串）按原样存储，不拒绝写入；objectId 列非法 hex 同理降级字符串。
- **命令控制台**：每行一条命令；游标链式调用（`.limit().sort()`）不支持（`E_SYNTAX`）；参数为受限 JS 字面量（**禁 eval**），支持 `ObjectId()/ISODate()/NumberLong()/NumberDecimal()/BinData()` 与 `function(){}`（按 BSON Code 服务端执行）；`use <db>` 由 Console 绑定管理不下发。
- 游标翻页期间修改排序属未定义（Webview 改排序即重置游标）。
- 无 `db` 参数的 `query()` 调用（如契约取消组模板）落到默认库 `test`——跨库命令模板用 `db.getSiblingDB("<db>")` 显式定位。

## 契约测试

`MONGO_URI` 门控（PG 先例）：未设 → skip；CI `mongo:7` service 实跑。本地两种供给：

```bash
# 远程/已有实例
MONGO_URI='mongodb://user:pass@host:27017/?authSource=admin' npx vitest run packages/driver-mongo

# 本地即起即用（P-28 同款，二进制在 ~/tools/mongodb，mongod 7.0.14 arm64）
~/tools/mongodb/mongod --port 28017 --dbpath /tmp/mongo-conf --bind_ip 127.0.0.1 --fork --logpath /tmp/mongod-conf.log
MONGO_URI='mongodb://127.0.0.1:28017/?directConnection=true' npx vitest run packages/driver-mongo
```

fixture 库 `cf_mongo` 由测试自持（drop 重建，种子经官方客户端写入）——测试只触碰 `cf_mongo`。错误密码（`E_AUTH`）用例仅在 URI 携带凭据时跑（本地无认证实例自动跳过，CI 亦未覆盖）。

## 所需最小权限

浏览 + 编辑：目标库 `find/insert/update/remove/listCollections/listIndexes` + 集群 `listDatabases`（`authorizedDatabases` 已开）。命令控制台写命令按用户实际权限执行（服务端鉴权兜底）。
