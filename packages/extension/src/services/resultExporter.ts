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
    const stream = fs.createWriteStream(target);

    const filters = p.filters as FilterCondition[] | undefined;
    let rowsTotal = 0;
    let headerWritten = false;
    let jsonClosed = false;
    let bytes = 0;

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
      // scope=page：仅当前页；scope=result：从 0 循环取到取尽
      const scopePage = p.scope === 'page';
      let offset = scopePage ? (p.offset ?? 0) : 0;

      while (true) {
        if (signal.aborted) {
          throw new DriverError('E_CANCELED', '已取消');
        }
        // 外部取消经 DriverHost 的 AbortSignal 透传（ADR D-05 护栏）
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

        const names = rs.columns.map((c) => c.name);
        if (!headerWritten) {
          if (p.format === 'csv') {
            await writeChunk(csvRow(names));
          } else {
            await writeChunk('[\n');
          }
          headerWritten = true;
        }
        if (p.format === 'csv') {
          for (const row of rs.rows) {
            await writeChunk(csvRow(row));
          }
        } else if (rs.rows.length > 0) {
          const parts = rs.rows.map((row) => JSON.stringify(toJsonObject(names, row)));
          await writeChunk((rowsTotal === 0 ? '' : ',\n') + parts.join(',\n'));
        }

        rowsTotal += rs.rows.length;
        bytes = stream.bytesWritten;
        void this.deps.webview.postMessage({
          kind: 'evt',
          event: RpcEvents.exportProgress,
          payload: { exportId, rows: rowsTotal, bytes },
        });

        if (signal.aborted) {
          throw new DriverError('E_CANCELED', '已取消');
        }
        if (scopePage || rs.rows.length < this.deps.chunkRows) {
          break;
        }
        offset += rs.rows.length;
      }

      if (p.format === 'json') {
        // rowsTotal=0 时为 "[\n\n]\n"，仍是合法 JSON
        await writeChunk('\n]\n');
        jsonClosed = true;
      }
      await finish();

      this.deps.output.appendLine(`[export] ${exportId} 完成：${rowsTotal} 行 / ${bytes} 字节`);
      return { filePath: target, rows: rowsTotal, bytes };
    } catch (err) {
      const canceled = DriverError.is(err) && err.code === 'E_CANCELED';
      if (canceled) {
        // JSON 半成品补收口（"[\\n" + "\\n]\\n" 仍合法），避免留下非法文件
        if (p.format === 'json' && headerWritten && !jsonClosed) {
          stream.write('\n]\n');
        }
        await finish();
        this.deps.output.appendLine(`[export] ${exportId} 已取消：${rowsTotal} 行`);
        return { filePath: target, rows: rowsTotal, bytes, canceled: true };
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
  format: 'csv' | 'json',
): Promise<string | undefined> {
  const wsFolder = vscode.workspace.workspaceFolders?.[0];
  const defaultDir = wsFolder
    ? path.join(wsFolder.uri.fsPath, '.db-export')
    : undefined;
  const defaultUri = defaultDir
    ? vscode.Uri.file(path.join(defaultDir, `${safeFileName(`${db}.${obj}`)}.${format}`))
    : undefined;
  const target = await vscode.window.showSaveDialog({
    defaultUri,
    saveLabel: '导出',
    filters: format === 'csv' ? { CSV: ['csv'] } : { JSON: ['json'] },
  });
  return target?.fsPath;
}
