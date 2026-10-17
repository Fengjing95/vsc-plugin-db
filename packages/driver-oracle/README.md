# @db-explorer/driver-oracle

DB Kit 的 Oracle Database 驱动（M8-Oracle / 概要设计 ADR D-23）。基于 [`oracledb`](https://www.npmjs.com/package/oracledb)（node-oracledb）**thin 模式**——纯 JavaScript，无需 Oracle Instant Client；要求数据库 **12.1+**（本地契约与摸底基于 19c，CI 契约跑 23ai）。

## 能力矩阵

| 能力 | 支持口径 |
|---|---|
| 资源树浏览 | ✓（连接绑定单个 PDB，树上「库」= schema，`ALL_USERS` 排除 oracle-maintained，当前用户排首位） |
| 表格编辑 | ✓（短事务 + 字段级乐观锁 + `RETURNING` 主键回填） |
| SQL Console | ✓（方言补全 / 格式化 plsql；多语句由 core 切分逐条执行） |
| 表结构编辑 | ✓（列/键/外键/索引全 Tab；IDENTITY 原地增删不支持 → `E_UNSUPPORTED`） |
| 库级 DDL | ✓ 建/删 schema（= `CREATE USER` / `DROP USER … CASCADE`；用户不可重命名，无「编辑库」） |
| ER 图 | ✓（FK 自省完整，`collectRelationGraph` 消费） |
| 取消 | ✓（`connection.break()` OOB 带外中断，连接可复用） |
| 交互式事务 | ✓（`openSession`，SessionManager 空闲超时回收） |
| SSL / SSH 隧道 | SSH 隧道 ✓（Host 层通用）；TCPS/SSL 暂不支持 |

## 连接参数

| 字段 | 必填 | 说明 |
|---|---|---|
| 主机 / 端口 | ✓ | 缺省端口 1521 |
| 服务名 | ✓ | service name 或 SID（PDB 应用连接填其注册服务名，如 `orcl`；CDB 默认服务与 SID 同名可直填） |
| 用户名 / 密码 | ✓ / 密码可选 | 密码存 SecretStorage，永不落盘 |
| 连接串（高级） | | 完整 EZConnect/TNS 描述符（RAC/SCAN/LDAP 场景），填写后忽略主机/端口/服务名 |
| 以 SYSDBA 连接（高级） | | 管理场景；普通应用账号保持关闭 |
| 连接超时 / 连接池上限（高级） | | 缺省 15000ms / 4 |

## 权限要求

- **最小可用**（浏览/编辑自有 schema）：`CREATE SESSION` + `RESOURCE`（表/序列/过程）+ `CREATE VIEW`（**19c 的 RESOURCE 不含 CREATE VIEW**）+ 目标表空间配额。
- 跨 schema 浏览：对象级授权（`GRANT SELECT ON …`）或 `SELECT ANY TABLE`——all_* 自省视图的可见性即权限边界（DBA 账号全库可见，最小权限账号见自有 schema）。
- 行估算取 `all_tables.num_rows`（优化器统计），无统计时不显示「约 N 行」——驱动不执行全表 COUNT。
- 查看 DDL：自有对象免角色；跨 schema 需 `SELECT_CATALOG_ROLE`。
- 树上「新建 schema」：`CREATE USER` / `DROP USER`，且对被授予的 `CREATE SESSION`/`RESOURCE`/`CREATE VIEW`/`RESOURCE` 持有 `WITH ADMIN OPTION`（驱动会为新用户授予最小权限）。

## 已知限制

- **空串即 NULL**（Oracle 引擎语义）：编辑/新增输入空串将存为 NULL（预览/回执有提示）；空串永远读不回。
- Console 结果中 >2^53 的 NUMBER 经 JS number 精度失真（表格路径经按列取回保真，无此问题）。
- `DATE`/`TIMESTAMP` 按客户端进程本地时区解释（thin 驱动语义）；`TIMESTAMP WITH TIME ZONE` 渲染 UTC 墙上时间、原始偏移丢失。
- IDENTITY（自增）不可原地增删——表设计器对该操作报 `E_UNSUPPORTED`，需重建表。
- Oracle 禁止同形外键重复（同列引用同目标的约束全库唯一，ORA-02275）——添加与既有约束同形的外键会得到明确报错。
- 不支持 `USE` 语句（Oracle 无该语义，连接即绑定 PDB）；跨 schema 查询手写两段名 `"SCHEMA"."TABLE"`。
- LONG / LONG RAW 为遗留类型，尽力支持（大取数慢）；XMLType / 对象类型 / 集合按文本尽力展示（`unknown`）。
- 暂不支持 TCPS/SSL 加密与 Oracle Wallet 认证；物化视图不入树。

## 契约测试

```bash
# 需真实 Oracle 实例（12.1+）；本地经 env 注入实跑，未设 skip
ORACLE_HOST=… ORACLE_PORT=1521 ORACLE_SERVICE=orcl \
ORACLE_USER=dbkit ORACLE_PASSWORD=… \
ORACLE_ADMIN_USER=sys ORACLE_ADMIN_PASSWORD=… \
npx vitest run packages/driver-oracle/src/oracle.conformance.test.ts
```

fixture：专用 schema `cf_test` 由测试自持（管理连接重建 + `DROP USER CASCADE` 清理）；种子表建在应用账号自身 schema。CI 以 `gvenzl/oracle-free`（slim-faststart）独立 job 实跑（防契约静默缺考）。
