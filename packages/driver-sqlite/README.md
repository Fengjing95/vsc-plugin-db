# @db-explorer/driver-sqlite

SQLite 驱动（M8-SQLite）。执行引擎为 **sql.js（WASM）单引擎**（ADR D-16）：整库载入内存、同步执行，零 native 依赖，VSIX 平台无关。

## 能力矩阵

| 能力 | 值 | 说明 |
|---|---|---|
| SQL | ✓ | 完整 SQL Console（补全/格式化/危险判定走 SQL 路径） |
| 浏览（表/视图/列/键/索引） | ✓ | `sqlite_master` + `PRAGMA table_info/index_list/foreign_key_list` |
| 表格编辑 | ✓ | 短事务 + 字段级乐观锁 + `RETURNING` 主键回填（SQLite ≥ 3.35） |
| 交互式事务 | ✓ | 单连接 1 会话；commit 即落盘 |
| DDL 查看 / 表结构编辑 | ✓ | 生成器 `ddl.ts`；删列/改类型/改主键走表重建序列 |
| 取消（supportsCancel） | ✗ | 同步引擎不可中断（D-16） |
| 多语句（supportsMultiStatement） | ✗ | Console 按单语句执行（Host 切分） |
| 多数据库 | ✗ | 单文件单库，`listDatabases()` 恒 `main`；`ATTACH` 后续扩展 |

## 连接参数（FormSchema）

| 字段 | 类型 | 说明 |
|---|---|---|
| `path` | string（必填） | 数据库文件路径；支持 `~/` 与相对工作区路径；**文件必须已存在，不自动创建** |
| `readonly` | boolean | 只读打开：拒绝写入语句且永不写回文件 |

无认证字段——不使用 SecretStorage（secret 恒空串）。

## 已知限制（D-16 口径）

- **限用中小库（建议 ≤ 100MB）**：整库驻留内存 + 每次写批次后序列化整库落盘（temp+rename 原子覆写）；同步执行会在大查询/大落盘期间阻塞插件宿主。
- 日期时间为 TEXT 存储原文（SQLite 无日期类型），不做格式规范化、无时区语义。
- `NUMERIC/DECIMAL` 列经 REAL 存储有双精度限制，超高精度列请声明 `TEXT`。
- 表重建（删列/改类型/改主键）**不迁移索引与触发器**（重建后需手工补建）。
- 同一 .db 文件建议仅一个插件连接使用；外部进程写入的增量对已打开连接不可见（重连刷新）。

## 测试

- 契约：`sqlite.conformance.test.ts`（进程内实跑，无需数据库实例，CI 与本地同一套件）
- 单测：`sql/changes/ddl/errors/completion.test.ts`（占位符断言为 P-9 口径）
