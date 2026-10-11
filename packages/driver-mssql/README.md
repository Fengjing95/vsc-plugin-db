# @db-explorer/driver-mssql

Microsoft SQL Server 驱动（基于 [mssql / tedious 内核](https://github.com/tediousjs/node-mssql)，纯 JS 无 native 硬依赖，D-05 口径），实现统一驱动契约（`@db-explorer/core`）。

## 能力矩阵

| 能力 | 值 | 说明 |
|---|---|---|
| `supportsSQL` | ✓ | Console / 补全 / 格式化（sql-formatter `transactsql` 方言） |
| `supportsTransaction` | ✓ | applyChanges 单事务（mssql.Transaction，失败全量回滚，§8） |
| `supportsInteractiveTransaction` | ✓ | openSession（SessionManager 空闲超时回收） |
| `supportsMultipleDatabases` | ✗ | 连接绑定单库（Initial Catalog）；跨库查询在 Console 手写三段名 |
| `supportsMultiStatement` | ✗ | 收紧注入面；Console 按单语句执行 |
| `supportsCancel` | ✓ | AbortSignal → `request.cancel()`（TDS ATTENTION）→ E_CANCELED；CI service 实跑取消组 |
| `supportsDdl` / `supportsDdlEditor` | ✓ | getDdl + buildCreateTable/buildAlterTable（T-SQL 方言，IDENTITY(1,1)、MS_Description 注释） |
| `supportsDatabaseDdl` | ✓ | 建/删 schema（D-19/D-21；DROP SCHEMA 仅空 schema 成功——T-SQL 无 CASCADE） |
| `editable` | ✓ | 字段级乐观锁（主键 + 变更列原值，NULL 原值 `IS NULL`）；INSERT 主键回填经 `OUTPUT INSERTED` |
| `pagination` | offset | OFFSET-FETCH（T-SQL 无 LIMIT）；主键升序兜底排序（P-10） |
| `lazyCell` | ✗ | 大单元格暂不支持按需拉取 |

## schema 上树（ADR D-21，D-15 同构）

- 连接绑定单一数据库：表单「默认库」= Initial Catalog（缺省 `master`）
- 树 database 层 = 该库内的**非系统 schema**（排除 `sys` / `information_schema` / `guest` / `db_*` 固定架构）；`listDatabases()` 返回 schema 列表
- 全部接口的 `db` 参数 = **schema 名**，`obj` 恒为裸表/视图名；驱动生成的语句显式 `[schema].[table]` 两段名限定
- Console 用户手写的**未限定名按登录默认 schema 解析**（SSMS 同款行为）；跨库查询手写三段名 `[db].[schema].[table]` 即可，无需 USE（也禁止——池化下 `USE` 语义不可靠）

## 类型映射（§5.6 要点）

- `decimal/numeric/money` → decimal 字符串；`bigint` ≤ 2^53 → number，超限 → decimal 字符串
- `date` / `time` / `datetime / datetime2 / smalldatetime` → `'YYYY-MM-DD HH:mm:ss.SSS'` 等文本（tedious `useUTC` 下按 UTC 组件读出还原服务端墙上时间，不带时区；`datetimeoffset` 按 UTC 渲染，偏移量丢失）
- `varbinary` → base64（编辑回传 base64 自动转 Buffer 绑定）；`uniqueidentifier` → uuid 字符串；`bit` → boolean
- JSON 无原生类型（`nvarchar(max)` 文本承载）：按字符串往返，`JSON_VALUE`/`JSON_QUERY` 函数可用
- 编辑回传的日期时间文本经 **tedious 原生类型绑定**（DateTime2/Date/Time，显式 `mssql.TYPES.*`）——字符串直传 NVarChar 会触发受会话 DATEFORMAT 影响的非确定性隐式转换

## 已知限制

- **SSMS 风格 `GO` 批分隔符不支持**：`GO` 是客户端伪指令而非 T-SQL 语句，Console 按 `;` 切分单语句执行——粘贴含 `GO` 的脚本会报语法错误，请手工去掉 `GO` 行
- **带触发器的表不支持 INSERT 回填**：`OUTPUT INSERTED` 在启用触发器的目标表上被服务端拒绝（T-SQL 约束），该类表的表格新增行会失败；更新/删除不受影响
- **IDENTITY 不可原地增删**：表结构编辑器对已有列加/删自增会提示需要重建表（引擎限制）；建表时 `IDENTITY(1,1)` 正常
- 认证仅支持 **SQL Server 登录**（用户名/密码）；Windows 集成认证与 Microsoft Entra（AAD）认证不支持
- `sql_variant` / `geography` / `geometry` / `hierarchyid` 按原样文本展示（`unknown`）

## 权限要求

只读使用仅需目标 schema 内表级 `SELECT`；编辑需 `INSERT/UPDATE/DELETE`；结构编辑需 `ALTER`；库级 DDL（建/删 schema）需 `CREATE SCHEMA` / 对应 schema 的 `CONTROL` 权限。

## 版本兼容

- SQL Server 2016 及以上（`DROP TABLE IF EXISTS`、JSON 函数）；Azure SQL Database 兼容
- SSL/TLS：`ssl` 开关（Encrypt）+ `sslInsecure`（trustServerCertificate，表单含风险提示）；默认不加密
- `mssql` ^11 / `tedious` ^18 纯 JS；可选依赖 `msnodesqlv8`（Windows native 路径）不在打包图内，永不触达

## 契约测试

```
# 本地（无实例时自动 skip；本机无容器运行时，真实契约完全依赖 CI）
pnpm test

# CI / 有实例时实跑（驱动规范 §11 CI 门控口径，服务为 mssql/server:2022-latest）
MSSQL_HOST=127.0.0.1 MSSQL_PORT=1433 MSSQL_USER=sa MSSQL_PASSWORD='...' MSSQL_DATABASE=cf_test \
  npx vitest run packages/driver-mssql/src/mssql.conformance.test.ts
```
