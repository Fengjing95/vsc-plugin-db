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
  comment?: string;
  sizeBytes?: number;
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
