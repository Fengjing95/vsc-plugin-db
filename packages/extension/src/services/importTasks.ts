import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  DriverError,
  ImportRowCountError,
  MAX_IMPORT_ROWS,
  IMPORT_ERROR_SAMPLE_LIMIT,
  IMPORT_PREVIEW_ROWS,
  convertRecord,
  detectImportFormat,
  normalizeHeaders,
  parseCsv,
  parseJsonRecords,
  planBatches,
  sniffDelimiter,
  suggestMapping,
  type ColumnMapping,
  type ImportRowError,
  type ImportTableColumn,
  type NormalizedType,
} from '@db-explorer/core';
import type { MetadataCache } from '@db-explorer/core';
import {
  ImportCancelParamsSchema,
  ImportParseParamsSchema,
  ImportRunParamsSchema,
  type ImportDoneEvent,
  type ImportFormat,
  type ImportParseResult,
  type ImportProgressEvent,
  type ImportRunParams,
  type ImportRunResult,
  type ImportMappingPayload,
} from '@db-explorer/protocol';
import type { ConnectionManager } from './connectionManager';
import type { EditGuard } from './editGuard';
import { t } from './i18n';
import { readXlsxSheet } from './xlsxReader';

/**
 * 数据导入任务引擎（概要设计 §5.13 / ADR D-32）：
 * import.parse = 选文件（file 缺省弹 OpenDialog，命令/自动化链路直接传，P-82 口子）
 *   → 解析 + 试转换（错行报告，不写入）→ 映射建议 + 前 10 行预览回传；
 * import.run = 护栏复用表格提交链（getPermission 只读拦截 + prod confirmApply）后
 *   调度即回执 importId，Host 后台分批构造 inserts-only ChangeSet 调 driver.applyChanges
 *   （单事务/批，失败批回滚、已写批保留、失败即停；禁止导入管线自拼 SQL——P-53 红线）。
 * 进度/终态对齐 export 模式（evt:import.progress / evt:import.done）；
 * 终态清理先于回执 Toast（P-37）。本模块不 import vscode（UI 经 ImportHostUi 注入），
 * VSCode 胶水见 resultImporter.ts。
 */

/** VSCode UI 适配（resultImporter.ts 注入实现） */
export interface ImportHostUi {
  /** 数据文件选择对话框；undefined = 用户取消 */
  pickImportFile(): Promise<string | undefined>;
  /** 通知中心后台进度（可取消）；返回关闭句柄，任务终态时必须调用 */
  showProgress(title: string, onCancel: () => void): Promise<{ close(): void }>;
  /** info = 完成/取消回执；error = 失败回执 */
  showMessage(kind: 'info' | 'error', message: string): Promise<string | undefined>;
}

export interface ImportTaskDeps {
  ui: ImportHostUi;
  /** Webview 事件推送（视图已关闭时 postMessage 静默失败，无碍——回执 Toast 在 Host 侧） */
  events: {
    progress(p: ImportProgressEvent): void;
    done(p: ImportDoneEvent): void;
  };
  log(line: string, level?: 'info' | 'warn' | 'error'): void;
}

export interface ImportTaskBase {
  connections: ConnectionManager;
  host: import('@db-explorer/core').DriverHost;
  /** 列元数据缓存（§7.5）：映射建议的类型依据 */
  cache: MetadataCache;
  /** §5.8 护栏：编辑权限 fail-closed + prod 提交确认 */
  editGuard: EditGuard;
  /** 批次大小（ADR D-32 定值 500 行/批 = 单事务/批） */
  batchRows: number;
  /** 单批 applyChanges 超时（与表格提交同宽） */
  timeoutMs: number;
}

interface ParsedRecord {
  /** 1-based 数据行号（表头不计；NDJSON = 物理行号；JSON 数组 = 元素序） */
  row: number;
  cells: Record<string, unknown>;
}

interface ParsedFile {
  file: string;
  fileName: string;
  format: ImportFormat;
  delimiter?: string;
  headers: string[];
  records: ParsedRecord[];
  parseErrors: ImportRowError[];
}

export class ImportTaskRunner {
  private readonly running = new Map<string, AbortController>();
  private seq = 0;

  constructor(
    private readonly base: ImportTaskBase,
    private readonly deps: ImportTaskDeps,
  ) {}

  cancel(raw: unknown): void {
    const { importId } = ImportCancelParamsSchema.parse(raw);
    this.running.get(importId)?.abort();
  }

  /** 解析 + 试转换 + 映射建议 + 预览（不写入；列类型来自元数据缓存） */
  async parse(raw: unknown): Promise<ImportParseResult> {
    const p = ImportParseParamsSchema.parse(raw);
    const file = p.file ?? (await this.deps.ui.pickImportFile());
    if (!file) {
      return { canceled: true, file: '', fileName: '', format: 'csv', fileColumns: [], rowsTotal: 0, validRows: 0, skippedRows: 0, errors: [], errorsTotal: 0, mapping: [], tableColumns: [], preview: [] };
    }
    const conn = await this.base.connections.ensureConnected(p.connId);
    const columnMetas = await this.base.cache.getColumns(p.connId, p.db, p.obj, () =>
      conn.listColumns(p.db, p.obj),
    );
    const tableColumns: ImportTableColumn[] = columnMetas.map((c) => ({
      name: c.name,
      type: c.normalizedType,
      isPrimaryKey: c.isPrimaryKey,
      autoIncrement: c.autoIncrement === true,
      nullable: c.nullable,
    }));

    const parsed = await readRecords(file, undefined, undefined);
    enforceRowLimit(parsed);
    const mapping = suggestMapping(parsed.headers, tableColumns);
    const dry = convertAll(parsed.records, mapping, { emptyAsNull: true });
    const rowsTotal = parsed.records.length + parsed.parseErrors.length;
    const errors = [...parsed.parseErrors, ...dry.errors];
    return {
      file,
      fileName: path.basename(file),
      format: parsed.format,
      delimiter: parsed.delimiter,
      fileColumns: parsed.headers,
      rowsTotal,
      validRows: dry.values.length,
      skippedRows: rowsTotal - dry.values.length,
      errors: errors.slice(0, IMPORT_ERROR_SAMPLE_LIMIT),
      errorsTotal: errors.length,
      mapping: mapping.map((m) => ({ fileColumn: m.fileColumn, tableColumn: m.tableColumn, type: m.type })),
      tableColumns,
      preview: parsed.records.slice(0, IMPORT_PREVIEW_ROWS).map((rec) => parsed.headers.map((h) => previewValue(rec.cells[h]))),
    };
  }

  /** 护栏确认（同步完成）→ 调度即回执 importId；执行体在后台 */
  async run(raw: unknown): Promise<ImportRunResult> {
    const p = ImportRunParamsSchema.parse(raw);
    assertMappingUsable(p.mapping);

    const permission = await this.base.editGuard.getPermission(p.connId, p.db, p.obj);
    if (!permission.enabled) {
      throw new DriverError('E_READONLY', permission.reason ?? t('当前视图不可编辑'));
    }
    // DangerGuard（§5.8）：prod 环境强制输入表名确认（与表格提交同检测点）
    const confirmed = await this.base.editGuard.confirmApply(p.connId, p.obj);
    if (!confirmed) {
      throw new DriverError('E_CANCELED', t('已取消导入（表名不匹配或已取消）'));
    }

    const importId = `imp-${++this.seq}-${Date.now()}`;
    const controller = new AbortController();
    this.running.set(importId, controller);
    this.deps.log(`[import] ${importId} 开始（后台）：${p.file} → ${p.db}.${p.obj}（${p.format}）`, 'info');
    void this.executeDetached(importId, p, controller);
    return { importId };
  }

  /** 后台执行体：终态三路（成功/取消/失败）都发 evt:import.done；终态清理先于回执 Toast（P-37） */
  private async executeDetached(importId: string, p: ImportRunParams, controller: AbortController): Promise<void> {
    const progress = await this.deps.ui.showProgress(t('导入 {0}…', [p.obj]), () => controller.abort());
    const started = Date.now();
    let written = 0;
    try {
      let total = 0;
      let skipped = 0;
      let failedRows = 0;
      const errors: ImportRowError[] = [];
      let status: ImportDoneEvent['status'] = 'ok';
      let failure: { code: string; message: string } | undefined;
      try {
        const conn = await this.base.connections.ensureConnected(p.connId);
        const parsed = await readRecords(p.file, p.format, p.delimiter);
        enforceRowLimit(parsed);
        const mapping = toColumnMappings(p.mapping);
        const dry = convertAll(parsed.records, mapping, { emptyAsNull: p.emptyAsNull });
        total = dry.values.length;
        skipped = parsed.parseErrors.length + dry.errors.length;
        errors.push(...parsed.parseErrors, ...dry.errors);
        const batches = planBatches(dry.values, Math.max(1, this.base.batchRows));
        for (let bi = 0; bi < batches.length; bi++) {
          const batch = batches[bi];
          if (controller.signal.aborted) {
            throw new DriverError('E_CANCELED', t('已取消'));
          }
          const cs = {
            inserts: batch.map((v, i) => ({ tempId: `${importId}-${bi}-${i}`, values: v.values })),
            updates: [],
            deletes: [],
          };
          try {
            await this.base.host.applyChanges(conn, p.db, p.obj, cs, {
              timeoutMs: this.base.timeoutMs,
              signal: controller.signal,
            });
          } catch (err) {
            const e = DriverError.is(err) ? err : new DriverError('E_INTERNAL', err instanceof Error ? err.message : String(err));
            failedRows = batch.length;
            errors.push({
              row: batch[0].row,
              message: t('第 {0}-{1} 行写入失败：{2}', [batch[0].row, batch[batch.length - 1].row, e.message]),
            });
            throw e;
          }
          written += batch.length;
          this.deps.events.progress({ importId, written, total });
        }
      } catch (err) {
        // 终态清理（关进度/出任务表）必须先于任何 await showMessage（P-37）
        finishTask(this.running, importId, progress);
        const canceled = DriverError.is(err) && err.code === 'E_CANCELED';
        status = canceled ? 'canceled' : 'error';
        const e = DriverError.is(err) ? err : new DriverError('E_INTERNAL', err instanceof Error ? err.message : String(err));
        if (!canceled) {
          failure = { code: e.code, message: e.message };
          this.deps.log(`[import] ${importId} 失败：已写入 ${written} 行 → ${e.code} ${e.message}`, 'error');
          void this.deps.ui.showMessage('error', t('导入失败：已写入 {0} 行。{1}', [written, e.message]));
        } else {
          this.deps.log(`[import] ${importId} 已取消：已写入 ${written} 行`, 'info');
          void this.deps.ui.showMessage('info', t('导入已取消：已写入 {0} 行', [written]));
        }
      }
      if (status === 'ok') {
        // 成功路径：先关进度/出任务表，再发终态与回执 Toast
        finishTask(this.running, importId, progress);
        this.deps.log(`[import] ${importId} 完成：写入 ${written}/${total} 行，跳过 ${skipped} 行`, 'info');
        void this.deps.ui.showMessage('info', t('已导入 {0} 行 → {1}（跳过 {2} 行）', [written, p.obj, skipped]));
      }
      this.deps.events.done({
        importId,
        connId: p.connId,
        db: p.db,
        obj: p.obj,
        status,
        total,
        written,
        skipped,
        failedRows,
        executionMs: Date.now() - started,
        errors: errors.slice(0, 50),
        error: failure,
      });
      return;
    } finally {
      // 兜底：无论路径如何任务必然出表、进度必然关闭（幂等）
      finishTask(this.running, importId, progress);
    }
  }
}

function finishTask(
  running: Map<string, AbortController>,
  importId: string,
  progress: { close(): void },
): void {
  running.delete(importId);
  progress.close();
}

/** ── 文件读取与转换（parse / run 共用同源实现——run 重读重解析，数据全程不经 webview）── */

async function readRecords(
  file: string,
  formatHint: ImportFormat | undefined,
  delimiterHint: string | undefined,
): Promise<ParsedFile> {
  let buf: Buffer;
  try {
    buf = await fs.promises.readFile(file);
  } catch {
    throw new DriverError('E_NOT_FOUND', t('文件不可读：{0}', [file]));
  }
  const head = buf.subarray(0, 4096).toString('utf8');
  const format = formatHint ?? detectImportFormat(path.basename(file), head);

  if (format === 'xlsx') {
    const sheet = await readXlsxSheet(file, MAX_IMPORT_ROWS + 1);
    if (sheet.rows.length > MAX_IMPORT_ROWS) {
      throw new ImportRowCountError(MAX_IMPORT_ROWS, sheet.rows.length);
    }
    const headers = normalizeHeaders(sheet.headers);
    return {
      file,
      fileName: path.basename(file),
      format,
      headers,
      records: sheet.rows.map((cells, i) => ({ row: i + 1, cells: zipRow(headers, cells) })),
      parseErrors: [],
    };
  }

  const text = buf.toString('utf8');
  if (format === 'csv') {
    const delimiter = delimiterHint;
    let rows: string[][];
    try {
      rows = parseCsv(text, delimiter);
    } catch (err) {
      const row = (err as { row?: number }).row;
      throw new DriverError('E_VALIDATION', t('CSV 解析失败（第 {0} 行附近）：{1}', [row ?? 0, err instanceof Error ? err.message : String(err)]));
    }
    if (rows.length === 0) {
      throw new DriverError('E_VALIDATION', t('文件没有数据行'));
    }
    const headers = normalizeHeaders(rows[0]);
    const records = rows.slice(1).map((cells, i) => ({ row: i + 1, cells: zipRow(headers, cells) }));
    return {
      file,
      fileName: path.basename(file),
      format,
      delimiter: delimiter ?? sniffDelimiter(text.slice(0, 4096)),
      headers,
      records,
      parseErrors: [],
    };
  }

  let json: ReturnType<typeof parseJsonRecords>;
  try {
    json = parseJsonRecords(text);
  } catch (err) {
    throw new DriverError('E_VALIDATION', err instanceof Error ? err.message : String(err));
  }
  return {
    file,
    fileName: path.basename(file),
    format: json.format,
    headers: normalizeHeaders(collectJsonKeys(json.records)),
    records: json.records.map((cells, i) => ({ row: i + 1, cells })),
    parseErrors: json.rowErrors,
  };
}

/** 行数组 → 键值记录（CSV/xlsx 通道；键为归一表头） */
function zipRow(headers: string[], cells: unknown[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (let i = 0; i < headers.length; i++) {
    out[headers[i]] = cells[i] === undefined ? null : cells[i];
  }
  return out;
}

/** JSON 记录列集：首见序（与导出列认知一致；后续记录多出的键补在尾部） */
function collectJsonKeys(records: Array<Record<string, unknown>>): string[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const rec of records) {
    for (const k of Object.keys(rec)) {
      if (!seen.has(k)) {
        seen.add(k);
        keys.push(k);
      }
    }
  }
  return keys;
}

function enforceRowLimit(parsed: ParsedFile): void {
  const count = parsed.records.length + parsed.parseErrors.length;
  if (count > MAX_IMPORT_ROWS) {
    throw new ImportRowCountError(MAX_IMPORT_ROWS, count);
  }
}

function toColumnMappings(mapping: ImportMappingPayload[]): ColumnMapping[] {
  return mapping.map((m) => ({ fileColumn: m.fileColumn, tableColumn: m.tableColumn, type: m.type as NormalizedType }));
}

function assertMappingUsable(mapping: ImportMappingPayload[]): void {
  const targets = mapping.filter((m) => m.tableColumn !== null).map((m) => m.tableColumn as string);
  if (targets.length === 0) {
    throw new DriverError('E_VALIDATION', t('至少需要映射一个表列'));
  }
  const dup = targets.find((x, i) => targets.indexOf(x) !== i);
  if (dup) {
    throw new DriverError('E_VALIDATION', t('多个文件列映射到了同一表列：{0}', [dup]));
  }
}

interface ConvertedRow {
  row: number;
  values: Record<string, unknown>;
}

interface ConvertOutput {
  values: ConvertedRow[];
  errors: ImportRowError[];
}

/** 全量试转换（parse 用默认 emptyAsNull=true 估报告；run 用用户开关重转换） */
function convertAll(records: ParsedRecord[], mapping: ColumnMapping[], opts: { emptyAsNull: boolean }): ConvertOutput {
  const values: ConvertedRow[] = [];
  const errors: ImportRowError[] = [];
  for (const rec of records) {
    const r = convertRecord(rec.cells, mapping, opts);
    if (r.ok) {
      values.push({ row: rec.row, values: r.values });
    } else {
      errors.push({ row: rec.row, message: r.reason });
    }
  }
  return { values, errors };
}

/** 预览原值：Date（xlsx）→ C-7 datetime 文本，其余原样（webview 只展示） */
function previewValue(v: unknown): unknown {
  if (v instanceof Date) {
    const r = convertRecord({ d: v }, [{ fileColumn: 'd', tableColumn: 'd', type: 'datetime' }], { emptyAsNull: true });
    return r.ok ? r.values.d : String(v);
  }
  return v === undefined ? null : v;
}
