import { useEffect, useState } from 'react';
import type { AiSettingsResult, AiUsageResult } from '@db-explorer/protocol';
import { Button } from '../../components/ui/button';
import { rpcErrorText } from '../../lib/errors';
import { t } from '../../lib/i18n';
import { RpcError, request } from '../../rpc/client';

type TestPhase = 'idle' | 'testing' | 'ok' | 'fail';

/** 采样参数输入为文本框（留空 = 走模型默认），保存时经 settings.update 校验写回 */
interface SamplingDraft {
  temperature: string;
  maxTokens: string;
}

/**
 * AI 设置页（M9-AI / D-24 / 交互稿 §15.1）：BYOK 配置单例面板。
 * - endpoint/model 落 VSCode settings；API 密钥只进 SecretStorage——**永不回显明文**，
 *   已配置时占位提示「留空保持不变」；「清除」经 clearKey 语义
 * - 测试连接按表单当前值（含未保存的密钥）发最小请求，成功显示模型与耗时
 * - AI P2A 批次 A4：采样参数（temperature/maxTokens，settings.update 白名单代理编辑）+
 *   用量统计（SSE usage 字段累计，workspaceState 持久化）
 * - 底部固定隐私说明（表结构将发送给你配置的服务；表数据不会发送）
 */
export function AiSection() {
  const [endpoint, setEndpoint] = useState('');
  const [model, setModel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [hasKey, setHasKey] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testPhase, setTestPhase] = useState<TestPhase>('idle');
  const [testInfo, setTestInfo] = useState('');
  const [testError, setTestError] = useState('');
  const [sampling, setSampling] = useState<SamplingDraft>({ temperature: '', maxTokens: '' });
  const [usage, setUsage] = useState<AiUsageResult | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const s = await request<AiSettingsResult>('ai.getSettings', {});
        if (cancelled) return;
        setEndpoint(s.endpoint);
        setModel(s.model);
        setHasKey(s.hasKey);
      } catch {
        if (!cancelled) setTestError(t('settings.ai.loadFailed'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    // 采样参数与用量走 settings.get 白名单读（AI P2A A4；ai.* 无此键——落 settings 中心代理编辑）
    void (async () => {
      try {
        const raw = await request<{ values: Record<string, unknown> }>('settings.get', {});
        if (cancelled) return;
        setSampling({
          temperature: raw.values['dbExplorer.ai.temperature'] === undefined ? '' : String(raw.values['dbExplorer.ai.temperature']),
          maxTokens: raw.values['dbExplorer.ai.maxTokens'] === undefined ? '' : String(raw.values['dbExplorer.ai.maxTokens']),
        });
      } catch {
        // 设置读取失败不阻塞主表单（samplingHint 兜底模型默认）
      }
      try {
        const u = await request<AiUsageResult>('ai.usage', {});
        if (!cancelled) setUsage(u);
      } catch {
        // 用量读取失败静默（旧版 Host 无该 RPC）
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const errorTextOf = (err: unknown): string => {
    // 完整原因透传（实机反馈：401/超时/模型名错的 detail 在 message 里，不能只给模板文案）
    if (err instanceof RpcError) {
      return rpcErrorText(err);
    }
    return err instanceof Error ? err.message : String(err);
  };

  /** 采样参数保存（A4）：留空 = 不改动；非法值由 settingsHub 分型校验拒绝（行内报错） */
  const saveSampling = async (): Promise<void> => {
    setSaving(true);
    setTestError('');
    try {
      for (const [key, value] of [
        ['dbExplorer.ai.temperature', sampling.temperature],
        ['dbExplorer.ai.maxTokens', sampling.maxTokens],
      ] as const) {
        if (value.trim() === '') {
          continue;
        }
        await request('settings.update', { key, value: Number(value) });
      }
      setTestInfo(t('settings.ai.saved'));
    } catch (err) {
      setTestError(errorTextOf(err));
    } finally {
      setSaving(false);
    }
  };

  const save = async (extra?: { clearKey?: boolean }): Promise<void> => {
    setSaving(true);
    setTestError('');
    try {
      const result = await request<AiSettingsResult>('ai.saveSettings', {
        endpoint,
        model,
        ...(extra?.clearKey ? { clearKey: true } : apiKey ? { apiKey } : {}),
      });
      setHasKey(result.hasKey);
      setApiKey('');
      setTestInfo(extra?.clearKey ? t('settings.ai.cleared') : t('settings.ai.saved'));
    } catch (err) {
      setTestError(t('settings.ai.saveFailed', [errorTextOf(err)]));
    } finally {
      setSaving(false);
    }
  };

  const test = async (): Promise<void> => {
    setTestPhase('testing');
    setTestInfo('');
    setTestError('');
    try {
      const result = await request<{ ok: boolean; latencyMs?: number; model?: string }>(
        'ai.testSettings',
        { endpoint, model, ...(apiKey ? { apiKey } : {}) },
        90_000,
      );
      setTestPhase('ok');
      setTestInfo(t('settings.ai.testOk', [result.model ?? model, result.latencyMs ?? 0]));
    } catch (err) {
      setTestPhase('fail');
      setTestError(errorTextOf(err));
    }
  };

  const canSubmit = endpoint.trim() !== '' && model.trim() !== '' && !loading;

  return (
    <div className="flex w-full max-w-xl flex-col gap-4">
      <div className="flex flex-col gap-4">
        <div>
          <h2 className="text-[15px] font-semibold">{t('settings.ai.title')}</h2>
          <p className="mt-1 text-[12px] text-muted-foreground">{t('settings.ai.desc')}</p>
        </div>

        <label className="flex flex-col gap-1">
          <span className="text-[12px] font-medium">{t('settings.ai.endpoint')}</span>
          <input
            type="text"
            value={endpoint}
            onChange={(e) => setEndpoint(e.target.value)}
            placeholder="https://api.openai.com/v1"
            disabled={loading}
            className="h-8 rounded-sm border border-border bg-input px-2 text-[13px] outline-none focus:border-primary"
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-[12px] font-medium">{t('settings.ai.apiKey')}</span>
          <div className="flex gap-2">
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={hasKey ? t('settings.ai.keyConfigured') : 'sk-…'}
              disabled={loading}
              autoComplete="off"
              className="h-8 flex-1 rounded-sm border border-border bg-input px-2 text-[13px] outline-none focus:border-primary"
            />
            <Button
              variant="secondary"
              disabled={loading || saving || !hasKey}
              onClick={() => void save({ clearKey: true })}
            >
              {t('settings.ai.clear')}
            </Button>
          </div>
          <span className="text-[11px] text-muted-foreground">{t('settings.ai.keyNote')}</span>
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-[12px] font-medium">{t('settings.ai.model')}</span>
          <input
            type="text"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder="deepseek-chat"
            disabled={loading}
            className="h-8 rounded-sm border border-border bg-input px-2 text-[13px] outline-none focus:border-primary"
          />
        </label>

        {/* 行内错误 / 结果（交互稿 §15.1 测试连接状态机） */}
        {testError !== '' && (
          <div role="alert" className="rounded-sm border border-destructive/40 px-3 py-2 text-[12px] text-destructive">
            {testError}
          </div>
        )}
        {testInfo !== '' && testError === '' && (
          <div role="status" className="rounded-sm border border-border bg-panel px-3 py-2 text-[12px] text-muted-foreground">
            {testInfo}
          </div>
        )}

        <div className="flex gap-2">
          <Button disabled={!canSubmit || saving} onClick={() => void save()}>
            {saving ? t('settings.ai.saving') : t('settings.save')}
          </Button>
          <Button variant="secondary" disabled={!canSubmit || testPhase === 'testing'} onClick={() => void test()}>
            {testPhase === 'testing' ? t('settings.ai.testing') : t('settings.ai.testButton')}
          </Button>
        </div>

        {/* AI P2A 批次 A4：采样参数（settings.update 白名单代理编辑；留空 = 模型默认） */}
        <div className="mt-2 flex flex-col gap-3 border-t border-border pt-4">
          <div>
            <h3 className="text-[13px] font-semibold">{t('settings.ai.samplingTitle')}</h3>
            <p className="mt-1 text-[11px] text-muted-foreground">{t('settings.ai.samplingDesc')}</p>
          </div>
          <label className="flex flex-col gap-1">
            <span className="text-[12px] font-medium">{t('settings.ai.temperature')}</span>
            <input
              type="number"
              min={0}
              max={2}
              step={0.1}
              value={sampling.temperature}
              onChange={(e) => setSampling((s) => ({ ...s, temperature: e.target.value }))}
              placeholder="0.7"
              className="h-8 w-40 rounded-sm border border-border bg-input px-2 text-[13px] outline-none focus:border-primary"
            />
            <span className="text-[11px] text-muted-foreground">{t('settings.ai.temperatureDesc')}</span>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[12px] font-medium">{t('settings.ai.maxTokens')}</span>
            <input
              type="number"
              min={1}
              step={1}
              value={sampling.maxTokens}
              onChange={(e) => setSampling((s) => ({ ...s, maxTokens: e.target.value }))}
              placeholder="2048"
              className="h-8 w-40 rounded-sm border border-border bg-input px-2 text-[13px] outline-none focus:border-primary"
            />
            <span className="text-[11px] text-muted-foreground">{t('settings.ai.maxTokensDesc')}</span>
          </label>
          <div>
            <Button variant="secondary" disabled={saving} onClick={() => void saveSampling()}>
              {saving ? t('settings.ai.saving') : t('settings.save')}
            </Button>
          </div>
        </div>

        {/* AI P2A 批次 A4：用量统计（SSE usage 累计；未上报用量的服务不计入） */}
        <div className="mt-2 flex flex-col gap-1 border-t border-border pt-4">
          <h3 className="text-[13px] font-semibold">{t('settings.ai.usageTitle')}</h3>
          <div role="status" className="text-[12px] text-panel-foreground">
            {usage && usage.requests > 0
              ? t('settings.ai.usageLine', [usage.requests, usage.promptTokens, usage.completionTokens, usage.totalTokens])
              : t('settings.ai.usageEmpty')}
          </div>
          <p className="text-[11px] text-muted-foreground">{t('settings.ai.usageNote')}</p>
        </div>

        {/* 固定隐私说明（交互稿 §15.1，不可关闭） */}
        <div className="mt-2 rounded-sm border border-border bg-panel px-3 py-2 text-[11px] leading-5 text-muted-foreground">
          {t('settings.ai.privacyLead')}
          <strong>{t('settings.ai.privacySchema')}</strong>
          {t('settings.ai.privacyMid')}
          <strong>{t('settings.ai.privacyNoData')}</strong>
          {t('settings.ai.privacyTail')}
        </div>
      </div>
    </div>
  );
}
