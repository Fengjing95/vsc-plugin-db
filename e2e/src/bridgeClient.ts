/** bridge HTTP 客户端：extension host 控制面（命令执行 / 状态读取） */

export interface BridgeState {
  language: string;
  version: string;
  workspaceFolders: string[];
  extensions: string[];
}

async function fetchJson(url: string, init?: RequestInit, timeoutMs = 10_000): Promise<{ code: number; body: unknown }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    const body = (await res.json()) as unknown;
    return { code: res.status, body };
  } finally {
    clearTimeout(timer);
  }
}

export class BridgeClient {
  constructor(private readonly baseUrl: string) {}

  /** 轮询到 bridge 就绪（onStartupFinished 激活有延迟） */
  async waitReady(timeoutMs = 60_000): Promise<BridgeState> {
    const deadline = Date.now() + timeoutMs;
    let lastErr: unknown;
    while (Date.now() < deadline) {
      try {
        const { code, body } = await fetchJson(`${this.baseUrl}/state`, undefined, 3000);
        if (code === 200) return body as BridgeState;
      } catch (err) {
        lastErr = err;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(`bridge 未就绪（${timeoutMs}ms）：${String(lastErr)}`);
  }

  async state(): Promise<BridgeState> {
    const { body } = await fetchJson(`${this.baseUrl}/state`);
    return body as BridgeState;
  }

  /** 执行 VSCode 命令；命令抛错不抛网络错，返回 ok:false（调用方按需断言） */
  async execute(command: string, ...args: unknown[]): Promise<{ ok: boolean; result?: unknown; error?: string }> {
    const { body } = await fetchJson(`${this.baseUrl}/execute`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ command, args }),
    });
    return body as { ok: boolean; result?: unknown; error?: string };
  }
}
