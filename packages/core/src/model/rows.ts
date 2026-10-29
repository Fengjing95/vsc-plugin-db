import type { NormalizedType } from './meta';

/** 行定位键：主键列 → 值（编辑定位一律用 RowKey，不用行号） */
export type RowKey = Record<string, unknown>;

export type FilterOp =
  | 'eq'
  | 'ne'
  | 'gt'
  | 'ge'
  | 'lt'
  | 'le'
  | 'like'
  | 'notLike'
  | 'in'
  | 'notIn'
  | 'isNull'
  | 'isNotNull'
  | 'between';

export interface FilterCondition {
  column: string;
  op: FilterOp;
  value?: unknown;
  values?: unknown[];
}

export interface FetchRowsRequest {
  db: string;
  obj: string;
  schema?: string;
  columns?: string[];
  /** 多条件 AND 语义；OR 为 P2 */
  filters?: FilterCondition[];
  sorts?: Array<{ column: string; dir: 'asc' | 'desc' }>;
  /** 全局关键字，驱动负责转义与下推 */
  search?: string;
  /** 用户手写 WHERE / ORDER BY 片段（驱动规范 §4：原样拼接进最终语句，
   *  属用户自撰 SQL 而非数据值，不做转义/参数化；语法或列名错误 → E_VALIDATION） */
  whereSql?: string;
  orderBySql?: string;
  limit: number;
  offset?: number;
  cursor?: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface QueryRequest {
  sql: string;
  db?: string;
  params?: unknown[];
  maxRows: number;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface ResultSet {
  columns: Array<{ name: string; type: NormalizedType }>;
  /** 行式存储，减少 webview 序列化开销 */
  rows: unknown[][];
  rowCount: number;
  totalCount?: number;
  /** 编辑定位键；为空则默认只读 */
  primaryKey?: string[];
  nextCursor?: string;
  affectedRows?: number;
  messages?: string[];
  executionMs: number;
  truncated?: boolean;
  /** @since v0.11.0（ADR D-30）：Host 传输层写入的截断单元格坐标（行内值=预览前缀）；
   *  驱动不产生本字段，实现时无视即可 */
  truncatedCells?: Array<[number, number]>;
}

/** 表格编辑暂存变更集；权威副本在 Extension Host（ADR D-06） */
export interface ChangeSet {
  inserts: Array<{ tempId: string; values: Record<string, unknown> }>;
  updates: Array<{
    rowKey: RowKey;
    original: Record<string, unknown>;
    changes: Record<string, { old: unknown; new: unknown }>;
  }>;
  deletes: Array<{ rowKey: RowKey; original: Record<string, unknown> }>;
}

export interface PreviewItem {
  kind: 'insert' | 'update' | 'delete';
  tempId?: string;
  rowKey?: RowKey;
  /** 参数化语句（占位符形式），与 applyChanges 同源生成 */
  sql: string;
  params?: unknown[];
}

export interface ApplyResult {
  items: Array<{
    kind: 'insert' | 'update' | 'delete';
    tempId?: string;
    rowKey?: RowKey;
    sql: string;
    affectedRows: number;
  }>;
  executionMs: number;
}

export interface CompletionSource {
  keywords: string[];
  functions: string[];
  databases: string[];
  tables: Array<{ name: string; comment?: string }>;
  columns: Array<{ table: string; name: string; comment?: string }>;
  snippets?: Array<{ label: string; body: string; description?: string }>;
}

export interface DialectInfo {
  id: string;
  quote: [string, string];
  /** sql-formatter 方言名 */
  formatter: string;
  keywords: string[];
  functions?: string[];
}
