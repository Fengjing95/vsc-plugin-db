import * as vscode from 'vscode';
import type { MetadataCache } from '@db-explorer/core';
import type { ConnectionManager } from './connectionManager';
import type { EditGuard } from './editGuard';
import { t } from './i18n';
import type { Logger } from './logger';
import { ImportTaskRunner, type ImportTaskBase } from './importTasks';

/**
 * 导入服务 VSCode 胶水（概要设计 §5.13 / ADR D-32）：任务引擎在 importTasks.ts
 * （纯层、可单测），此处只做 vscode UI 组装——数据文件选择对话框、通知中心后台进度、
 * 完成/失败回执。调度即回执 importId（护栏确认后），导入在 Host 后台分批执行。
 */
export function createImporter(
  args: {
    webview: vscode.Webview;
    connections: ConnectionManager;
    host: import('@db-explorer/core').DriverHost;
    cache: MetadataCache;
    editGuard: EditGuard;
    logger: Logger;
    batchRows: number;
    timeoutMs: number;
    /** 目标表名（文件选择对话框标题用） */
    objLabel: string;
  },
): ImportTaskRunner {
  const base: ImportTaskBase = {
    connections: args.connections,
    host: args.host,
    cache: args.cache,
    editGuard: args.editGuard,
    batchRows: args.batchRows,
    timeoutMs: args.timeoutMs,
  };
  return new ImportTaskRunner(base, {
    ui: {
      pickImportFile: async () => {
        const uris = await vscode.window.showOpenDialog({
          canSelectFiles: true,
          canSelectFolders: false,
          canSelectMany: false,
          title: t('导入数据到 "{0}"', [args.objLabel]),
          openLabel: t('导入'),
          filters: {
            [t('数据文件（CSV / JSON / NDJSON / Excel）')]: ['csv', 'json', 'ndjson', 'xlsx'],
          },
        });
        return uris?.[0]?.fsPath;
      },
      showProgress: (title, onCancel) => showBackgroundProgress(title, onCancel),
      showMessage: async (kind, message) =>
        kind === 'info'
          ? await vscode.window.showInformationMessage(message)
          : await vscode.window.showErrorMessage(message),
    },
    events: {
      progress: (p) => {
        void args.webview.postMessage({ kind: 'evt', event: 'evt:import.progress', payload: p });
      },
      done: (p) => {
        void args.webview.postMessage({ kind: 'evt', event: 'evt:import.done', payload: p });
      },
    },
    log: (line, level = 'info') => args.logger.write(level, line),
  });
}

/** 通知中心后台进度（与导出同构：通知上可取消，close 幂等） */
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
      if (started) {
        resolveFn?.();
      }
    },
  });
}
