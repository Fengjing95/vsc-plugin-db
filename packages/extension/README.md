<div align="center">

# DB Kit

**在 VSCode 里搞定数据库的一切 —— 浏览 · 查询 · 编辑 · 导出**

`MySQL` · `PostgreSQL` · `SQL Server` · `SQLite` · `MongoDB` · `Redis`

[![CI](https://github.com/Fengjing95/vsc-plugin-db/actions/workflows/ci.yml/badge.svg)](https://github.com/Fengjing95/vsc-plugin-db/actions/workflows/ci.yml)
![版本](https://img.shields.io/github/v/release/Fengjing95/vsc-plugin-db)
![License](https://img.shields.io/badge/license-Apache--2.0-blue)
![平台](https://img.shields.io/badge/VSCode-%5E1.85-blue)

</div>

---

<img alt="DB Kit 表格视图总览" src="https://raw.githubusercontent.com/Fengjing95/vsc-plugin-db/main/docs/images/overview-table.png" width="100%">

左侧资源树一键展开库 / 表 / 列 / 键 / 索引；右侧表格视图的筛选、排序、搜索全部**参数化下推到数据库执行**——不拉全表，千万行级也只取你看到的那一页。

## ✨ 亮点

**📊 表格即工作台**
虚拟滚动流畅浏览大表；单元格双击直改，提交前给出参数化 SQL 预览，单事务提交 + 字段级乐观锁，并发冲突精准定位到错误行；无主键表默认只读保护。

**⌨️ SQL Console 会补全也会踩刹车**
按上下文补全库 / 表 / 列与方言关键字；`UPDATE`/`DELETE` 不带 WHERE 直接拦截，生产库分级二次确认；EXPLAIN 结果自动树形缩进；每条语句的耗时 / 错误 / 取消状态行内注记。

**🧱 结构管理不写 DDL**
表与列的可视化增删改，语句预览 + 破坏性操作红条告警；库级操作开箱可用：MySQL 建 / 改 / 删库，PostgreSQL 与 SQL Server 建 / 删 schema，MongoDB 建 / 删库。

**📤 百万行导出不卡界面**
CSV / JSON / XLSX 流式导出转入后台执行：通知中心看进度、随时取消、多任务并发，导完一键定位文件。

**🔌 连接开箱即用**
每驱动动态连接表单；SSH 隧道（TOFU 指纹校验）与 SSL/TLS；密码只存系统密钥链，**零遥测、不落盘**。

## 🚀 30 秒上手

1. 安装后点活动栏「数据库」图标 → **＋ 新建连接**
2. 选 **Mock** 数据源可零配置立即体验全部功能（内置 5 万行大表与 20 列宽表）
3. 单击表名打开表格视图；树中「新增查询」写 SQL，`Ctrl+Enter` 执行

## 📸 更多界面

| SQL Console | 表结构编辑器 |
|---|---|
| <img alt="SQL Console" src="https://raw.githubusercontent.com/Fengjing95/vsc-plugin-db/main/docs/images/console.png" width="100%"> | <img alt="表结构编辑器" src="https://raw.githubusercontent.com/Fengjing95/vsc-plugin-db/main/docs/images/schema-editor.png" width="100%"> |

| 库级操作 | 后台导出 |
|---|---|
| <img alt="库级操作" src="https://raw.githubusercontent.com/Fengjing95/vsc-plugin-db/main/docs/images/database-ddl.png" width="100%"> | <img alt="后台导出" src="https://raw.githubusercontent.com/Fengjing95/vsc-plugin-db/main/docs/images/export.png" width="100%"> |

## 🗺️ 支持矩阵

| 能力 | MySQL | PostgreSQL | SQL Server | SQLite | MongoDB | Redis |
|---|:-:|:-:|:-:|:-:|:-:|:-:|
| 资源树浏览 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| 表格编辑 | ✓ | ✓ | ✓ | ✓ | ✓ 文档编辑 | 只读 |
| SQL Console / 命令控制台 | ✓ | ✓ | ✓ | ✓ | mongosh | ✓ |
| 结构编辑（表 / 列） | ✓ | ✓ | ✓ | ✓ | — | — |
| 库级 DDL | ✓ | ✓ | ✓ 建/删 schema | — | ✓ | — |
| SSL / SSH 隧道 | ✓ | ✓ | ✓ | — | ✓ | ✓ |
| 后台导出 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |

> SQLite 限中小库（≤ 100MB）；MongoDB 结构类命令不支持；SQL Server 不支持 `GO` 批与触发器表的 INSERT 回填（详见[驱动说明](https://github.com/Fengjing95/vsc-plugin-db/tree/main/packages/driver-mssql)）；完整口径见[仓库文档](https://github.com/Fengjing95/vsc-plugin-db/tree/main/docs)。

## 📦 安装

- **VSCode 扩展面板**搜索 `DB Kit`，或命令行：`ext install db-explorer-dev.db-kit`
- 也可从 [GitHub Releases](https://github.com/Fengjing95/vsc-plugin-db/releases) 下载 VSIX 手动安装

## 📚 文档

- [更新日志](https://github.com/Fengjing95/vsc-plugin-db/blob/main/CHANGELOG.md) · [已知限制](https://github.com/Fengjing95/vsc-plugin-db/blob/main/CHANGELOG.md#已知限制) · [问题反馈](https://github.com/Fengjing95/vsc-plugin-db/issues)
- 设计文档：[概要设计](https://github.com/Fengjing95/vsc-plugin-db/blob/main/docs/概要设计.md) / [驱动开发规范](https://github.com/Fengjing95/vsc-plugin-db/blob/main/docs/驱动开发规范.md) / [交互设计稿](https://github.com/Fengjing95/vsc-plugin-db/blob/main/docs/交互设计稿.md)

## License

[Apache-2.0](https://github.com/Fengjing95/vsc-plugin-db/blob/main/LICENSE)
