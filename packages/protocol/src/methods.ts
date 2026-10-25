import { z } from 'zod';
import type { AiErrorCode, DriverErrorCode } from '@db-explorer/core';

export const RPC_PROTOCOL_VERSION = 1;

/** 方法名注册表（概要设计 7.4.2） */
export const RpcMethods = {
  handshake: 'sys.handshake',
  fetchRows: 'table.fetchRows',
  editChanges: 'table.editChanges',
  previewChanges: 'table.previewChanges',
  applyChanges: 'table.applyChanges',
  revertChanges: 'table.revertChanges',
  getDdl: 'table.getDdl',
  exportRun: 'export.run',
  exportCancel: 'export.cancel',
  connMeta: 'conn.getMeta',
  connSchema: 'conn.getSchema',
  connTest: 'conn.test',
  connDbOptions: 'conn.dbOptions',
  connSave: 'conn.save',
  consoleState: 'console.getState',
  consoleExecute: 'console.execute',
  consoleCancel: 'console.cancel',
  consoleResolveBanner: 'console.resolveBanner',
  consoleExport: 'console.export',
  consoleClose: 'console.close',
  ddlLoad: 'ddl.load',
  ddlPreview: 'ddl.preview',
  ddlExecute: 'ddl.execute',
  ddlClose: 'ddl.close',
  /** @since 表设计器批次 B：外键 Tab 引用目标选择（引用表清单 / 引用表列清单） */
  ddlRefTables: 'ddl.refTables',
  ddlRefColumns: 'ddl.refColumns',
  /** @since v0.2.21（M8-DBDDL / D-19）：库级 DDL（新建/编辑库弹窗；删除走树命令无 RPC） */
  dbddlLoad: 'dbddl.load',
  dbddlPreview: 'dbddl.preview',
  dbddlExecute: 'dbddl.execute',
  dbddlClose: 'dbddl.close',
  /** @since M8-ER（概要 §5.11 / D-22）：ER 图查看（库级关系图；节点双击打开表格视图） */
  erGraph: 'er.getGraph',
  erOpenTable: 'er.openTable',
  /** @since M9-AI（概要 §5.12 / D-24）：AI 辅助——设置读写/连通测试 + 错误修复建议（生成与
   *  解释走编辑器 Host 命令 + console item 推送，不经 RPC）；openSettings 供 webview 引导去配置 */
  aiGetSettings: 'ai.getSettings',
  aiSaveSettings: 'ai.saveSettings',
  aiTestSettings: 'ai.testSettings',
  aiFixError: 'ai.fixError',
  aiApplyFix: 'ai.applyFix',
  aiOpenSettings: 'ai.openSettings',
  /** 解释 Tab 错误态「重试」：复跑该 Console 最近一次 AI 解释（入参 Host 侧缓存） */
  aiRetryExplain: 'ai.retryExplain',
  /** @since 设置中心（交互稿 §16）：代理编辑 VSCode settings（key 白名单 fail-closed，
   *  仅允许 dbExplorer.* 自有配置键）+ VSCode 设置定位 + 关于页动作（枚举分发） */
  settingsGet: 'settings.get',
  settingsUpdate: 'settings.update',
  settingsOpenInVscode: 'settings.openInVscodeSettings',
  settingsHubAction: 'settings.hubAction',
  copyText: 'sys.copyText',
  pickFile: 'sys.pickFile',
  /** @since 单元格查看器批次（交互稿 §4.6）：大字段按需拉取（capabilities.lazyCell 驱动声明后才走 RPC） */
  cellFetch: 'cell.fetch',
  /** @since 单元格查看器批次：二进制查看器「另存为文件」（SaveDialog + 写盘在 Host 侧） */
  sysSaveFile: 'sys.saveFile',
} as const;

/** Host → Webview 单向推送事件（概要设计 7.4.2） */
export const RpcEvents = {
  exportProgress: 'evt:export.progress',
  exportDone: 'evt:export.done',
  changesetUpdated: 'evt:changeset.updated',
  rowError: 'evt:row.error',
  consoleBanner: 'evt:console.banner',
  consoleRunning: 'evt:console.running',
  consoleUpdated: 'evt:console.updated',
  consoleActivated: 'evt:console.activated',
  /** @since M9-AI：AI 解释流式推送（ai=null 表示该 Console 的 AI 解释已清除） */
  consoleAi: 'evt:console.ai',
  /** @since M9-AI 实机反馈：编辑器内「✨ 修复建议」入口 → Webview 直接打开修复 Modal */
  consoleFixRequest: 'evt:console.fixRequest',
} as const;

/** RPC 层错误码：复用 DriverErrorCode + AiErrorCode（D-24 与驱动码并列），仅另加 E_UNKNOWN_METHOD / E_STATE_LOST */
export type RpcErrorCode = DriverErrorCode | AiErrorCode | 'E_UNKNOWN_METHOD' | 'E_STATE_LOST';

// ── sys.handshake ──────────────────────────────────────────────
export const HandshakeParamsSchema = z.object({
  stateId: z.string().nullable().optional(),
});
export type HandshakeParams = z.infer<typeof HandshakeParamsSchema>;

export const RowKeySchema = z.record(z.string(), z.unknown());
export type RowKeyPayload = z.infer<typeof RowKeySchema>;

/** 值编码契约（概要设计 §4.4）下的结构化 ChangeSet 快照 */
export const ChangeSetSnapshotSchema = z.object({
  inserts: z.array(z.object({ tempId: z.string(), values: z.record(z.string(), z.unknown()) })),
  updates: z.array(
    z.object({
      rowKey: RowKeySchema,
      original: z.record(z.string(), z.unknown()),
      changes: z.record(z.string(), z.object({ old: z.unknown(), new: z.unknown() })),
    }),
  ),
  deletes: z.array(z.object({ rowKey: RowKeySchema, original: z.record(z.string(), z.unknown()) })),
});
export type ChangeSetSnapshot = z.infer<typeof ChangeSetSnapshotSchema>;

/** Host 计算的编辑权限（UI 置灰只是第一道防线，Host 层仍 fail-closed） */
export const EditPermissionSchema = z.object({
  enabled: z.boolean(),
  reason: z.string().optional(),
});
export type EditPermission = z.infer<typeof EditPermissionSchema>;



// ── table.fetchRows ────────────────────────────────────────────
/** 与 core FilterOp 对齐（驱动开发规范 §4）；regex 不支持（跨库不可移植） */
export const FilterOpSchema = z.enum([
  'eq', 'ne', 'gt', 'ge', 'lt', 'le',
  'like', 'notLike', 'in', 'notIn',
  'isNull', 'isNotNull', 'between',
]);
export type FilterOpPayload = z.infer<typeof FilterOpSchema>;

/** 多条件 AND 语义；单值 op 用 value，in/notIn/between 用 values（between: [low, high]） */
export const FilterConditionSchema = z.object({
  column: z.string().min(1),
  op: FilterOpSchema,
  value: z.unknown().optional(),
  values: z.array(z.unknown()).optional(),
});
export type FilterConditionPayload = z.infer<typeof FilterConditionSchema>;

export const SortSpecSchema = z.object({
  column: z.string().min(1),
  dir: z.enum(['asc', 'desc']),
});
export type SortSpecPayload = z.infer<typeof SortSpecSchema>;

/** 筛选构造器草稿（UI 形状，回放需保留原始输入而非下推条件） */
export const FilterDraftSchema = z.object({
  id: z.string(),
  column: z.string().min(1),
  op: FilterOpSchema,
  value: z.string(),
  value2: z.string(),
});
export type FilterDraftPayload = z.infer<typeof FilterDraftSchema>;

/** Webview 上行的视图状态（崩溃恢复时随快照回放，概要设计 §5.4.5）。
 *  drafts 为旧版筛选构造器遗留（v0.1.3 起由 where/orderBy 自由条件取代，保持必填恒空以兼容旧快照） */
export const ViewUiStateSchema = z.object({
  page: z.number().int().min(0),
  pageSize: z.number().int().positive(),
  sorts: z.array(SortSpecSchema),
  search: z.string(),
  drafts: z.array(FilterDraftSchema),
  /** 用户手写的 WHERE / ORDER BY 片段（拼接进最终语句，驱动规范 §4） */
  where: z.string().max(2000).optional(),
  orderBy: z.string().max(500).optional(),
});
export type ViewUiState = z.infer<typeof ViewUiStateSchema>;

export const HandshakeResultSchema = z.object({
  protocolVersion: z.number(),
  viewId: z.string(),
  params: z.record(z.string(), z.string()),
  changeSet: ChangeSetSnapshotSchema,
  uiState: ViewUiStateSchema.optional(),
  edit: EditPermissionSchema,
  /** 驱动能力子集（概要 §5.1.3：UI 按 capabilities 降级渲染，不感知数据库类型）。
   *  来自 driver.capabilities（registry 侧读取，握手不触发建连，D-10）。
   *  pagination：分页模型下行（M7 cursor 透传），缺省按 offset 处理（旧驱动兼容） */
  capabilities: z.object({
    supportsSQL: z.boolean(),
    supportsDdl: z.boolean(),
    pagination: z.enum(['offset', 'cursor', 'none']).optional(),
    /** @since 单元格查看器批次：驱动声明大字段按需拉取（fetchCell）；缺省 = 查看器直接用行内值 */
    lazyCell: z.boolean().optional(),
  }),
});
export type HandshakeResult = z.infer<typeof HandshakeResultSchema>;

export const FetchRowsParamsSchema = z.object({
  connId: z.string().min(1),
  db: z.string().min(1),
  obj: z.string().min(1),
  limit: z.number().int().positive().max(5000),
  offset: z.number().int().min(0).optional(),
  /** opaque 分页游标（pagination=cursor 驱动；来自上一页 ResultSet.nextCursor）。
   *  携带游标时 offset 必须缺省（M7 cursor 透传，深页免 O(offset) 重扫） */
  cursor: z.string().optional(),
  /** 列投影（列显示/隐藏），缺省 = 全部列 */
  columns: z.array(z.string().min(1)).optional(),
  filters: z.array(FilterConditionSchema).max(20).optional(),
  sorts: z.array(SortSpecSchema).max(5).optional(),
  /** 全局关键字，Host 侧经驱动下推（LIKE/全文由驱动决定，须转义） */
  search: z.string().max(256).optional(),
  /** 用户手写 WHERE 片段（拼接进最终语句，驱动规范 §4：原样拼接、语法/列名错误报 E_VALIDATION） */
  whereSql: z.string().max(2000).optional(),
  /** 用户手写 ORDER BY 片段（追加在列头排序之后） */
  orderBySql: z.string().max(500).optional(),
});
export type FetchRowsParams = z.infer<typeof FetchRowsParamsSchema>;

export const ResultSetSchema = z.object({
  columns: z.array(z.object({ name: z.string(), type: z.string() })),
  rows: z.array(z.array(z.unknown())),
  rowCount: z.number().int(),
  totalCount: z.number().int().optional(),
  primaryKey: z.array(z.string()).optional(),
  /** pagination=cursor 驱动的下一页游标（opaque；undefined = 已到尽头） */
  nextCursor: z.string().optional(),
  executionMs: z.number(),
  truncated: z.boolean().optional(),
});
export type ResultSetPayload = z.infer<typeof ResultSetSchema>;

// ── table.editChanges / previewChanges / applyChanges / revertChanges ──
// ChangeSet 权威副本在 Host（ADR D-06）：Webview 以编辑操作上行合并，
// 预览/提交不传 ChangeSet，由 Host 按视图取权威副本下发驱动。

/** 编辑操作（与 core EditOp 对齐） */
export const EditOpSchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('setCell'),
    rowKey: RowKeySchema,
    column: z.string().min(1),
    old: z.unknown(),
    new: z.unknown(),
  }),
  z.object({
    op: z.literal('addRow'),
    tempId: z.string().min(1),
    values: z.record(z.string(), z.unknown()),
  }),
  z.object({
    op: z.literal('setInsertCell'),
    tempId: z.string().min(1),
    column: z.string().min(1),
    value: z.unknown(),
  }),
  z.object({ op: z.literal('removeRow'), tempId: z.string().min(1) }),
  z.object({ op: z.literal('markDelete'), rowKey: RowKeySchema }),
  z.object({ op: z.literal('unmarkDelete'), rowKey: RowKeySchema }),
  z.object({ op: z.literal('revertRow'), rowKey: RowKeySchema }),
]);
export type EditOpPayload = z.infer<typeof EditOpSchema>;

export const EditChangesParamsSchema = z.object({
  connId: z.string().min(1),
  db: z.string().min(1),
  obj: z.string().min(1),
  ops: z.array(EditOpSchema).max(2000),
  uiState: ViewUiStateSchema.optional(),
});
export type EditChangesParams = z.infer<typeof EditChangesParamsSchema>;

export const EditChangesResultSchema = z.object({
  counts: z.object({
    inserts: z.number().int().min(0),
    updates: z.number().int().min(0),
    deletes: z.number().int().min(0),
  }),
});
export type EditChangesResult = z.infer<typeof EditChangesResultSchema>;

/** 预览项（驱动 PreviewItem：与 applyChanges 同源生成，预览即执行） */
export const PreviewItemSchema = z.object({
  kind: z.enum(['insert', 'update', 'delete']),
  tempId: z.string().optional(),
  rowKey: RowKeySchema.optional(),
  sql: z.string(),
  params: z.array(z.unknown()).optional(),
});
export type PreviewItemPayload = z.infer<typeof PreviewItemSchema>;

export const PreviewChangesParamsSchema = z.object({
  connId: z.string().min(1),
  db: z.string().min(1),
  obj: z.string().min(1),
});
export type PreviewChangesParams = z.infer<typeof PreviewChangesParamsSchema>;

export const PreviewChangesResultSchema = z.object({
  items: z.array(PreviewItemSchema),
});
export type PreviewChangesResult = z.infer<typeof PreviewChangesResultSchema>;

export const ApplyChangesParamsSchema = PreviewChangesParamsSchema;
export type ApplyChangesParams = z.infer<typeof ApplyChangesParamsSchema>;

export const ApplyChangesResultSchema = z.object({
  items: z.array(
    z.object({
      kind: z.enum(['insert', 'update', 'delete']),
      tempId: z.string().optional(),
      rowKey: RowKeySchema.optional(),
      sql: z.string(),
      affectedRows: z.number().int(),
    }),
  ),
  executionMs: z.number(),
});
export type ApplyChangesResult = z.infer<typeof ApplyChangesResultSchema>;

export const RevertScopeSchema = z.discriminatedUnion('scope', [
  z.object({ scope: z.literal('all') }),
  z.object({ scope: z.literal('row'), rowKey: RowKeySchema }),
  z.object({ scope: z.literal('insert'), tempId: z.string().min(1) }),
]);
export type RevertScope = z.infer<typeof RevertScopeSchema>;

export const RevertChangesParamsSchema = z.object({
  connId: z.string().min(1),
  db: z.string().min(1),
  obj: z.string().min(1),
  target: RevertScopeSchema,
});
export type RevertChangesParams = z.infer<typeof RevertChangesParamsSchema>;

export const RevertChangesResultSchema = EditChangesResultSchema;
export type RevertChangesResult = EditChangesResult;

// ── table.getDdl（表格视图查看当前表 DDL；驱动 getDdl 未实现时报 E_UNSUPPORTED）──
export const GetDdlParamsSchema = PreviewChangesParamsSchema;
export type GetDdlParams = z.infer<typeof GetDdlParamsSchema>;

export const GetDdlResultSchema = z.object({
  ddl: z.string(),
});
export type GetDdlResult = z.infer<typeof GetDdlResultSchema>;

/** evt:changeset.updated 负载（工具栏计数与跨端一致） */
export const ChangesetUpdatedEventSchema = z.object({
  counts: z.object({
    inserts: z.number().int().min(0),
    updates: z.number().int().min(0),
    deletes: z.number().int().min(0),
  }),
});
export type ChangesetUpdatedEvent = z.infer<typeof ChangesetUpdatedEventSchema>;

/** evt:row.error 负载（提交失败的错误行定位，交互稿 §4.1 error 态） */
export const RowErrorEventSchema = z.object({
  kind: z.enum(['insert', 'update', 'delete']).optional(),
  tempId: z.string().optional(),
  rowKey: RowKeySchema.optional(),
  code: z.string(),
  message: z.string(),
});
export type RowErrorEvent = z.infer<typeof RowErrorEventSchema>;

// ── export.run / export.cancel（概要设计 5.7：Host 流式写，不进 Webview）──
// ndjson/markdown/insert @since 单元格查看器批次②（§5.7 P2 收口）
export const ExportFormatSchema = z.enum(['csv', 'json', 'xlsx', 'ndjson', 'markdown', 'insert']);
export type ExportFormat = z.infer<typeof ExportFormatSchema>;

export const ExportScopeSchema = z.enum(['page', 'result']);
export type ExportScope = z.infer<typeof ExportScopeSchema>;

export const ExportRunParamsSchema = z.object({
  connId: z.string().min(1),
  db: z.string().min(1),
  obj: z.string().min(1),
  format: ExportFormatSchema,
  scope: ExportScopeSchema,
  /** scope=page 时的页参数（与 table.fetchRows 一致的取数形状） */
  limit: z.number().int().positive().max(5000).optional(),
  offset: z.number().int().min(0).optional(),
  columns: z.array(z.string().min(1)).optional(),
  filters: z.array(FilterConditionSchema).max(20).optional(),
  sorts: z.array(SortSpecSchema).max(5).optional(),
  search: z.string().max(256).optional(),
  /** 与 table.fetchRows 同语义的用户手写片段（导出所见即所得） */
  whereSql: z.string().max(2000).optional(),
  orderBySql: z.string().max(500).optional(),
});
export type ExportRunParams = z.infer<typeof ExportRunParamsSchema>;

/** export.run 回执（M8 后台化 §5.7/#16）：调度即返回，导出在 Host 后台继续；
 *  canceled = 用户取消保存对话框（exportId 为空串） */
export const ExportRunResultSchema = z.object({
  exportId: z.string(),
  canceled: z.boolean().optional(),
});
export type ExportRunResult = z.infer<typeof ExportRunResultSchema>;

export const ExportCancelParamsSchema = z.object({
  exportId: z.string().min(1),
});
export type ExportCancelParams = z.infer<typeof ExportCancelParamsSchema>;

/** evt:export.progress 负载 */
export const ExportProgressEventSchema = z.object({
  exportId: z.string(),
  rows: z.number().int(),
  bytes: z.number().int(),
});
export type ExportProgressEvent = z.infer<typeof ExportProgressEventSchema>;

/** evt:export.done 负载（M8 后台化）：后台任务终态回执——成功/取消/失败三路都发，
 *  Webview 据此清除进度 chip；失败详情 Host 侧已 Toast，error 仅为结构化留档 */
export const ExportDoneEventSchema = z.object({
  exportId: z.string(),
  rows: z.number().int(),
  bytes: z.number().int(),
  canceled: z.boolean().optional(),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
    })
    .optional(),
});
export type ExportDoneEvent = z.infer<typeof ExportDoneEventSchema>;

// ── conn.getMeta / conn.getSchema ─────────────────────────────
export const DriverSummarySchema = z.object({
  id: z.string(),
  displayName: z.string(),
});
export type DriverSummary = z.infer<typeof DriverSummarySchema>;

export const FormFieldSchema = z.object({
  key: z.string(),
  label: z.string(),
  type: z.enum(['string', 'number', 'boolean', 'password', 'select', 'file', 'textarea']),
  required: z.boolean().optional(),
  default: z.unknown().optional(),
  options: z.array(z.object({ label: z.string(), value: z.unknown() })).optional(),
  placeholder: z.string().optional(),
  /** 字段旁的辅助/风险说明（驱动 FormSchema 透传，表单渲染在控件下方） */
  hint: z.string().optional(),
  group: z.string().optional(),
  /** @since M8 表单方案 A：高级组内的小节标题（同 section 的字段按小节分行渲染） */
  section: z.string().optional(),
  /** @since M8 表单方案 A：依赖的布尔开关字段 key——该开关关闭时本项隐藏（如 sslInsecure 依赖 ssl） */
  toggle: z.string().optional(),
  /** @since M8-PG B5：动态选项——'databases' = 字段聚焦时经 conn.dbOptions 拉取库列表作输入建议
   *  （仅 string 字段；输入保持自由，失败无感降级为纯手输） */
  dynamicOptions: z.enum(['databases']).optional(),
  validator: z.enum(['port', 'host', 'path', 'regex']).optional(),
  validationRegex: z.string().optional(),
});
export type FormFieldPayload = z.infer<typeof FormFieldSchema>;

export const FormSchemaSchema = z.object({
  fields: z.array(FormFieldSchema),
});
export type FormSchemaPayload = z.infer<typeof FormSchemaSchema>;

/** 连接元数据：密码永不回传，仅 hasSecret 标记 */
export const ConnectionMetaSchema = z.object({
  connId: z.string(),
  name: z.string(),
  driverId: z.string(),
  env: z.enum(['dev', 'test', 'prod']).nullable(),
  group: z.string().nullable(),
  color: z.string().nullable(),
  readOnly: z.boolean(),
  options: z.record(z.string(), z.unknown()),
  hasSecret: z.boolean(),
});
export type ConnectionMeta = z.infer<typeof ConnectionMetaSchema>;

export const ConnMetaParamsSchema = z.object({
  connId: z.string().nullable().optional(),
});

export const ConnMetaResultSchema = z.object({
  drivers: z.array(DriverSummarySchema),
  config: ConnectionMetaSchema.nullable(),
  schema: FormSchemaSchema,
});
export type ConnMetaResult = z.infer<typeof ConnMetaResultSchema>;

export const ConnSchemaParamsSchema = z.object({
  driverId: z.string().min(1),
});
export const ConnSchemaResultSchema = z.object({
  schema: FormSchemaSchema,
});
export type ConnSchemaResult = z.infer<typeof ConnSchemaResultSchema>;

// ── conn.test ──────────────────────────────────────────────────
export const ConnTestParamsSchema = z.object({
  driverId: z.string().min(1),
  options: z.record(z.string(), z.unknown()),
  /** null = 沿用已存密码（编辑态留空）；明文仅在请求瞬间经过，不落任何存储 */
  password: z.string().nullable(),
  connId: z.string().nullable().optional(),
});
export type ConnTestParams = z.infer<typeof ConnTestParamsSchema>;

export const ConnTestResultSchema = z.object({
  ok: z.boolean(),
  latencyMs: z.number().optional(),
  serverVersion: z.string().optional(),
  errorCode: z.string().optional(),
  errorMessage: z.string().optional(),
});
export type ConnTestResult = z.infer<typeof ConnTestResultSchema>;

// ── conn.dbOptions（M8-PG B5：表单「默认库」聚焦建议）─────────────────────────
export const ConnDbOptionsParamsSchema = z.object({
  driverId: z.string().min(1),
  options: z.record(z.string(), z.unknown()),
  /** null = 沿用已存密码（编辑态留空）；明文仅在请求瞬间经过，不落任何存储（同 conn.test） */
  password: z.string().nullable(),
  connId: z.string().nullable().optional(),
});
export type ConnDbOptionsParams = z.infer<typeof ConnDbOptionsParamsSchema>;

/** 失败不产生 error 帧：Host 吞错恒回 { databases: [] }，Webview 无感降级为自由手输 */
export const ConnDbOptionsResultSchema = z.object({
  databases: z.array(z.string()),
});
export type ConnDbOptionsResult = z.infer<typeof ConnDbOptionsResultSchema>;

// ── conn.save ──────────────────────────────────────────────────
export const ConnSaveParamsSchema = z.object({
  connId: z.string().optional(),
  name: z.string().min(1),
  driverId: z.string().min(1),
  env: z.enum(['dev', 'test', 'prod']).nullable().optional(),
  group: z.string().nullable().optional(),
  color: z.string().nullable().optional(),
  readOnly: z.boolean().optional(),
  options: z.record(z.string(), z.unknown()),
  /** null = 沿用已存密码；非空 = 设置/覆盖 */
  password: z.string().nullable(),
});
export type ConnSaveParams = z.infer<typeof ConnSaveParamsSchema>;

export const ConnSaveResultSchema = z.object({
  connId: z.string(),
});
export type ConnSaveResult = z.infer<typeof ConnSaveResultSchema>;

// ── console.*（M5 SQL Console：概要设计 5.5 / 7.4.2，交互稿 §7）────────────
// 编辑器（原生 TextEditor）驱动执行走 VSCode 命令（Host 侧 ConsoleService），
// 结果面板 Webview 经以下方法取态/确认/取消/导出，执行结果经 evt 推送。

/** 单语句执行项：SELECT 语句携带 resultSet 生成“结果 N”Tab；非 SELECT 进“消息”Tab（交互稿 §7.3） */
export const ConsoleRunItemSchema = z.object({
  seq: z.number().int().min(1),
  sql: z.string(),
  resultSet: ResultSetSchema.optional(),
  affectedRows: z.number().int().optional(),
  messages: z.array(z.string()).optional(),
  executionMs: z.number(),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
    })
    .optional(),
});
export type ConsoleRunItem = z.infer<typeof ConsoleRunItemSchema>;

export const ConsoleRunSchema = z.object({
  consoleId: z.string(),
  runId: z.string(),
  startedAt: z.number(),
  durationMs: z.number(),
  /** running = 执行中（逐语句增量推送） */
  status: z.enum(['running', 'ok', 'error', 'canceled']),
  /** 横幅“仍要执行”覆盖记录（仅本地日志用，交互稿 §7.4） */
  dangerOverridden: z.boolean().optional(),
  /** @since M9-AI：本轮执行来自有文档来源的入口（Ctrl+Enter / CodeLens / 选区）——
   *  消息 Tab 错误 item 据此显隐「✨ 修复建议」（历史重跑/结果面板重跑无文档来源不显示） */
  documentBound: z.boolean().optional(),
  items: z.array(ConsoleRunItemSchema),
});
export type ConsoleRun = z.infer<typeof ConsoleRunSchema>;

/** 危险语句横幅（交互稿 §7.4）：面板顶部内联 [仍要执行][取消] */
export const ConsoleBannerSchema = z.object({
  bannerId: z.string(),
  reasons: z.array(z.string().min(1)).min(1),
  sql: z.string(),
});
export type ConsoleBanner = z.infer<typeof ConsoleBannerSchema>;

/** @since M9-AI（概要 §5.12 / 交互稿 §15.3）：Console 的最近一次 AI 解释——
 *  每 Console 单条（新解释整体替换旧解释）；running 态 content 为已流式收到的部分文本 */
export const ConsoleAiSchema = z.object({
  seq: z.number().int().min(1),
  status: z.enum(['running', 'done', 'error']),
  /** Markdown 文本（流式追加）；error 态为已收到的前缀（可为空） */
  content: z.string(),
  errorCode: z.string().optional(),
  errorMessage: z.string().optional(),
});
export type ConsoleAi = z.infer<typeof ConsoleAiSchema>;

export const ConsoleStateParamsSchema = z.object({  /** 空 = Host 解析为「最近执行的 Console」（底部面板单例视图的引导路径） */
  consoleId: z.string(),
});
export type ConsoleStateParams = z.infer<typeof ConsoleStateParamsSchema>;

/** 面板引导（含 Webview 重载恢复：最近一次运行 / 悬挂横幅 / 执行中状态）。
 *  consoleId 回传实际绑定的 Console（底部面板共享单例视图，多 Console 间切换依据）。 */
export const ConsoleStateResultSchema = z.object({
  consoleId: z.string(),
  bound: z.boolean(),
  connLabel: z.string().optional(),
  db: z.string().nullable().optional(),
  running: z
    .object({
      runId: z.string(),
      total: z.number().int().min(1),
    })
    .optional(),
  banner: ConsoleBannerSchema.nullable().optional(),
  run: ConsoleRunSchema.nullable().optional(),
  /** @since M9-AI：该 Console 的最近一次 AI 解释（重载恢复；null/缺省 = 无） */
  ai: ConsoleAiSchema.nullable().optional(),
});
export type ConsoleStateResult = z.infer<typeof ConsoleStateResultSchema>;

export const ConsoleExecuteParamsSchema = z.object({
  consoleId: z.string().min(1),
  sql: z.string().min(1).max(200_000),
});
export type ConsoleExecuteParams = z.infer<typeof ConsoleExecuteParamsSchema>;

export const ConsoleCancelParamsSchema = z.object({
  consoleId: z.string().min(1),
});
export type ConsoleCancelParams = z.infer<typeof ConsoleCancelParamsSchema>;

export const ConsoleResolveBannerParamsSchema = z.object({
  consoleId: z.string().min(1),
  bannerId: z.string().min(1),
  action: z.enum(['proceed', 'cancel']),
});
export type ConsoleResolveBannerParams = z.infer<typeof ConsoleResolveBannerParamsSchema>;

export const ConsoleExportParamsSchema = z.object({
  consoleId: z.string().min(1),
  /** 结果 Tab 对应的语句序号（ConsoleRunItem.seq） */
  itemSeq: z.number().int().min(1),
  format: ExportFormatSchema,
});
export type ConsoleExportParams = z.infer<typeof ConsoleExportParamsSchema>;

export const ConsoleExportResultSchema = z.object({
  filePath: z.string(),
  rows: z.number().int(),
  bytes: z.number().int(),
  canceled: z.boolean().optional(),
});
export type ConsoleExportResult = z.infer<typeof ConsoleExportResultSchema>;

export const ConsoleCloseParamsSchema = z.object({
  consoleId: z.string().min(1),
});
export type ConsoleCloseParams = z.infer<typeof ConsoleCloseParamsSchema>;

// ── ddl.*（M8-B2 表结构编辑器，概要设计 §5.9）────────────────────────────
// 列名/类型合法性由驱动 fail-closed 校验（DDL 不可参数化，驱动规范 §10），前端仅即时提示。

export const ColumnSpecSchema = z.object({
  name: z.string().min(1).max(128),
  dataType: z.string().min(1).max(256),
  nullable: z.boolean(),
  isPrimaryKey: z.boolean(),
  autoIncrement: z.boolean().optional(),
  defaultValue: z.string().max(512).optional(),
  comment: z.string().max(1024).optional(),
  ordinal: z.number().int().min(1),
});
export type ColumnSpecPayload = z.infer<typeof ColumnSpecSchema>;

// ── 键 / 外键 / 索引（表设计器批次 B，交互稿 §12.4~12.6；core 先行此处镜像，P-41）────

export const UniqueKeySpecSchema = z.object({
  name: z.string().min(1).max(128).optional(),
  columns: z.array(z.string().min(1).max(128)).min(1).max(32),
});
export type UniqueKeySpecPayload = z.infer<typeof UniqueKeySpecSchema>;

export const ForeignKeySpecSchema = z.object({
  name: z.string().min(1).max(128).optional(),
  columns: z.array(z.string().min(1).max(128)).min(1).max(32),
  refTable: z.string().min(1).max(128),
  refColumns: z.array(z.string().min(1).max(128)).min(1).max(32),
  onDelete: z.enum(['RESTRICT', 'CASCADE', 'SET NULL', 'NO ACTION']).optional(),
  onUpdate: z.enum(['RESTRICT', 'CASCADE', 'SET NULL', 'NO ACTION']).optional(),
});
export type ForeignKeySpecPayload = z.infer<typeof ForeignKeySpecSchema>;

export const IndexSpecSchema = z.object({
  name: z.string().min(1).max(128).optional(),
  columns: z.array(z.string().min(1).max(128)).min(1).max(32),
  unique: z.boolean().optional(),
  type: z.string().max(32).optional(),
});
export type IndexSpecPayload = z.infer<typeof IndexSpecSchema>;

/** 表设计器 Tab 能力（交互稿 §12.2；驱动 capabilities.tableDesign 经 ddl.load 下发） */
export const TableDesignFeaturesSchema = z.object({
  uniqueKeys: z.boolean().optional(),
  foreignKeys: z.boolean().optional(),
  foreignKeyAlter: z.boolean().optional(),
  indexes: z.boolean().optional(),
  indexTypes: z.array(z.string().min(1).max(32)).max(16).optional(),
  refActions: z.array(z.string().min(1).max(16)).max(8).optional(),
});
export type TableDesignFeaturesPayload = z.infer<typeof TableDesignFeaturesSchema>;

export const TableSpecSchema = z.object({
  name: z.string().min(1).max(128),
  comment: z.string().max(2048).optional(),
  columns: z.array(ColumnSpecSchema).max(256),
  uniqueKeys: z.array(UniqueKeySpecSchema).max(64).optional(),
  foreignKeys: z.array(ForeignKeySpecSchema).max(64).optional(),
  indexes: z.array(IndexSpecSchema).max(128).optional(),
});
export type TableSpecPayload = z.infer<typeof TableSpecSchema>;

export const DdlStatementSchema = z.object({
  sql: z.string().min(1).max(100_000),
  /** true = 含可能丢数据的操作（删列/改类型/删主键等）→ 确认分级与红条警示 */
  destructive: z.boolean().optional(),
});
export type DdlStatementPayload = z.infer<typeof DdlStatementSchema>;

export const DdlLoadParamsSchema = z.object({
  connId: z.string().min(1),
  db: z.string().min(1),
  /** 缺省 = 新建表（create 态，spec 为 null）；提供 = 修改表结构（载入当前结构） */
  obj: z.string().min(1).optional(),
});
export type DdlLoadParams = z.infer<typeof DdlLoadParamsSchema>;

/** @since 表设计器批次 A：列 Tab 类型建议项（方言词表，交互稿 §12.3）。template 为带形参
 *  回填模板（如 varchar() / decimal(,)，回填后光标定位到第一个逗号或右括号前）；缺省 = value 原样回填 */
export const DataTypeOptionSchema = z.object({
  value: z.string().min(1).max(128),
  template: z.string().min(1).max(128).optional(),
});
export type DataTypeOptionPayload = z.infer<typeof DataTypeOptionSchema>;

export const DdlLoadResultSchema = z.object({
  kind: z.enum(['create', 'alter']),
  /** create 态为 null（编辑器给空白模板）；alter 态为库内当前结构 */
  spec: TableSpecSchema.nullable(),
  /** @since 表设计器批次 A：类型建议词表（驱动方言各自维护，C-14）；缺省 = 类型框纯手输 */
  dataTypes: z.array(DataTypeOptionSchema).max(200).optional(),
  /** @since 表设计器批次 B：Tab 能力声明（交互稿 §12.2）；缺省 = 各 Tab 隐藏（纯列编辑） */
  features: TableDesignFeaturesSchema.optional(),
});
export type DdlLoadResult = z.infer<typeof DdlLoadResultSchema>;

// ── ddl.refTables / ddl.refColumns（表设计器批次 B：外键引用目标选择）────────
export const DdlRefTablesParamsSchema = z.object({
  connId: z.string().min(1),
  db: z.string().min(1),
});
export type DdlRefTablesParams = z.infer<typeof DdlRefTablesParamsSchema>;

export const DdlRefTablesResultSchema = z.object({
  /** 当前库内的表名清单（仅 table；视图/集合不作为引用目标） */
  tables: z.array(z.string().min(1).max(128)).max(2048),
});
export type DdlRefTablesResult = z.infer<typeof DdlRefTablesResultSchema>;

export const DdlRefColumnsParamsSchema = z.object({
  connId: z.string().min(1),
  db: z.string().min(1),
  table: z.string().min(1).max(128),
});
export type DdlRefColumnsParams = z.infer<typeof DdlRefColumnsParamsSchema>;

export const DdlRefColumnsResultSchema = z.object({
  columns: z.array(z.string().min(1).max(128)).max(256),
});
export type DdlRefColumnsResult = z.infer<typeof DdlRefColumnsResultSchema>;

export const DdlPreviewParamsSchema = z.object({
  connId: z.string().min(1),
  db: z.string().min(1),
  obj: z.string().min(1).optional(),
  spec: TableSpecSchema,
});
export type DdlPreviewParams = z.infer<typeof DdlPreviewParamsSchema>;

export const DdlPreviewResultSchema = z.object({
  kind: z.enum(['create', 'alter']),
  statements: z.array(DdlStatementSchema).max(512),
});
export type DdlPreviewResult = z.infer<typeof DdlPreviewResultSchema>;

/** 执行参数与 preview 同形；Host 侧重新调用同一 builder 生成语句（预览与执行同源，不信任回传 SQL） */
export const DdlExecuteParamsSchema = DdlPreviewParamsSchema;
export type DdlExecuteParams = z.infer<typeof DdlExecuteParamsSchema>;

export const DdlExecuteResultSchema = z.object({
  executed: z.number().int().min(0),
  /** 失败即停：第 N 条（1-based）语句的结构化错误；已执行语句不回滚（DDL 隐式提交） */
  failed: z
    .object({
      index: z.number().int().min(1),
      code: z.string(),
      message: z.string(),
    })
    .optional(),
});
export type DdlExecuteResult = z.infer<typeof DdlExecuteResultSchema>;

/** 关闭表结构编辑器面板（Webview 侧「关闭」按钮；Host dispose 面板。未保存确认在 Webview） */
export const DdlCloseParamsSchema = z.object({}).optional();
export type DdlCloseParams = z.infer<typeof DdlCloseParamsSchema>;

// ── dbddl.*（库级 DDL，M8-DBDDL / D-19 @since v0.2.21；删除库走树命令，不经 RPC）──────────

export const DatabaseSpecSchema = z.object({
  name: z.string().min(1).max(128),
  charset: z.string().max(128).optional(),
  collation: z.string().max(256).optional(),
  /** @since D-19 修订：MongoDB 建库所需的首个 collection 名 */
  collection: z.string().min(1).max(120).optional(),
  /** @since v0.1.16（M8-Oracle / D-23）：CREATE USER 密码（Oracle「库」= schema = 用户）；
   *  仅随 dbddl.preview/execute 瞬时经过，不落任何存储（与连接表单密码同边界，C-10） */
  password: z.string().min(1).max(128).optional(),
});
export type DatabaseSpecPayload = z.infer<typeof DatabaseSpecSchema>;

export const DbDdlLoadParamsSchema = z.object({
  connId: z.string().min(1),
  kind: z.enum(['create', 'alter']),
  /** alter 态必填：目标库名（仅改 charset/collation 维度，不支持重命名） */
  db: z.string().min(1).optional(),
});
export type DbDdlLoadParams = z.infer<typeof DbDdlLoadParamsSchema>;

export const DbDdlLoadResultSchema = z.object({
  kind: z.enum(['create', 'alter']),
  /** 驱动自定义表单（getDatabaseFormSchema；未实现回落最小 name 必填字段） */
  schema: FormSchemaSchema,
  /** create 态为 null；alter 态为当前库元数据预填（name/charset/collation） */
  spec: DatabaseSpecSchema.nullable(),
  /** 驱动是否实现 buildAlterDatabase（菜单已裁剪，此处防御性携带） */
  alterable: z.boolean(),
});
export type DbDdlLoadResult = z.infer<typeof DbDdlLoadResultSchema>;

export const DbDdlPreviewParamsSchema = z.object({
  connId: z.string().min(1),
  kind: z.enum(['create', 'alter']),
  db: z.string().min(1).optional(),
  spec: DatabaseSpecSchema,
});
export type DbDdlPreviewParams = z.infer<typeof DbDdlPreviewParamsSchema>;

export const DbDdlPreviewResultSchema = z.object({
  statements: z.array(DdlStatementSchema).max(64),
});
export type DbDdlPreviewResult = z.infer<typeof DbDdlPreviewResultSchema>;

/** 执行参数与 preview 同形；Host 侧重新调用同一 builder（预览与执行同源，不信任回传 SQL） */
export const DbDdlExecuteParamsSchema = DbDdlPreviewParamsSchema;
export type DbDdlExecuteParams = z.infer<typeof DbDdlExecuteParamsSchema>;

export const DbDdlExecuteResultSchema = z.object({
  executed: z.number().int().min(0),
  failed: z
    .object({
      index: z.number().int().min(1),
      code: z.string(),
      message: z.string(),
    })
    .optional(),
});
export type DbDdlExecuteResult = z.infer<typeof DbDdlExecuteResultSchema>;

export const DbDdlCloseParamsSchema = z.object({}).optional();
export type DbDdlCloseParams = z.infer<typeof DbDdlCloseParamsSchema>;

// ── er.getGraph / er.openTable（M8-ER ER 图，概要 §5.11 / D-22 @since v0.2.27）──────────
// 关系收集与分层布局在 Host（core erModel/erLayout，C-13）；Webview 只做视口变换与拖拽。

export const ErGraphScopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('all') }),
  z.object({
    kind: z.literal('selection'),
    /** 选中表清单（打开引导 QuickPick 的选择结果；按 listObjects 序保留） */
    tables: z.array(z.string().min(1).max(128)).min(1).max(300),
  }),
]);
export type ErGraphScopePayload = z.infer<typeof ErGraphScopeSchema>;

export const ErGraphParamsSchema = z.object({
  connId: z.string().min(1),
  db: z.string().min(1),
  scope: ErGraphScopeSchema,
  /** true = 绕元数据缓存重拉（工具栏「刷新」，失效该库 objects/columns/keys 后重建） */
  refresh: z.boolean().optional(),
});
export type ErGraphParams = z.infer<typeof ErGraphParamsSchema>;

export const ErColumnSummarySchema = z.object({
  name: z.string().min(1).max(128),
  dataType: z.string().min(1).max(256),
  isPrimaryKey: z.boolean(),
});
export type ErColumnSummaryPayload = z.infer<typeof ErColumnSummarySchema>;

export const ErTableSummarySchema = z.object({
  name: z.string().min(1).max(128),
  comment: z.string().max(2048).optional(),
  columns: z.array(ErColumnSummarySchema).max(256),
  /** 列超上限被截断的数量（缺省 0） */
  columnsTruncated: z.number().int().min(0).optional(),
});
export type ErTableSummaryPayload = z.infer<typeof ErTableSummarySchema>;

/** FK 关系边：source = FK 子表（多端）→ target = 被引用父表（一端）；复合 FK 单边、列序对齐 */
export const ErEdgeSummarySchema = z.object({
  name: z.string().max(128).optional(),
  sourceTable: z.string().min(1).max(128),
  sourceColumns: z.array(z.string().min(1).max(128)).min(1).max(32),
  targetTable: z.string().min(1).max(128),
  targetColumns: z.array(z.string().min(1).max(128)).min(1).max(32),
});
export type ErEdgeSummaryPayload = z.infer<typeof ErEdgeSummarySchema>;

export const ErLayoutNodeSchema = z.object({
  table: z.string().min(1).max(128),
  x: z.number(),
  y: z.number(),
  width: z.number().positive(),
  height: z.number().positive(),
});
export type ErLayoutNodePayload = z.infer<typeof ErLayoutNodeSchema>;

/** 布局结果（Host 计算）。常量随载荷下发（nodeWidth/rowHeight 等——core erLayout 单一来源，
 *  Webview 展开/折叠列后按同源常量重算节点高度，防双源漂移） */
export const ErGraphResultSchema = z.object({
  tables: z.array(ErTableSummarySchema).max(300),
  edges: z.array(ErEdgeSummarySchema).max(2000),
  layout: z.object({
    nodes: z.array(ErLayoutNodeSchema).max(300),
    width: z.number(),
    height: z.number(),
    nodeWidth: z.number().positive(),
    headerHeight: z.number().positive(),
    rowHeight: z.number().positive(),
    padBottom: z.number().min(0),
    layerGapX: z.number().min(0),
    nodeGapY: z.number().min(0),
  }),
  tableCount: z.number().int().min(0),
  /** 端点不全未绘制的 FK 边数（selection 裁剪 / 引用目标不在表集） */
  hiddenEdges: z.number().int().min(0),
});
export type ErGraphResult = z.infer<typeof ErGraphResultSchema>;

/** 节点双击 → 打开表格视图（Host 复用 openTablePanel 链路；无返回载荷） */
export const ErOpenTableParamsSchema = z.object({
  connId: z.string().min(1),
  db: z.string().min(1),
  table: z.string().min(1).max(128),
});
export type ErOpenTableParams = z.infer<typeof ErOpenTableParamsSchema>;

export const ErOpenTableResultSchema = z.object({});
export type ErOpenTableResult = z.infer<typeof ErOpenTableResultSchema>;

// ── sys.copyText（Host 剪贴板：webview 环境直接用 navigator.clipboard 不可靠，经 Host 写入）──
export const CopyTextParamsSchema = z.object({
  text: z.string().max(1_000_000),
});
export type CopyTextParams = z.infer<typeof CopyTextParamsSchema>;

export const CopyTextResultSchema = z.object({
  written: z.number().int().min(0),
});
export type CopyTextResult = z.infer<typeof CopyTextResultSchema>;

// ── sys.pickFile（Host 原生文件选择对话框：webview 无宿主文件系统能力；FormSchema type='file'
//    字段的「浏览…」按钮数据源。选中返回绝对路径，取消返回 null——调用方据此决定是否回填）──
export const PickFileParamsSchema = z.object({
  /** 对话框标题（缺省「选择文件」） */
  title: z.string().optional(),
  /** 确认按钮文案（缺省「选择」） */
  openLabel: z.string().optional(),
  /** 扩展名过滤器，如 { 'SQLite 数据库': ['db', 'sqlite', 'sqlite3'] }；缺省不过滤 */
  filters: z.record(z.string(), z.array(z.string().min(1))).optional(),
});
export type PickFileParams = z.infer<typeof PickFileParamsSchema>;

export const PickFileResultSchema = z.object({
  path: z.string().nullable(),
});
export type PickFileResult = z.infer<typeof PickFileResultSchema>;

/** evt:console.banner 负载（banner=null 表示横幅已关闭） */
export const ConsoleBannerEventSchema = z.object({
  consoleId: z.string(),
  banner: ConsoleBannerSchema.nullable(),
});
export type ConsoleBannerEvent = z.infer<typeof ConsoleBannerEventSchema>;

/** evt:console.running 负载 */
export const ConsoleRunningEventSchema = z.object({
  consoleId: z.string(),
  runId: z.string(),
  total: z.number().int().min(1),
});
export type ConsoleRunningEvent = z.infer<typeof ConsoleRunningEventSchema>;

/** evt:console.updated 负载（全量运行快照，逐语句增量推送） */
export const ConsoleUpdatedEventSchema = z.object({
  consoleId: z.string(),
  run: ConsoleRunSchema,
});
export type ConsoleUpdatedEvent = z.infer<typeof ConsoleUpdatedEventSchema>;

/** evt:console.activated 负载：底部面板单例视图跟随切换到该 Console（空串 = 无活动 Console） */
export const ConsoleActivatedEventSchema = z.object({
  consoleId: z.string(),
});
export type ConsoleActivatedEvent = z.infer<typeof ConsoleActivatedEventSchema>;

/** evt:console.ai 负载（M9-AI）：ai=null 表示该 Console 的 AI 解释已清除 */
export const ConsoleAiEventSchema = z.object({
  consoleId: z.string(),
  ai: ConsoleAiSchema.nullable(),
});
export type ConsoleAiEvent = z.infer<typeof ConsoleAiEventSchema>;

/** evt:console.fixRequest 负载（M9-AI 编辑器内修复入口）：Webview 打开修复 Modal 走 ai.fixError */
export const ConsoleFixRequestEventSchema = z.object({
  consoleId: z.string(),
  seq: z.number().int().min(1),
});
export type ConsoleFixRequestEvent = z.infer<typeof ConsoleFixRequestEventSchema>;

// ── ai.*（M9-AI AI 辅助，概要 §5.12 / D-24 @since v0.4.x）────────────────────
// 设置读写与错误修复走 RPC；生成与解释走编辑器 Host 命令（不经 RPC，解释经 evt:console.ai 推送）。
// 密钥边界（C-10）：key 只进 SecretStorage——getSettings 只回 hasKey 永不回传明文，
// saveSettings/testSettings 的 apiKey 缺省 = 沿用已存值（与 conn.test 密码同边界）。

export const AiSettingsResultSchema = z.object({
  endpoint: z.string(),
  model: z.string(),
  hasKey: z.boolean(),
});
export type AiSettingsResult = z.infer<typeof AiSettingsResultSchema>;

export const AiSaveSettingsParamsSchema = z.object({
  endpoint: z.string().max(2048),
  model: z.string().max(256),
  /** 缺省 = 不修改已存密钥；空串按缺省处理（表单留空语义） */
  apiKey: z.string().optional(),
  /** true = 清除已存密钥（设置页「清除」动作） */
  clearKey: z.boolean().optional(),
});
export type AiSaveSettingsParams = z.infer<typeof AiSaveSettingsParamsSchema>;

/** 测试连接：按表单当前值测试（字段缺省回落已存值，密钥缺省回落 SecretStorage） */
export const AiTestSettingsParamsSchema = AiSaveSettingsParamsSchema;
export type AiTestSettingsParams = z.infer<typeof AiTestSettingsParamsSchema>;

export const AiTestSettingsResultSchema = z.object({
  ok: z.boolean(),
  latencyMs: z.number().optional(),
  model: z.string().optional(),
});
export type AiTestSettingsResult = z.infer<typeof AiTestSettingsResultSchema>;

export const AiFixErrorParamsSchema = z.object({
  consoleId: z.string().min(1),
  /** 消息 Tab 错误 item 序号（ConsoleRunItem.seq） */
  seq: z.number().int().min(1),
});
export type AiFixErrorParams = z.infer<typeof AiFixErrorParamsSchema>;

export const AiFixErrorResultSchema = z.object({
  /** 修复凭据（Host 内存暂存，applyFix 时校验文档版本 + 语句偏移） */
  fixId: z.string(),
  originalSql: z.string(),
  suggestedSql: z.string(),
  /** AI 一行原因解释（可选，缺省隐藏说明行） */
  note: z.string().optional(),
});
export type AiFixErrorResult = z.infer<typeof AiFixErrorResultSchema>;

export const AiApplyFixParamsSchema = z.object({
  fixId: z.string().min(1),
  mode: z.enum(['replace', 'insert']),
});
export type AiApplyFixParams = z.infer<typeof AiApplyFixParamsSchema>;

export const AiApplyFixResultSchema = z.object({});
export type AiApplyFixResult = z.infer<typeof AiApplyFixResultSchema>;

export const AiOpenSettingsParamsSchema = z.object({}).optional();
export type AiOpenSettingsParams = z.infer<typeof AiOpenSettingsParamsSchema>;

export const AiRetryExplainParamsSchema = z.object({
  consoleId: z.string().min(1),
});
export type AiRetryExplainParams = z.infer<typeof AiRetryExplainParamsSchema>;

// ── settings.*（设置中心，交互稿 §16）────────────────────────────────────
// 代理编辑 VSCode settings：读 getConfiguration / 写 update（User 作用域），与 VSCode
// 设置双向同步、不另立存储。key 白名单 fail-closed——只允许本插件自有配置键（防 webview
// 写任意配置）；值按键分型校验。AI 密钥不在此（只进 SecretStorage，走 ai.* RPC）。

export const SETTINGS_ALLOWED_KEYS = [
  'dbExplorer.query.maxRows',
  'dbExplorer.query.timeoutMs',
  'dbExplorer.connection.connectTimeoutMs',
  'dbExplorer.queries.directory',
  'dbExplorer.export.defaultFormat',
  'dbExplorer.export.chunkRows',
  'dbExplorer.transaction.idleTimeoutMs',
  'dbExplorer.edit.allowNoPrimaryKey',
] as const;

export type SettingsAllowedKey = (typeof SETTINGS_ALLOWED_KEYS)[number];

/** 各键的值形状约束（settings.update 校验；number 均须 > 0） */
export const SETTINGS_KEY_TYPES: Record<SettingsAllowedKey, 'number' | 'string' | 'enum' | 'boolean'> = {
  'dbExplorer.query.maxRows': 'number',
  'dbExplorer.query.timeoutMs': 'number',
  'dbExplorer.connection.connectTimeoutMs': 'number',
  'dbExplorer.queries.directory': 'string',
  'dbExplorer.export.defaultFormat': 'enum',
  'dbExplorer.export.chunkRows': 'number',
  'dbExplorer.transaction.idleTimeoutMs': 'number',
  'dbExplorer.edit.allowNoPrimaryKey': 'boolean',
};

export const SettingsGetResultSchema = z.object({
  /** 扩展版本（关于页展示；Host 取 context.extension.packageJSON.version） */
  version: z.string(),
  values: z.record(z.string(), z.unknown()),
});
export type SettingsGetResult = z.infer<typeof SettingsGetResultSchema>;

export const SettingsUpdateParamsSchema = z.object({
  key: z.enum(SETTINGS_ALLOWED_KEYS),
  value: z.unknown(),
});
export type SettingsUpdateParams = z.infer<typeof SettingsUpdateParamsSchema>;

export const SettingsUpdateResultSchema = z.object({});
export type SettingsUpdateResult = z.infer<typeof SettingsUpdateResultSchema>;

export const SettingsOpenInVscodeParamsSchema = z.object({
  /** 缺省 = 打开本扩展的设置区域（@ext:publisher.name）；提供 = 定位到具体配置项（@id:） */
  key: z.enum(SETTINGS_ALLOWED_KEYS).optional(),
});
export type SettingsOpenInVscodeParams = z.infer<typeof SettingsOpenInVscodeParamsSchema>;

/** 关于页动作（枚举分发，不接收任意 uri/command——fail-closed） */
export const SettingsHubActionParamsSchema = z.object({
  action: z.enum(['openLog', 'openGitHub', 'openIssues', 'openWebsite']),
});
export type SettingsHubActionParams = z.infer<typeof SettingsHubActionParamsSchema>;

// ── cell.fetch（单元格查看器，交互稿 §4.6）────────────────────────
// 大字段按需拉取：驱动声明 capabilities.lazyCell 时，查看器经此 RPC 取整值。
// value 与 fetchRows 单元格 C-7 同形（JSON=已解析对象、binary=base64、NULL=null），
// 网格行内值只是它的（可能截断的）视图——查看器以本方法返回为准。

export const CellFetchParamsSchema = z.object({
  connId: z.string().min(1),
  db: z.string().min(1),
  obj: z.string().min(1),
  rowKey: RowKeySchema,
  column: z.string().min(1),
});
export type CellFetchParams = z.infer<typeof CellFetchParamsSchema>;

export const CellFetchResultSchema = z.object({
  value: z.unknown(),
});
export type CellFetchResult = z.infer<typeof CellFetchResultSchema>;

// ── sys.saveFile（Host 原生保存对话框：webview 无宿主文件系统能力）──
// 二进制查看器「另存为文件」及后续需要落盘的场景；base64 进、fsPath 出，取消 = null。

export const SysSaveFileParamsSchema = z.object({
  /** 保存对话框的默认文件名（含扩展名） */
  defaultName: z.string().min(1),
  /** 文件内容（base64；C-9 单值沿 fetchRows 既有传输上限） */
  base64: z.string().min(1),
  /** 对话框标题（缺省「另存为」） */
  title: z.string().optional(),
});
export type SysSaveFileParams = z.infer<typeof SysSaveFileParamsSchema>;

export const SysSaveFileResultSchema = z.object({
  /** 用户取消 = null；成功 = 写入的 fsPath */
  path: z.string().nullable(),
});
export type SysSaveFileResult = z.infer<typeof SysSaveFileResultSchema>;
