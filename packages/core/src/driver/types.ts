import type {
  ApplyResult,
  ChangeSet,
  CompletionSource,
  DialectInfo,
  FetchRowsRequest,
  PreviewItem,
  QueryRequest,
  ResultSet,
  RowKey,
} from '../model/rows';
import type {
  ColumnMeta,
  DatabaseMeta,
  IndexMeta,
  KeyMeta,
  NormalizedType,
  ObjectMeta,
} from '../model/meta';
import type { DriverError } from './errors';

export type NodeLevel =
  | 'connection'
  | 'database'
  | 'folder'
  | 'table'
  | 'view'
  | 'collection'
  | 'column'
  | 'key'
  | 'index';

export interface DriverCapabilities {
  supportsSQL: boolean;
  /** applyChanges 可否单事务 */
  supportsTransaction: boolean;
  supportsInteractiveTransaction: boolean;
  supportsMultipleDatabases: boolean;
  supportsMultiStatement: boolean;
  /** 真正响应 AbortSignal（契约测试强制） */
  supportsCancel: boolean;
  supportsDdl: boolean;
  hierarchy: NodeLevel[];
  editable: boolean;
  pagination: 'offset' | 'cursor' | 'none';
  lazyCell?: boolean;
}

/** 最小 Disposable：core 不依赖 vscode 运行时，便于单测与未来进程隔离（ADR D-05） */
export interface Disposable {
  dispose(): void | Promise<void>;
}

export interface ConnectionConfig {
  id: string;
  name: string;
  driverId: string;
  group?: string;
  color?: string;
  readOnly?: boolean;
  env?: 'dev' | 'test' | 'prod';
  /** 驱动专属连接参数；密码不入此结构（存 SecretStorage，经 secret 参数传递） */
  options: Record<string, unknown>;
  ssl?: Record<string, unknown>;
  ssh?: Record<string, unknown>;
  secretRef: string;
}

export interface TestResult {
  ok: boolean;
  latencyMs?: number;
  serverVersion?: string;
  error?: DriverError;
}

/** 连接表单 schema（驱动开发规范 §3.1）；type=password 字段由 core 拦截入 SecretStorage */
export interface FormSchema {
  fields: Array<{
    key: string;
    label: string;
    type: 'string' | 'number' | 'boolean' | 'password' | 'select' | 'file' | 'textarea';
    required?: boolean;
    default?: unknown;
    options?: Array<{ label: string; value: unknown }>;
    placeholder?: string;
    /** 字段旁的辅助/风险说明（如 sslInsecure 的证书校验风险，驱动规范 §10）；表单渲染在控件下方 */
    hint?: string;
    /** 折叠分组，如 '高级' */
    group?: string;
    validator?: 'port' | 'host' | 'path' | 'regex';
    validationRegex?: string;
  }>;
}

export interface IDatabaseDriver {
  readonly id: string;
  readonly displayName: string;
  readonly icon?: string;
  readonly apiVersion: number;
  readonly capabilities: DriverCapabilities;
  getConnectionFormSchema(): FormSchema;
  testConnection(cfg: ConnectionConfig, secret: string): Promise<TestResult>;
  connect(cfg: ConnectionConfig, secret: string): Promise<IConnection>;
}

export interface ISession extends Disposable {
  execute(req: QueryRequest): Promise<ResultSet[]>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

export interface IConnection extends Disposable {
  readonly connectionId: string;
  /** 失败抛 E_CONN；用于空闲保活 */
  ping(): Promise<void>;
  listDatabases(): Promise<DatabaseMeta[]>;
  listObjects(db: string): Promise<ObjectMeta[]>;
  listColumns(db: string, obj: string): Promise<ColumnMeta[]>;
  listIndexes?(db: string, obj: string): Promise<IndexMeta[]>;
  listKeys?(db: string, obj: string): Promise<KeyMeta[]>;
  fetchRows(req: FetchRowsRequest): Promise<ResultSet>;
  query(req: QueryRequest): Promise<ResultSet[]>;
  /** 变更预览：与 applyChanges 同源生成语句，保证“预览即执行” */
  previewChanges(db: string, obj: string, cs: ChangeSet): Promise<PreviewItem[]>;
  applyChanges(db: string, obj: string, cs: ChangeSet): Promise<ApplyResult>;
  /** 大字段按需拉取（capabilities.lazyCell 时实现） */
  fetchCell?(db: string, obj: string, rowKey: RowKey, column: string): Promise<string>;
  /** DDL 生成（capabilities.supportsDdl = true 时实现，@since apiVersion 1） */
  getDdl?(db: string, obj: string): Promise<string>;
  openSession?(): Promise<ISession>;
  getCompletionSource(db?: string): Promise<CompletionSource>;
  quoteIdentifier?(name: string): string;
  readonly dialect?: DialectInfo;
}

/** 便捷导出：NormalizedType 在结果集 schema 中以字符串传输 */
export type { NormalizedType };
