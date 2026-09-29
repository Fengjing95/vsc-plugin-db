import type { RpcFrame } from '@db-explorer/protocol';

/**
 * Webview 侧 RPC 客户端（概要设计 7.4）：请求/响应 id 映射 + 超时。
 * 响应按协议用 zod 在 App 层校验（ADR D-06 双端校验的 Webview 侧）。
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
  timer: ReturnType<typeof setTimeout>;
};

const pending = new Map<string, Pending>();
let seq = 0;

window.addEventListener('message', (ev: MessageEvent) => {
  const frame = ev.data as RpcFrame;
  if (!frame || frame.kind !== 'res') {
    return; // evt 帧的事件分发随 M3/M4 状态层接入
  }
  const entry = pending.get(frame.id);
  if (!entry) {
    return;
  }
  pending.delete(frame.id);
  clearTimeout(entry.timer);
  if (frame.ok) {
    entry.resolve(frame.result);
  } else {
    const { code, message } = frame.error ?? {};
    entry.reject(new Error(`[${code ?? 'E_INTERNAL'}] ${message ?? '请求失败'}`));
  }
});

export function request<T>(
  method: string,
  params?: unknown,
  timeoutMs = 30_000,
): Promise<T> {
  const id = `wv-${++seq}`;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`请求超时：${method}`));
    }, timeoutMs);
    pending.set(id, {
      resolve: resolve as (value: unknown) => void,
      reject,
      timer,
    });
    api.postMessage({ kind: 'req', id, method, params });
  });
}
