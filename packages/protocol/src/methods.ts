import { z } from 'zod';
import type { DriverErrorCode } from '@db-explorer/core';

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
  connSave: 'conn.save',
  consoleState: 'console.getState',
  consoleExecute: 'console.execute',
  consoleCancel: 'console.cancel',
  consoleResolveBanner: 'console.resolveBanner',
  consoleExport: 'console.export',
  consoleClose: 'console.close',
  copyText: 'sys.copyText',
} as const;

/** Host → Webview 单向推送事件（概要设计 7.4.2） */
export const RpcEvents = {
  exportProgress: 'evt:export.progress',
  changesetUpdated: 'evt:changeset.updated',
  rowError: 'evt:row.error',
  consoleBanner: 'evt:console.banner',
  consoleRunning: 'evt:console.running',
  consoleUpdated: 'evt:console.updated',
  consoleActivated: 'evt:console.activated',
} as const;

/** RPC 层错误码：复用 DriverErrorCode，仅另加 E_UNKNOWN_METHOD / E_STATE_LOST */
export type RpcErrorCode = DriverErrorCode | 'E_UNKNOWN_METHOD' | 'E_STATE_LOST';

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
   *  来自 driver.capabilities（registry 侧读取，握手不触发建连，D-10） */
  capabilities: z.object({
    supportsSQL: z.boolean(),
    supportsDdl: z.boolean(),
  }),
});
export type HandshakeResult = z.infer<typeof HandshakeResultSchema>;

export const FetchRowsParamsSchema = z.object({
  connId: z.string().min(1),
  db: z.string().min(1),
  obj: z.string().min(1),
  limit: z.number().int().positive().max(5000),
  offset: z.number().int().min(0).optional(),
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
export const ExportFormatSchema = z.enum(['csv', 'json', 'xlsx']);
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

export const ExportRunResultSchema = z.object({
  filePath: z.string(),
  rows: z.number().int(),
  bytes: z.number().int(),
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

export const ConsoleStateParamsSchema = z.object({
  /** 空 = Host 解析为「最近执行的 Console」（底部面板单例视图的引导路径） */
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

// ── sys.copyText（Host 剪贴板：webview 环境直接用 navigator.clipboard 不可靠，经 Host 写入）──
export const CopyTextParamsSchema = z.object({
  text: z.string().max(1_000_000),
});
export type CopyTextParams = z.infer<typeof CopyTextParamsSchema>;

export const CopyTextResultSchema = z.object({
  written: z.number().int().min(0),
});
export type CopyTextResult = z.infer<typeof CopyTextResultSchema>;

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
