import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { DriverError, type DriverHost, type FilterCondition } from '@db-explorer/core';
import {
  ExportCancelParamsSchema,
  ExportRunParamsSchema,
  RpcEvents,
  type ExportRunParams,
  type ExportRunResult,
} from '@db-explorer/protocol';
import type { ConnectionManager } from './connectionManager';
import { csvRow, safeFileName, toJsonObject } from './csvJson';
import { writeXlsxFile } from './xlsxWriter';

/**
 * 导出服务（概要设计 5.7）：导出不在 Webview 内做（避免阻塞 UI 与 OOM），
 * Host 循环 fetchRows(chunkRows) → 流式写文件，withProgress + AbortSignal 可取消。
 * 进度经 evt:export.progress 推送；完成 Toast 可定位文件。
 */
export class ResultExporter {
  private readonly running = new Map<string, AbortController>();
  private seq = 0;

  constructor(
    private readonly deps: {
      webview: vscode.Webview;
      connections: ConnectionManager;
      host: DriverHost;
      output: vscode.OutputChannel;
      chunkRows: number;
      timeoutMs: number;
    },
  ) {}

  cancel(raw: unknown): void {
    const { exportId } = ExportCancelParamsSchema.parse(raw);
    this.running.get(exportId)?.abort();
  }

  async run(raw: unknown): Promise<ExportRunResult> {
    const p = ExportRunParamsSchema.parse(raw);
    const exportId = `exp-${++this.seq}-${Date.now()}`;

    const target = await pickTargetFile(p.db, p.obj, p.format);
    if (!target) {
      return { filePath: '', rows: 0, bytes: 0, canceled: true };
    }

    const controller = new AbortController();
    this.running.set(exportId, controller);
    this.deps.output.appendLine(`[export] ${exportId} 开始：${p.db}.${p.obj} → ${target} (${p.format}, ${p.scope})`);

    try {
      const result = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `导出 ${p.obj} (${p.format.toUpperCase()})…`,
          cancellable: true,
        },
        async (_progress, token) => {
          token.onCancellationRequested(() => controller.abort());
          return this.streamToFile(exportId, p, target, controller.signal);
        },
      );

      if (!result.canceled) {
        const action = await vscode.window.showInformationMessage(
          `已导出 ${result.rows} 行 → ${path.basename(result.filePath)}`,
          '定位文件',
        );
        if (action === '定位文件') {
          vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(result.filePath));
        }
      }
      return result;
    } finally {
      this.running.delete(exportId);
    }
  }

  private async streamToFile(
    exportId: string,
    p: ExportRunParams,
    target: string,
    signal: AbortSignal,
  ): Promise<ExportRunResult> {
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    const conn = await this.deps.connections.ensureConnected(p.connId);

    // 取数循环统一为批量生成器：csv/json 流式拼块，xlsx 交给 exceljs 流式写（D-14）
    const filters = p.filters as FilterCondition[] | undefined;
    const scopePage = p.scope === 'page';
    let rowsTotal = 0;
    let bytes = 0;
    const emitProgress = (): void => {
      void this.deps.webview.postMessage({
        kind: 'evt',
        event: RpcEvents.exportProgress,
        payload: { exportId, rows: rowsTotal, bytes },
      });
    };

    async function* fetchBatches(this: ResultExporter): AsyncGenerator<{
      names: string[];
      rows: unknown[][];
      total: number;
    }> {
      let offset = scopePage ? (p.offset ?? 0) : 0;
      while (true) {
        if (signal.aborted) {
          throw new DriverError('E_CANCELED', '已取消');
        }
        const rs = await this.deps.host.fetchRows(
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
            limit: scopePage ? (p.limit ?? this.deps.chunkRows) : this.deps.chunkRows,
            offset,
            timeoutMs: this.deps.timeoutMs,
          },
          { signal },
        );
        rowsTotal += rs.rows.length;
        yield { names: rs.columns.map((c) => c.name), rows: rs.rows, total: rowsTotal };
        if (scopePage || rs.rows.length < this.deps.chunkRows) {
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
      this.deps.output.appendLine(`[export] ${exportId} 完成：${rowsTotal} 行 / ${bytes} 字节`);
      return { filePath: target, rows: rowsTotal, bytes };
    } catch (err) {
      const canceled = DriverError.is(err) && err.code === 'E_CANCELED';
      if (canceled) {
        if (p.format === 'xlsx') {
          // xlsx 半成品是非法文件（csv/json 取消路径仍合法），直接清理
          await fs.promises.rm(target, { force: true }).catch(() => undefined);
        }
        this.deps.output.appendLine(`[export] ${exportId} 已取消：${rowsTotal} 行`);
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
        // JSON 半成品补收口（"[\\n" + "\\n]\\n" 仍合法），避免留下非法文件
        stream.write('\n]\n');
        await finish();
      }
      throw err;
    } finally {
      stream.destroy();
    }
  }
}

async function pickTargetFile(
  db: string,
  obj: string,
  format: 'csv' | 'json' | 'xlsx',
): Promise<string | undefined> {
  const wsFolder = vscode.workspace.workspaceFolders?.[0];
  const defaultDir = wsFolder ? path.join(wsFolder.uri.fsPath, '.db-export') : undefined;
  const defaultUri = defaultDir
    ? vscode.Uri.file(path.join(defaultDir, `${safeFileName(`${db}.${obj}`)}.${format}`))
    : undefined;
  const filters: Record<string, string[]> | undefined =
    format === 'csv' ? { CSV: ['csv'] } : format === 'xlsx' ? { Excel: ['xlsx'] } : { JSON: ['json'] };
  const target = await vscode.window.showSaveDialog({
    defaultUri,
    saveLabel: '导出',
    filters,
  });
  return target?.fsPath;
}
