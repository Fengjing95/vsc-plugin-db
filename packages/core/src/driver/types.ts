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
  DdlStatement,
  IndexMeta,
  KeyMeta,
  NormalizedType,
  ObjectMeta,
  TableSpec,
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
  /** @since M8-B2：表结构编辑器（概要 §5.9）——true 时必须实现 buildCreateTable/buildAlterTable */
  supportsDdlEditor?: boolean;
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
    /** 字段旁的辅助/风险说明（如 sslInsecure 的证书校验风险，驱动规范 §10）；表单渲染为标题后的 tips 图标（M8） */
    hint?: string;
    /** 折叠分组，如 '高级' */
    group?: string;
    /** @since M8 表单方案 A：高级组内小节标题——同 section 字段归为一个小节、单列渲染 */
    section?: string;
    /** @since M8 表单方案 A：依赖的布尔字段 key——该开关关闭时本项隐藏（值仍随表单提交）；
     *  小节内被引用的布尔字段渲染为「标题行复选框」 */
    toggle?: string;
    /** @since M8 表单方案 A：布尔字段的控件形态——'switch' 渲染为滑动开关（缺省复选框） */
    control?: 'switch';
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
  /** @since M8-B2 表结构编辑器（概要 §5.9；capabilities.supportsDdlEditor = true 时实现）。
   *  语句为方言原文（DDL 不可参数化，驱动规范 §10）；可能丢数据的语句标 destructive */
  buildCreateTable?(db: string, spec: TableSpec): Promise<DdlStatement[]>;
  /** @since M8-B2：驱动自行 diff spec（目标）与 current（Host 实时派生的库内当前结构）；
   *  obj 为目标表现名（重命名时为旧名）；无结构差异返回空数组 */
  buildAlterTable?(db: string, obj: string, spec: TableSpec, current: TableSpec): Promise<DdlStatement[]>;
  openSession?(): Promise<ISession>;
  getCompletionSource(db?: string): Promise<CompletionSource>;
  quoteIdentifier?(name: string): string;
  readonly dialect?: DialectInfo;
}

/** 便捷导出：NormalizedType 在结果集 schema 中以字符串传输 */
export type { NormalizedType };
