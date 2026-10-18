/**
 * 统一元数据模型（概要设计 §4.2）
 */
export type NormalizedType =
  | 'string'
  | 'integer'
  | 'decimal'
  | 'float'
  | 'boolean'
  | 'date'
  | 'time'
  | 'datetime'
  | 'json'
  | 'binary'
  | 'uuid'
  | 'unknown';

export type ObjectKind = 'table' | 'view' | 'materialized-view' | 'collection';

export interface DatabaseMeta {
  name: string;
  charset?: string;
  /** @since v0.1.11（M8-DBDDL）：排序规则（MySQL 填充，编辑库表单预填） */
  collation?: string;
  comment?: string;
  sizeBytes?: number;
}

/** 库级 DDL 目标模型（@since v0.1.11，M8-DBDDL / D-19）：buildCreateDatabase/buildAlterDatabase 输入。
 *  charset/collation 仅 MySQL 消费（PG schema / Mongo 不参与建库）；
 *  collection 仅 MongoDB 建库消费（D-19 修订：建库 = 创建首个 collection 隐式建库，SQL 驱动忽略）；
 *  password 仅 Oracle 消费（M8-Oracle / D-23：CREATE USER 需密码，Host 预览/日志侧掩码 C-10） */
export interface DatabaseSpec {
  name: string;
  charset?: string;
  collation?: string;
  /** @since v0.1.11 修订（D-19）：MongoDB 建库所需的首个 collection 名 */
  collection?: string;
  /** @since v0.1.16（M8-Oracle / D-23）：CREATE USER 密码（Oracle「库」= schema = 用户）；
   *  fail-closed 校验在驱动（非空、无引号/控制字符）；语句含密码原文，预览/日志掩码由 Host 承载 */
  password?: string;
}

export interface ObjectMeta {
  name: string;
  schema?: string;
  kind: ObjectKind;
  comment?: string;
  rowEstimate?: number;
}

export interface ColumnMeta {
  name: string;
  /** 驱动原始类型，如 varchar(64) */
  dataType: string;
  normalizedType: NormalizedType;
  nullable: boolean;
  isPrimaryKey: boolean;
  autoIncrement?: boolean;
  defaultValue?: string;
  comment?: string;
  ordinal: number;
}

export interface IndexMeta {
  name: string;
  columns: string[];
  unique: boolean;
  type?: string;
}

export interface KeyMeta {
  name: string;
  kind: 'PK' | 'FK' | 'UNIQUE';
  columns: string[];
  refTable?: string;
  refColumns?: string[];
}

// ── 表结构编辑（概要 §5.9，M8-B2；驱动契约见驱动规范 §3 @since v0.1.2）──────────

/** 列定义（结构编辑器输入模型）。dataType 为用户输入的方言类型原文（如 varchar(64)），
 *  不含 normalizedType——规范化以建表后 listColumns 返回为准 */
export interface ColumnSpec {
  name: string;
  dataType: string;
  nullable: boolean;
  isPrimaryKey: boolean;
  autoIncrement?: boolean;
  /** 值原文（如 `0`、`active`、`CURRENT_TIMESTAMP`，不含引号——字符串由驱动加引号转义）；
   *  undefined/'' = 无默认值。roundtrip 对齐 information_schema 的 COLUMN_DEFAULT（去引号） */
  defaultValue?: string;
  comment?: string;
  ordinal: number;
}

export interface TableSpec {
  name: string;
  comment?: string;
  columns: ColumnSpec[];
  /** @since 表设计器批次 B（交互稿 §12.4~12.6）：缺省 = 不涉及。基线回读（specFromTable）
   *  填充库内现状；驱动 diff 红线——DROP 约束/索引只允许由「基线存在且 spec 移除」生成 */
  uniqueKeys?: UniqueKeySpec[];
  foreignKeys?: ForeignKeySpec[];
  indexes?: IndexSpec[];
}

/** 唯一键（键 Tab）。name 缺省由驱动自动生成（uk_<table>_<n>，截断 63 字符内） */
export interface UniqueKeySpec {
  name?: string;
  columns: string[];
}

/** 外键动作（标准四级；驱动经 capabilities.tableDesign.refActions 声明子集裁剪） */
export type ForeignKeyAction = 'RESTRICT' | 'CASCADE' | 'SET NULL' | 'NO ACTION';

/** 外键（外键 Tab）。name 缺省由驱动自动生成（fk_<table>_<n>）；
 *  首版引用范围限当前库内（refTable 为裸表名，跨库引用后续按方言评估） */
export interface ForeignKeySpec {
  name?: string;
  columns: string[];
  refTable: string;
  refColumns: string[];
  onDelete?: ForeignKeyAction;
  onUpdate?: ForeignKeyAction;
}

/** 二级索引（索引 Tab，独立 CREATE/DROP INDEX 语义；唯一约束归键 Tab）。
 *  name 缺省自动生成（idx_<table>_<n>）；type 由方言裁剪（capabilities.tableDesign.indexTypes） */
export interface IndexSpec {
  name?: string;
  columns: string[];
  unique?: boolean;
  type?: string;
}

/** DDL 语句（语句集内按序执行，失败即停并定位序号） */
export interface DdlStatement {
  sql: string;
  /** true = 含可能丢数据的操作（删列/改类型/删主键等）→ UI 确认分级与红条警示 */
  destructive?: boolean;
}

/** 类型建议项（表结构编辑器列 Tab，@since 表设计器批次 A，交互稿 §12.3）。
 *  方言词表由各驱动独立维护（C-14 同源口径，禁止跨驱动复用）；建议不是白名单——
 *  词表外类型照常手输，合法性由驱动 fail-closed 校验 */
export interface DataTypeOption {
  /** 基名（展示与无参回填），如 BIGINT */
  value: string;
  /** 带形参回填模板，如 varchar() / decimal(,)；缺省 = value 原样回填 */
  template?: string;
}
