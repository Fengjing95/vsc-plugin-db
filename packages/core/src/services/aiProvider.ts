/**
 * AI provider 抽象与 OpenAI 兼容实现（概要 §5.12 / ADR D-24）：
 * - AiProvider：`complete({ system, prompt, signal, onDelta })` 流式接口，provider 可替换
 *   （BYOK OpenAI 兼容为首实现；VSCode LM API 等按需后续追加）
 * - OpenAICompatProvider：fetch 直连 chat/completions（stream: true）+ SSE 增量解析，
 *   零新依赖（Node 18 内置 fetch/ReadableStream）；错误统一映射 AiErrorCode（C-6）
 * 密钥只经构造参数瞬时进入本模块，不打日志、不落任何存储（C-10）。
 */
import { DriverError, type AiErrorCode } from '../driver/errors';

export interface AiCompletionRequest {
  system: string;
  prompt: string;
  signal?: AbortSignal;
  /** 流式增量回调（解释 Tab 流式渲染；生成/修复可不传，只取全量返回） */
  onDelta?: (delta: string) => void;
  temperature?: number;
  maxTokens?: number;
}

export interface AiProvider {
  /** 稳定标识（日志/设置页展示用） */
  readonly id: string;
  /** 模型标识（日志打点用——日志只记模型名与长度，不记 prompt 原文，C-10/§15.6） */
  readonly modelId: string;
  complete(req: AiCompletionRequest): Promise<string>;
}

export interface OpenAiCompatConfig {
  /** OpenAI 兼容 base URL（如 https://api.openai.com/v1），不含 /chat/completions */
  endpoint: string;
  apiKey: string;
  model: string;
  /** 请求死线（毫秒），缺省 60s——LLM 生成本就偏慢，比驱动 query 超时宽 */
  timeoutMs?: number;
  /** 测试注入点（缺省 globalThis.fetch） */
  fetchImpl?: typeof fetch;
}

/**
 * SSE 帧切分（纯函数）：按空行（\n\n / \r\n\r\n）分帧，只取 data: 行负载；
 * 不完整尾帧留余量待下一个 chunk。event: 行与 keep-alive 注释行忽略。
 */
export function parseSseFrame(buffer: string): { events: string[]; rest: string } {
  const events: string[] = [];
  let rest = buffer;
  for (;;) {
    const idx = rest.search(/\r?\n\r?\n/);
    if (idx < 0) {
      break;
    }
    const frame = rest.slice(0, idx);
    rest = rest.slice(idx).replace(/^\r?\n\r?\n/, '');
    const dataLines = frame
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart());
    if (dataLines.length > 0) {
      events.push(dataLines.join('\n'));
    }
  }
  return { events, rest };
}

/** OpenAI 流式帧负载 → 增量文本：choices[0].delta.content；[DONE]/非 JSON/空 delta → null */
export function extractOpenAiDelta(data: string): string | null {
  if (data === '[DONE]') {
    return null;
  }
  try {
    const parsed = JSON.parse(data) as {
      choices?: Array<{ delta?: { content?: string }; message?: { content?: string } }>;
    };
    const delta = parsed.choices?.[0]?.delta?.content;
    if (typeof delta === 'string') {
      return delta;
    }
    // 部分 OpenAI 兼容服务对短回答直接回 message 形态，兜底取用（一次性增量）
    const message = parsed.choices?.[0]?.message?.content;
    return typeof message === 'string' ? message : null;
  } catch {
    return null;
  }
}

/** base URL 拼接路径（base 去尾斜杠，path 带首斜杠） */
export function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}${path}`;
}

interface Accumulator {
  text: string;
}

export class OpenAICompatProvider implements AiProvider {
  readonly id = 'openai-compat';
  private readonly config: Required<Omit<OpenAiCompatConfig, 'fetchImpl'>> & Pick<OpenAiCompatConfig, 'fetchImpl'>;
  private readonly fetchImpl: typeof fetch;

  get modelId(): string {
    return this.config.model;
  }

  constructor(config: OpenAiCompatConfig) {
    this.config = {
      endpoint: config.endpoint,
      apiKey: config.apiKey,
      model: config.model,
      timeoutMs: config.timeoutMs ?? 60_000,
      fetchImpl: config.fetchImpl,
    };
    this.fetchImpl = config.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  async complete(req: AiCompletionRequest): Promise<string> {
    const controller = new AbortController();
    let timedOut = false;
    const onExternalAbort = () => controller.abort();
    req.signal?.addEventListener('abort', onExternalAbort);
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.config.timeoutMs);

    const acc: Accumulator = { text: '' };
    try {
      const body: Record<string, unknown> = {
        model: this.config.model,
        stream: true,
        messages: [
          { role: 'system', content: req.system },
          { role: 'user', content: req.prompt },
        ],
      };
      if (req.temperature !== undefined) {
        body.temperature = req.temperature;
      }
      if (req.maxTokens !== undefined) {
        body.max_tokens = req.maxTokens;
      }
      const res = await this.fetchImpl(joinUrl(this.config.endpoint, '/chat/completions'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        throw await httpError(res);
      }
      const stream = res.body;
      if (!stream) {
        throw fail('E_AI_REQUEST_FAILED', 'AI 服务返回了空响应体');
      }
      let buffer = '';
      // undici/Node 18 fetch body 为 async iterable（DOM 类型不可迭代，经 unknown 中转）；
      // 逐 chunk 解码 + 跨 chunk 半帧缓冲
      for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
        buffer += new TextDecoder('utf-8').decode(chunk, { stream: true });
        const { events, rest } = parseSseFrame(buffer);
        buffer = rest;
        for (const data of events) {
          const delta = extractOpenAiDelta(data);
          if (delta !== null && delta !== '') {
            acc.text += delta;
            req.onDelta?.(delta);
          }
        }
      }
      // flush 残余（部分服务不带 [DONE] 直接关流，尾帧可能缺空行结尾）
      const { events } = parseSseFrame(`${buffer}\n\n`);
      for (const data of events) {
        const delta = extractOpenAiDelta(data);
        if (delta !== null && delta !== '') {
          acc.text += delta;
          req.onDelta?.(delta);
        }
      }
      return acc.text;
    } catch (err) {
      if (DriverError.is(err)) {
        throw err;
      }
      if (req.signal?.aborted) {
        throw fail('E_AI_ABORTED', '已取消');
      }
      if (controller.signal.aborted && timedOut && !req.signal?.aborted) {
        throw fail('E_AI_REQUEST_FAILED', `AI 服务请求超时（${this.config.timeoutMs}ms）`);
      }
      if (isAbortError(err)) {
        throw fail('E_AI_ABORTED', '已取消');
      }
      throw fail('E_AI_REQUEST_FAILED', err instanceof Error ? err.message : String(err));
    } finally {
      clearTimeout(timer);
      req.signal?.removeEventListener('abort', onExternalAbort);
    }
  }
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

function fail(code: AiErrorCode, message: string, detail?: string): DriverError {
  return new DriverError(code, message, { detail });
}

async function httpError(res: Response): Promise<DriverError> {
  let serverMessage = '';
  try {
    const text = await res.text();
    try {
      const parsed = JSON.parse(text) as { error?: { message?: string }; message?: string };
      serverMessage = parsed.error?.message ?? parsed.message ?? text;
    } catch {
      serverMessage = text;
    }
  } catch {
    // 读 body 失败不掩盖状态码语义
  }
  serverMessage = serverMessage.trim().slice(0, 200);
  const hint =
    res.status === 401 || res.status === 403
      ? '认证失败——请检查 API 密钥'
      : res.status === 404
        ? '地址或模型不存在——请检查 API 地址与模型名'
        : res.status === 429
          ? '请求过于频繁或配额不足'
          : `HTTP ${res.status}`;
  return fail(
    'E_AI_REQUEST_FAILED',
    serverMessage ? `${hint}：${serverMessage}` : hint,
    `HTTP ${res.status}`,
  );
}
