import * as fs from 'node:fs';
import * as path from 'node:path';
import { DriverError, type DriverHost, type FilterCondition } from '@db-explorer/core';
import {
  ExportCancelParamsSchema,
  ExportRunParamsSchema,
  type ExportDoneEvent,
  type ExportFormat,
  type ExportProgressEvent,
  type ExportRunParams,
  type ExportRunResult,
} from '@db-explorer/protocol';
import type { ConnectionManager } from './connectionManager';
import { csvRow, toJsonObject } from './csvJson';
import { writeXlsxFile } from './xlsxWriter';

/**
 * 导出任务引擎（概要设计 5.7 / §6 #16，M8 后台化）：
 * export.run 调度即回执 exportId——导出在 Extension Host 后台继续（withProgress 通知中心
 * 呈现进度、通知上可取消），不阻塞 Webview 任何操作，可多任务并发。
 * 终态统一经 evt:export.done 回执（成功/取消/失败）；完成/失败 Toast 由 Host 发
 * （后台任务不依赖 Webview 存活）。
 *
 * 本模块不 import vscode（UI 动作经 ExportHostUi 注入），便于单测；
 * VSCode 胶水见 resultExporter.ts 的 createResultExporter。
 */

/** VSCode UI 适配（resultExporter.ts 注入实现） */
export interface ExportHostUi {
  /** 保存对话框；undefined = 用户取消 */
  pickTargetFile(db: string, obj: string, format: ExportFormat): Promise<string | undefined>;
  /** 通知中心后台进度（可取消）；返回关闭句柄，任务终态时必须调用 */
  showProgress(title: string, onCancel: () => void): Promise<{ close(): void }>;
  /** info = 完成回执（可带动作按钮）；error = 失败回执。返回被点击的动作文本 */
  showMessage(kind: 'info' | 'error', message: string, action?: string): Promise<string | undefined>;
  /** 在系统文件管理器中定位文件 */
  revealFile(filePath: string): void;
}

export interface ExportTaskDeps {
  ui: ExportHostUi;
  /** Webview 事件推送（视图已关闭时 postMessage 静默失败，无碍——回执 Toast 在 Host 侧） */
  events: {
    progress(p: ExportProgressEvent): void;
    done(p: ExportDoneEvent): void;
  };
  /** 日志（Host 门面转发，line 自带 [export] 源标签；级别缺省 info） */
  log(line: string, level?: 'info' | 'warn' | 'error'): void;
}

export interface ExportTaskBase {
  connections: ConnectionManager;
  host: DriverHost;
  chunkRows: number;
  timeoutMs: number;
}

export class ExportTaskRunner {
  private readonly running = new Map<string, AbortController>();
  private seq = 0;

  constructor(
    private readonly base: ExportTaskBase,
    private readonly deps: ExportTaskDeps,
  ) {}

  cancel(raw: unknown): void {
    const { exportId } = ExportCancelParamsSchema.parse(raw);
    this.running.get(exportId)?.abort();
  }

  /** 调度即回执（不等待导出完成）；SaveDialog 取消返回 canceled */
  async run(raw: unknown): Promise<ExportRunResult> {
    const p = ExportRunParamsSchema.parse(raw);
    const exportId = `exp-${++this.seq}-${Date.now()}`;

    const target = await this.deps.ui.pickTargetFile(p.db, p.obj, p.format);
    if (!target) {
      return { exportId: '', canceled: true };
    }

    const controller = new AbortController();
    this.running.set(exportId, controller);
    this.deps.log(`[export] ${exportId} 开始（后台）：${p.db}.${p.obj} → ${target} (${p.format}, ${p.scope})`, 'info');
    void this.executeDetached(exportId, p, target, controller);
    return { exportId };
  }

  /** 后台执行体：终态三路（成功/取消/失败）都发 evt:export.done；进度通知终态关闭。
   *  终态清理（关进度/出任务表）必须先于回执 Toast——带按钮的 showInformationMessage
   *  会 await 到用户点击为止，若把 close 放在 finally 会让进度通知驻留到 Toast 被处理后（P-37）。 */
  private async executeDetached(
    exportId: string,
    p: ExportRunParams,
    target: string,
    controller: AbortController,
  ): Promise<void> {
    const progress = await this.deps.ui.showProgress(
      `导出 ${p.obj} (${p.format.toUpperCase()})…`,
      () => controller.abort(),
    );
    try {
      let result: { filePath: string; rows: number; bytes: number; canceled?: boolean };
      try {
        result = await this.streamToFile(exportId, p, target, controller.signal);
      } catch (err) {
        this.finishTask(exportId, progress);
        const e = DriverError.is(err)
          ? err
          : new DriverError('E_INTERNAL', err instanceof Error ? err.message : String(err));
        this.deps.log(`[export] ${exportId} 失败：${e.code} ${e.message}`, 'error');
        this.deps.events.done({
          exportId,
          rows: 0,
          bytes: 0,
          error: { code: e.code, message: e.message },
        });
        void this.deps.ui.showMessage('error', `导出失败：${e.message}`);
        return;
      }
      // 成功/取消终态：先关进度、出任务表，再发回执（完成 Toast 等待用户交互不阻塞任何清理）
      this.finishTask(exportId, progress);
      this.deps.events.done({
        exportId,
        rows: result.rows,
        bytes: result.bytes,
        canceled: result.canceled || undefined,
      });
      if (result.canceled) {
        this.deps.log(`[export] ${exportId} 已取消：${result.rows} 行`, 'info');
        return;
      }
      this.deps.log(`[export] ${exportId} 完成：${result.rows} 行 / ${result.bytes} 字节`, 'info');
      const action = await this.deps.ui.showMessage(
        'info',
        `已导出 ${result.rows} 行 → ${path.basename(result.filePath)}`,
        '定位文件',
      );
      if (action === '定位文件') {
        this.deps.ui.revealFile(result.filePath);
      }
    } finally {
      // 兜底：无论路径如何任务必然出表、进度必然关闭（幂等，正常路径已提前清理）
      this.running.delete(exportId);
      progress.close();
    }
  }

  /** 终态清理：任务出表 + 关闭进度通知（两者均幂等，可安全重复调用） */
  private finishTask(exportId: string, progress: { close(): void }): void {
    this.running.delete(exportId);
    progress.close();
  }

  private async streamToFile(
    exportId: string,
    p: ExportRunParams,
    target: string,
    signal: AbortSignal,
  ): Promise<{ filePath: string; rows: number; bytes: number; canceled?: boolean }> {
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    const conn = await this.base.connections.ensureConnected(p.connId);

    // 取数循环统一为批量生成器：csv/json 流式拼块，xlsx 交给 exceljs 流式写（D-14）
    const filters = p.filters as FilterCondition[] | undefined;
    const scopePage = p.scope === 'page';
    let rowsTotal = 0;
    let bytes = 0;
    const emitProgress = (): void => {
      this.deps.events.progress({ exportId, rows: rowsTotal, bytes });
    };

    async function* fetchBatches(this: ExportTaskRunner): AsyncGenerator<{
      names: string[];
      rows: unknown[][];
      total: number;
    }> {
      let offset = scopePage ? (p.offset ?? 0) : 0;
      while (true) {
        if (signal.aborted) {
          throw new DriverError('E_CANCELED', '已取消');
        }
        const rs = await this.base.host.fetchRows(
          conn,
          {
            db: p.db,
            obj: p.obj,
            columns: p.columns,
            filters,
            sorts: p.sorts,
            search: p.search,
            whereSql: p.whereSql,
            orderBySql: p.orderBySql,
            limit: scopePage ? (p.limit ?? this.base.chunkRows) : this.base.chunkRows,
            offset,
            timeoutMs: this.base.timeoutMs,
          },
          { signal },
        );
        rowsTotal += rs.rows.length;
        yield { names: rs.columns.map((c) => c.name), rows: rs.rows, total: rowsTotal };
        if (scopePage || rs.rows.length < this.base.chunkRows) {
          return;
        }
        offset += rs.rows.length;
      }
    }

    try {
      if (p.format === 'xlsx') {
        bytes = await this.streamXlsx(fetchBatches.bind(this), target, signal, emitProgress);
      } else {
        bytes = await this.streamText(p, fetchBatches.bind(this), target, signal, emitProgress);
      }
      return { filePath: target, rows: rowsTotal, bytes };
    } catch (err) {
      const canceled = DriverError.is(err) && err.code === 'E_CANCELED';
      if (canceled) {
        if (p.format === 'xlsx') {
          // xlsx 半成品是非法文件（csv/json 取消路径仍合法），直接清理
          await fs.promises.rm(target, { force: true }).catch(() => undefined);
        }
        return { filePath: target, rows: rowsTotal, bytes, canceled: true };
      }
      throw err;
    }
  }

  /** xlsx：首个批量定表头，其余批量交给 exceljs 流式写（xlsx 中途拿不到已写字节，进度只报行数） */
  private async streamXlsx(
    fetchBatches: () => AsyncGenerator<{ names: string[]; rows: unknown[][]; total: number }>,
    target: string,
    signal: AbortSignal,
    emitProgress: () => void,
  ): Promise<number> {
    const iterator = fetchBatches()[Symbol.asyncIterator]();
    const first = await iterator.next();
    const names = first.done ? [] : first.value.names;
    const rest: AsyncIterable<unknown[][]> = {
      async *[Symbol.asyncIterator]() {
        if (!first.done && first.value.rows.length > 0) {
          yield first.value.rows;
          emitProgress();
        }
        while (true) {
          if (signal.aborted) {
            throw new DriverError('E_CANCELED', '已取消');
          }
          const r = await iterator.next();
          if (r.done) {
            return;
          }
          yield r.value.rows;
          emitProgress();
        }
      },
    };
    const result = await writeXlsxFile(
      target,
      names.map((name) => ({ name })),
      rest,
    );
    return result.bytes;
  }

  /** csv/json：逐批拼块流式写（背景压控制内存有界） */
  private async streamText(
    p: ExportRunParams,
    fetchBatches: () => AsyncGenerator<{ names: string[]; rows: unknown[][]; total: number }>,
    target: string,
    signal: AbortSignal,
    emitProgress: () => void,
  ): Promise<number> {
    const stream = fs.createWriteStream(target);
    let headerWritten = false;
    let jsonClosed = false;
    let rowsTotal = 0;

    const writeChunk = (chunk: string): Promise<void> =>
      new Promise((resolve, reject) => {
        if (stream.write(chunk)) {
          resolve();
        } else {
          // 背压：等缓冲排空再继续，保证大导出内存有界
          stream.once('drain', () => resolve());
        }
        stream.once('error', reject);
      });
    const finish = (): Promise<void> =>
      new Promise((resolve, reject) => {
        stream.end(() => resolve());
        stream.once('error', reject);
      });

    try {
      for await (const { names, rows, total } of fetchBatches()) {
        if (!headerWritten) {
          if (p.format === 'csv') {
            await writeChunk(csvRow(names));
          } else {
            await writeChunk('[\n');
          }
          headerWritten = true;
        }
        if (p.format === 'csv') {
          for (const row of rows) {
            await writeChunk(csvRow(row));
          }
        } else if (rows.length > 0) {
          const parts = rows.map((row) => JSON.stringify(toJsonObject(names, row)));
          await writeChunk((rowsTotal === 0 ? '' : ',\n') + parts.join(',\n'));
        }
        rowsTotal = total;
        emitProgress();
        if (signal.aborted) {
          throw new DriverError('E_CANCELED', '已取消');
        }
      }

      if (p.format === 'json') {
        // rowsTotal=0 时为 "[\n\n]\n"，仍是合法 JSON
        await writeChunk('\n]\n');
        jsonClosed = true;
      }
      await finish();
      return stream.bytesWritten;
    } catch (err) {
      const canceled = DriverError.is(err) && err.code === 'E_CANCELED';
      if (canceled && p.format === 'json' && headerWritten && !jsonClosed) {
        // JSON 半成品补收口（"[\n" + "\n]\n" 仍合法），避免留下非法文件
        stream.write('\n]\n');
        await finish();
      }
      throw err;
    } finally {
      stream.destroy();
    }
  }
}
