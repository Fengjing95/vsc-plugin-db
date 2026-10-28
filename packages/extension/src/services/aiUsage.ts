import * as vscode from 'vscode';
import { AiUsageResultSchema, type AiUsageResult } from '@db-explorer/protocol';
import type { AiTokenUsage } from '@db-explorer/core';
import type { Logger } from './logger';

/**
 * AI 用量统计（AI P2A 批次 A4，交互稿 §15.7 转正）：
 * 服务端 SSE usage 字段累计（未上报用量的服务不计入），workspaceState 持久化跨会话。
 * 密钥/prompt 内容永不入此（C-10）——只有数值。
 */

const KEY_REQUESTS = 'dbExplorer.aiUsage.requests';
const KEY_PROMPT = 'dbExplorer.aiUsage.promptTokens';
const KEY_COMPLETION = 'dbExplorer.aiUsage.completionTokens';

export class AiUsageStore {
  constructor(
    private readonly state: vscode.Memento,
    private readonly logger: Logger,
  ) {}

  get(): AiUsageResult {
    const requests = this.state.get<number>(KEY_REQUESTS, 0) ?? 0;
    const promptTokens = this.state.get<number>(KEY_PROMPT, 0) ?? 0;
    const completionTokens = this.state.get<number>(KEY_COMPLETION, 0) ?? 0;
    return AiUsageResultSchema.parse({
      requests,
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
    });
  }

  /** 用量回调（provider complete 的 onUsage 转发）：fire-and-forget，不阻塞 AI 调用主链路 */
  add(usage: AiTokenUsage): void {
    const prompt = Math.max(0, Math.floor(usage.promptTokens ?? 0));
    const completion = Math.max(0, Math.floor(usage.completionTokens ?? 0));
    if (prompt + completion <= 0) {
      return; // 服务端未上报（或全 0）不计
    }
    void this.state.update(KEY_REQUESTS, (this.state.get<number>(KEY_REQUESTS, 0) ?? 0) + 1);
    void this.state.update(KEY_PROMPT, (this.state.get<number>(KEY_PROMPT, 0) ?? 0) + prompt);
    void this.state.update(KEY_COMPLETION, (this.state.get<number>(KEY_COMPLETION, 0) ?? 0) + completion);
    this.logger.debug('ai', `AI 用量累计：prompt +${prompt} / completion +${completion}`);
  }
}
