import { describe, expect, it } from 'vitest';
import { OpenAICompatProvider, extractOpenAiEvent, joinUrl, parseSseFrame } from './aiProvider';

describe('parseSseFrame', () => {
  it('单帧解析（data: 前缀）', () => {
    const { events, rest } = parseSseFrame('data: {"a":1}\n\n');
    expect(events).toEqual(['{"a":1}']);
    expect(rest).toBe('');
  });

  it('多帧一次到齐', () => {
    const { events, rest } = parseSseFrame('data: a\n\ndata: b\n\n');
    expect(events).toEqual(['a', 'b']);
    expect(rest).toBe('');
  });

  it('半帧留余量', () => {
    const { events, rest } = parseSseFrame('data: a\n\ndata: b');
    expect(events).toEqual(['a']);
    expect(rest).toBe('data: b');
  });

  it('\\r\\n 帧分隔与 \\r\\n 行尾', () => {
    const { events } = parseSseFrame('data: x\r\n\r\ndata: y\r\n\r\n');
    expect(events).toEqual(['x', 'y']);
  });

  it('非 data 行（event:/注释）忽略', () => {
    const { events } = parseSseFrame('event: delta\ndata: v\n\n: keep-alive\n\n');
    expect(events).toEqual(['v']);
  });
});

describe('extractOpenAiEvent', () => {
  it('choices[0].delta.content', () => {
    expect(extractOpenAiEvent('{"choices":[{"delta":{"content":"Hi"}}]}')).toEqual({
      content: 'Hi',
      reasoning: null,
      usage: null,
    });
  });

  it('reasoning_content / reasoning 双字段取推理过程', () => {
    expect(
      extractOpenAiEvent('{"choices":[{"delta":{"reasoning_content":"思考中"}}]}'),
    ).toEqual({ content: null, reasoning: '思考中', usage: null });
    expect(extractOpenAiEvent('{"choices":[{"delta":{"reasoning":"thinking"}}]}')).toEqual({
      content: null,
      reasoning: 'thinking',
      usage: null,
    });
  });

  it('[DONE] 双 null', () => {
    expect(extractOpenAiEvent('[DONE]')).toEqual({ content: null, reasoning: null, usage: null });
  });

  it('空 delta / 非 JSON 双 null', () => {
    expect(extractOpenAiEvent('{"choices":[{"delta":{}}]}')).toEqual({
      content: null,
      reasoning: null,
      usage: null,
    });
    expect(extractOpenAiEvent('not-json')).toEqual({ content: null, reasoning: null, usage: null });
  });

  it('usage 字段解析（A4 用量统计，OpenAI 口径）', () => {
    expect(
      extractOpenAiEvent(
        '{"choices":[{"delta":{}}],"usage":{"prompt_tokens":12,"completion_tokens":34,"total_tokens":46}}',
      ),
    ).toEqual({
      content: null,
      reasoning: null,
      usage: { promptTokens: 12, completionTokens: 34, totalTokens: 46 },
    });
    // 部分 token 字段缺失 → undefined 缺省（不虚构 0）
    expect(extractOpenAiEvent('{"usage":{"total_tokens":46}}')?.usage).toEqual({
      promptTokens: undefined,
      completionTokens: undefined,
      totalTokens: 46,
    });
    // 无 usage → null（不触发 onUsage）
    expect(extractOpenAiEvent('{"choices":[{"delta":{"content":"x"}}]}')?.usage).toBeNull();
  });

  it('message.content 兜底（非流式形态）', () => {
    expect(extractOpenAiEvent('{"choices":[{"message":{"content":"done"}}]}')).toEqual({
      content: 'done',
      reasoning: null,
      usage: null,
    });
  });
});

describe('joinUrl', () => {
  it('base 去尾斜杠拼接路径', () => {
    expect(joinUrl('https://api.openai.com/v1', '/chat/completions')).toBe(
      'https://api.openai.com/v1/chat/completions',
    );
    expect(joinUrl('https://api.openai.com/v1/', '/chat/completions')).toBe(
      'https://api.openai.com/v1/chat/completions',
    );
  });
});

describe('OpenAICompatProvider', () => {
  const sseResponse = (frames: string[], status = 200) =>
    ({
      ok: status >= 200 && status < 300,
      status,
      text: async () =>
        status === 401 ? '{"error":{"message":"bad key"}}' : `upstream error (${status})`,
      body: (async function* () {
        for (const f of frames) {
          yield new TextEncoder().encode(f);
        }
      })(),
    }) as unknown as Response;

  it('请求形状（URL/headers/body）与增量回调、完整返回', async () => {
    let captured: { url: string; init: RequestInit } | undefined;
    const provider = new OpenAICompatProvider({
      endpoint: 'https://api.example.com/v1',
      apiKey: 'sk-test',
      model: 'demo-model',
      fetchImpl: async (url, init) => {
        captured = { url: String(url), init: init ?? {} };
        return sseResponse([
          'data: {"choices":[{"delta":{"content":"SEL"}}]}\n\n',
          'data: {"choices":[{"delta":{"content":"ECT 1"}}]}\n\n',
          'data: [DONE]\n\n',
        ]);
      },
    });
    const deltas: string[] = [];
    const text = await provider.complete({
      system: 's',
      prompt: 'u',
      onDelta: (d) => deltas.push(d),
    });
    expect(text).toBe('SELECT 1');
    expect(deltas).toEqual(['SEL', 'ECT 1']);
    expect(captured?.url).toBe('https://api.example.com/v1/chat/completions');
    const headers = captured?.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer sk-test');
    const body = JSON.parse(String(captured?.init.body));
    expect(body.model).toBe('demo-model');
    expect(body.stream).toBe(true);
    expect(body.messages).toEqual([
      { role: 'system', content: 's' },
      { role: 'user', content: 'u' },
    ]);
  });

  it('跨 chunk 粘包/半帧正确组装', async () => {
    const provider = new OpenAICompatProvider({
      endpoint: 'https://x/v1',
      apiKey: 'k',
      model: 'm',
      fetchImpl: async () =>
        sseResponse([
          'data: {"choices":[{"delta":{"content":"A"}}]}\n\nda',
          'ta: {"choices":[{"delta":{"content":"B"}}]}\n\n',
        ]),
    });
    const text = await provider.complete({ system: '', prompt: '' });
    expect(text).toBe('AB');
  });

  it('401 映射 E_AI_REQUEST_FAILED（带服务端 message）', async () => {
    const provider = new OpenAICompatProvider({
      endpoint: 'https://x/v1',
      apiKey: 'bad',
      model: 'm',
      fetchImpl: async () => sseResponse([], 401),
    });
    await expect(provider.complete({ system: '', prompt: '' })).rejects.toMatchObject({
      code: 'E_AI_REQUEST_FAILED',
      message: expect.stringContaining('bad key'),
    });
  });

  it('HTTP 500 映射 E_AI_REQUEST_FAILED', async () => {
    const provider = new OpenAICompatProvider({
      endpoint: 'https://x/v1',
      apiKey: 'k',
      model: 'm',
      fetchImpl: async () => sseResponse([], 500),
    });
    await expect(provider.complete({ system: '', prompt: '' })).rejects.toMatchObject({
      code: 'E_AI_REQUEST_FAILED',
    });
  });

  it('signal 中止映射 E_AI_ABORTED', async () => {
    const provider = new OpenAICompatProvider({
      endpoint: 'https://x/v1',
      apiKey: 'k',
      model: 'm',
      fetchImpl: (async (_url: string, init?: RequestInit) => {
        // 模拟：调用方 abort 传播后 fetch 以 AbortError 拒绝
        const signal = init?.signal as AbortSignal;
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () =>
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
          );
        });
      }) as typeof fetch,
    });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 10);
    await expect(
      provider.complete({ system: '', prompt: '', signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'E_AI_ABORTED' });
  });
});
