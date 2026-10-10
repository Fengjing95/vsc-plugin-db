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
 *  collection 仅 MongoDB 建库消费（D-19 修订：建库 = 创建首个 collection 隐式建库，SQL 驱动忽略） */
export interface DatabaseSpec {
  name: string;
  charset?: string;
  collation?: string;
  /** @since v0.1.11 修订（D-19）：MongoDB 建库所需的首个 collection 名 */
  collection?: string;
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
}

/** DDL 语句（语句集内按序执行，失败即停并定位序号） */
export interface DdlStatement {
  sql: string;
  /** true = 含可能丢数据的操作（删列/改类型/删主键等）→ UI 确认分级与红条警示 */
  destructive?: boolean;
}
