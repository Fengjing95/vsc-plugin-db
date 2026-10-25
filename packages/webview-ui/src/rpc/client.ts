import type { RpcEvent, RpcFrame } from '@db-explorer/protocol';
import { t } from '../lib/i18n';

/**
 * Webview 侧 RPC 客户端（概要设计 7.4）：请求/响应 id 映射 + 超时。
 * 响应按协议在 App 层用 zod 校验（ADR D-06 双端校验的 Webview 侧）。
 * evt 帧（Host → Webview 单向推送）经 subscribe 分发给订阅者。
 */
declare global {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function acquireVsCodeApi(): any;
}

const api = acquireVsCodeApi();

type Pending = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  resolve: (value: any) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout> | undefined;
};

const pending = new Map<string, Pending>();
const eventListeners = new Set<(evt: RpcEvent) => void>();
let seq = 0;

window.addEventListener('message', (ev: MessageEvent) => {
  const frame = ev.data as RpcFrame;
  if (!frame || frame.kind === 'req') {
    return;
  }
  if (frame.kind === 'evt') {
    for (const listener of eventListeners) {
      listener(frame);
    }
    return;
  }
  const entry = pending.get(frame.id);
  if (!entry) {
    return;
  }
  pending.delete(frame.id);
  if (entry.timer !== undefined) {
    clearTimeout(entry.timer);
  }
  if (frame.ok) {
    entry.resolve(frame.result);
  } else {
    const { code, message } = frame.error ?? {};
    entry.reject(new RpcError(code ?? 'E_INTERNAL', message ?? t('console.requestFailed')));
  }
});

export class RpcError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(`[${code}] ${message}`);
    this.name = 'RpcError';
  }
}

/** 订阅 Host 推送事件；返回取消订阅函数 */
export function subscribeEvents(listener: (evt: RpcEvent) => void): () => void {
  eventListeners.add(listener);
  return () => eventListeners.delete(listener);
}

/** timeoutMs = 0 表示不限时（console.execute 靠 evt 推送；export.run 含 SaveDialog 用户交互，
 *  M8 起导出本体在 Host 后台执行，回执即时，此处不限时只为对话框留时间） */
export function request<T>(method: string, params?: unknown, timeoutMs = 30_000): Promise<T> {
  const id = `wv-${++seq}`;
  return new Promise<T>((resolve, reject) => {
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            pending.delete(id);
            reject(new Error(t('console.requestTimeout', [method])));
          }, timeoutMs)
        : undefined;
    pending.set(id, {
      resolve: resolve as (value: unknown) => void,
      reject,
      timer,
    });
    api.postMessage({ kind: 'req', id, method, params });
  });
}
