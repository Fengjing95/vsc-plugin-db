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
