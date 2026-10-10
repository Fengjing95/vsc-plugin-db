# DB Kit

在 VSCode 内浏览、查询、编辑 MySQL / PostgreSQL / SQLite / MongoDB / Redis：资源树、表格视图、SQL Console、结构管理与流式导出。

## 功能速览

- **资源树**：库 / 表 / 视图 / 列 / 键 / 索引懒加载展开（MongoDB 为库 / collection / 字段目录，Redis 为 Key 类型目录），查看 DDL、生成 SELECT、由表结构生成代码（TS/Java/Go/Prisma）
- **表格视图**：虚拟滚动，筛选 / 排序 / 搜索全部服务端下推（参数化，不拉全表）；单元格编辑——双击进入、参数化 SQL 预览、单事务提交、乐观锁冲突定位错误行；无主键表默认只读
- **SQL Console**：上下文补全（方言关键字 + 库/表/列元数据）、执行历史、无 WHERE 危险语句拦截、生产库分级确认、EXPLAIN 树形缩进、行内执行注记、交互式事务
- **结构管理**：表结构编辑器（建/改表与列）、库级操作（MySQL 建/改/删库、PG 建/删 schema、MongoDB 建/删库）
- **导出**：CSV / JSON / XLSX 后台流式导出（大结果集不卡 UI，通知中心进度、可取消、多任务并发）
- **安全**：密码只存 VSCode SecretStorage（不落盘、不入日志）；只读连接全入口拦截；SSL 与 SSH 隧道（TOFU 指纹）；无遥测

## 快速上手

1. 活动栏「数据库」→ 视图标题栏「＋ 新建连接」（内置 Mock 数据源无需任何实例，可直接体验全部界面）；
2. 展开连接 → 单击表名打开表格视图；右键节点查看 DDL / 生成代码 / 库与表级操作；
3. 新建查询（树「查询」目录或任意 `.sql` 文件）→ `Ctrl+Enter` 执行。

## 支持的数据库

| 数据源 | 驱动库 | 说明 |
|---|---|---|
| MySQL | mysql2 | 5.7 / 8.x |
| PostgreSQL | pg | 12+，schema 映射为树上「库」 |
| SQLite | sql.js（WASM） | 单文件库，建议 ≤ 100MB |
| MongoDB | mongodb（官方） | 浏览 + 文档编辑 + mongosh 命令控制台 |
| Redis | node-redis | 5.x/6.x/7.x，只读浏览 + 命令控制台，支持 TLS |

## 已知限制（0.1.0）

UI 文案仅中文；Web 版 VSCode 不支持；MongoDB 结构类命令与 Redis 编辑不支持；导出格式 CSV/JSON/XLSX。完整清单见仓库 [CHANGELOG](https://github.com/Fengjing95/vsc-plugin-db/blob/main/CHANGELOG.md)。

## 链接

- 仓库与问题反馈：https://github.com/Fengjing95/vsc-plugin-db
- 更新日志：https://github.com/Fengjing95/vsc-plugin-db/blob/main/CHANGELOG.md

## License

Apache-2.0
