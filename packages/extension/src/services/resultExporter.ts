import * as path from 'node:path';
import * as vscode from 'vscode';
import type { DriverHost } from '@db-explorer/core';
import type { ExportFormat } from '@db-explorer/protocol';
import type { ConnectionManager } from './connectionManager';
import { safeFileName } from './csvJson';
import type { Logger } from './logger';
import { ExportTaskRunner, type ExportTaskBase } from './exportTasks';

/**
 * 导出服务 VSCode 胶水（概要设计 5.7）：任务引擎在 exportTasks.ts（纯层、可单测），
 * 此处只做 vscode UI 组装——保存对话框、通知中心后台进度、完成/失败回执、文件定位。
 * M8 后台化（#16）：export.run 调度即回执 exportId，导出在 Host 后台继续，
 * 进度经 evt:export.progress 推送、终态经 evt:export.done 回执。
 */
export function createResultExporter(
  args: {
    webview: vscode.Webview;
    connections: ConnectionManager;
    host: DriverHost;
    logger: Logger;
    chunkRows: number;
    timeoutMs: number;
  },
): ExportTaskRunner {
  const base: ExportTaskBase = {
    connections: args.connections,
    host: args.host,
    chunkRows: args.chunkRows,
    timeoutMs: args.timeoutMs,
  };
  return new ExportTaskRunner(base, {
    ui: {
      pickTargetFile: (db, obj, format) => pickTargetFile(db, obj, format),
      showProgress: (title, onCancel) => showBackgroundProgress(title, onCancel),
      showMessage: async (kind, message, action) =>
        kind === 'info'
          ? action
            ? await vscode.window.showInformationMessage(message, action)
            : await vscode.window.showInformationMessage(message)
          : await vscode.window.showErrorMessage(message),
      revealFile: (filePath) =>
        void vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(filePath)),
    },
    events: {
      progress: (p) => {
        void args.webview.postMessage({ kind: 'evt', event: 'evt:export.progress', payload: p });
      },
      done: (p) => {
        void args.webview.postMessage({ kind: 'evt', event: 'evt:export.done', payload: p });
      },
    },
    log: (line, level = 'info') => args.logger.write(level, line),
  });
}

/** 通知中心后台进度：M8 起导出不 await RPC，withProgress 仅作后台呈现（通知上可取消） */
function showBackgroundProgress(
  title: string,
  onCancel: () => void,
): Promise<{ close(): void }> {
  let closed = false;
  let started = false;
  let resolveFn: (() => void) | undefined;
  void vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title, cancellable: true },
    async (_progress, token) => {
      started = true;
      token.onCancellationRequested(onCancel);
      if (closed) {
        return;
      }
      await new Promise<void>((resolve) => {
        resolveFn = resolve;
      });
    },
  );
  return Promise.resolve({
    close: () => {
      closed = true;
      // close 早于 withProgress 回调启动时（微任务竞态），closed 标记保证回调直接返回
      if (started) {
        resolveFn?.();
      }
    },
  });
}

async function pickTargetFile(
  db: string,
  obj: string,
  format: ExportFormat,
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
