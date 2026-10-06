# @db-explorer/driver-postgres

PostgreSQL 驱动（基于 [pg / node-postgres](https://node-postgres.com/)，T-11），实现统一驱动契约（`@db-explorer/core`）。

## 能力矩阵

| 能力 | 值 | 说明 |
|---|---|---|
| `supportsSQL` | ✓ | Console / 补全 / 格式化（sql-formatter `postgresql` 方言） |
| `supportsTransaction` | ✓ | applyChanges 单事务（失败全量回滚，§8） |
| `supportsInteractiveTransaction` | ✓ | openSession（SessionManager 空闲超时回收） |
| `supportsMultipleDatabases` | ✗ | PG 连接协议绑定单库，无跨库切换 |
| `supportsMultiStatement` | ✗ | 收紧注入面；Console 按单语句执行 |
| `supportsCancel` | ✓ | AbortSignal → `client.cancel()`（57014 → E_CANCELED）；CI postgres service 实跑取消组 |
| `supportsDdl` / `supportsDdlEditor` | ✓ | getDdl + buildCreateTable/buildAlterTable（PG 方言，IDENTITY 自增、COMMENT ON） |
| `editable` | ✓ | 字段级乐观锁（主键 + 变更列原值，NULL 原值 `IS NULL`） |
| `pagination` | offset | 主键升序兜底排序（P-10） |
| `lazyCell` | ✗ | 大单元格暂不支持按需拉取 |

## schema 上树（D-15）

- PG 连接协议绑定单一数据库：表单「默认库」= 连接字符串的真库名
- 树 database 层 = 该库内的**非系统 schema**（排除 `pg_*` 与 `information_schema`）；`listDatabases()` 返回 schema 列表
- 全部接口的 `db` 参数 = **schema 名**，`obj` 恒为裸表/视图名；SQL 对象引用显式 `"schema"."table"` 限定
- `QueryRequest.db`（Console 绑定）≠ `public` 时经池内专用连接 `SET search_path` 后执行、用毕 `RESET`（防池污染）

## 类型映射（§5.2 要点）

- `numeric` → decimal 字符串；`bigint` ≤ 2^53 → number，超限 → decimal 字符串
- `timestamp` / `timestamptz` → `'YYYY-MM-DD HH:mm:ss.SSS'`（会话级覆写 pg 类型解析器禁用 JS Date，timestamptz 剥偏移保留会话时区墙上时间）
- `bytea` → base64（编辑回传 base64 自动转 Buffer 绑定）；`json`/`jsonb` → 已解析对象；数组 → JSON 数组；`uuid` → uuid

## 权限要求

只读使用仅需目标 schema 的 `USAGE` + 表级 `SELECT`；编辑/DDL 需对应写权限（`INSERT/UPDATE/DELETE`、`CREATE/ALTER`）。

## 版本兼容

- PostgreSQL ≥ 10（IDENTITY 语法）；`pg` ^8.13 纯 JS，无 native 硬依赖（D-05）
- SSL：`ssl` 开关 + `sslInsecure`（跳过证书校验，表单含风险提示）

## 契约测试

```
# 本地（无实例时自动 skip）
pnpm test

# CI / 有实例时实跑（驱动规范 §11 CI 门控口径）
PG_HOST=127.0.0.1 PG_PORT=5432 PG_USER=postgres PG_PASSWORD=postgres PG_DATABASE=postgres \
  npx vitest run packages/driver-postgres/src/postgres.conformance.test.ts
```
