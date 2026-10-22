import * as vscode from 'vscode';
import { DriverError, OpenAICompatProvider, type AiProvider } from '@db-explorer/core';
import {
  AiSaveSettingsParamsSchema,
  AiSettingsResultSchema,
  AiTestSettingsParamsSchema,
  type AiSettingsResult,
} from '@db-explorer/protocol';
import type { Logger } from './logger';

/**
 * AI 设置存取（M9-AI / D-24 / 交互稿 §15.1）：
 * - endpoint/model 落 VSCode settings（dbExplorer.ai.*，可同步可见）
 * - API 密钥只进 SecretStorage（`dbExplorer.secrets.ai`），永不回传明文（getSettings 只回 hasKey）
 * - resolveProvider 按当前配置实例化 OpenAI 兼容 provider；缺项抛 E_AI_NOT_CONFIGURED
 */

export const AI_SECRET_KEY = 'dbExplorer.secrets.ai';

/** 三个配置项齐备才算已配置（缺一即引导去设置页） */
export function aiConfigured(endpoint: string, model: string, hasKey: boolean): boolean {
  return endpoint.trim().length > 0 && model.trim().length > 0 && hasKey;
}

export class AiSettingsStore {
  constructor(
    private readonly secrets: vscode.SecretStorage,
    private readonly logger: Logger,
  ) {}

  private config(): { endpoint: string; model: string } {
    const conf = vscode.workspace.getConfiguration('dbExplorer.ai');
    return {
      endpoint: conf.get<string>('endpoint', '').trim(),
      model: conf.get<string>('model', '').trim(),
    };
  }

  async getSettings(): Promise<AiSettingsResult> {
    const { endpoint, model } = this.config();
    const hasKey = Boolean(await this.secrets.get(AI_SECRET_KEY));
    return AiSettingsResultSchema.parse({ endpoint, model, hasKey });
  }

  async isConfigured(): Promise<boolean> {
    const s = await this.getSettings();
    return aiConfigured(s.endpoint, s.model, s.hasKey);
  }

  async saveSettings(raw: unknown): Promise<AiSettingsResult> {
    const p = AiSaveSettingsParamsSchema.parse(raw);
    const endpoint = p.endpoint.trim();
    const model = p.model.trim();
    const conf = vscode.workspace.getConfiguration('dbExplorer.ai');
    await conf.update('endpoint', endpoint, vscode.ConfigurationTarget.Global);
    await conf.update('model', model, vscode.ConfigurationTarget.Global);
    if (p.clearKey) {
      await this.secrets.delete(AI_SECRET_KEY);
      this.logger.info('ai', '已清除 AI API 密钥');
    } else if (p.apiKey && p.apiKey.length > 0) {
      await this.secrets.store(AI_SECRET_KEY, p.apiKey);
      this.logger.info('ai', '已保存 AI API 密钥（SecretStorage）');
    }
    return this.getSettings();
  }

  /** 组装 provider；overrides 供「测试连接」用表单当前值（密钥缺省回落已存值） */
  async resolveProvider(overrides?: {
    endpoint?: string;
    model?: string;
    apiKey?: string;
  }): Promise<AiProvider> {
    const stored = this.config();
    const endpoint = (overrides?.endpoint ?? stored.endpoint).trim();
    const model = (overrides?.model ?? stored.model).trim();
    const apiKey =
      overrides?.apiKey?.length ? overrides.apiKey : (await this.secrets.get(AI_SECRET_KEY)) ?? '';
    const missing: string[] = [];
    if (!endpoint) {
      missing.push('API 地址');
    }
    if (!model) {
      missing.push('模型');
    }
    if (!apiKey) {
      missing.push('API 密钥');
    }
    if (missing.length > 0) {
      throw new DriverError('E_AI_NOT_CONFIGURED', `AI 功能需要先配置模型服务（缺 ${missing.join(' / ')}）`);
    }
    return new OpenAICompatProvider({ endpoint, model, apiKey });
  }

  /** 设置页「测试连接」：按表单当前值发最小请求，返回耗时；失败抛错由 webview 行内呈现 */
  async testSettings(raw: unknown): Promise<{ ok: true; latencyMs: number; model: string }> {
    const p = AiTestSettingsParamsSchema.parse(raw);
    const provider = await this.resolveProvider({
      endpoint: p.endpoint,
      model: p.model,
      apiKey: p.apiKey?.length ? p.apiKey : undefined,
    });
    const start = Date.now();
    await provider.complete({
      system: 'You are a connectivity probe. Reply with exactly: OK',
      prompt: 'ping',
      maxTokens: 8,
      temperature: 0,
    });
    const latencyMs = Date.now() - start;
    const model = (p.model || this.config().model).trim();
    this.logger.info('ai', `测试连接成功：${model} · ${latencyMs}ms`);
    return { ok: true, latencyMs, model };
  }
}
