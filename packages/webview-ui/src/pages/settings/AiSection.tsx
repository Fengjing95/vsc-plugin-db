import { useEffect, useState } from 'react';
import type { AiSettingsResult } from '@db-explorer/protocol';
import { Button } from '../../components/ui/button';
import { rpcErrorText } from '../../lib/errors';
import { RpcError, request } from '../../rpc/client';

type TestPhase = 'idle' | 'testing' | 'ok' | 'fail';

/**
 * AI 设置页（M9-AI / D-24 / 交互稿 §15.1）：BYOK 配置单例面板。
 * - endpoint/model 落 VSCode settings；API 密钥只进 SecretStorage——**永不回显明文**，
 *   已配置时占位提示「留空保持不变」；「清除」经 clearKey 语义
 * - 测试连接按表单当前值（含未保存的密钥）发最小请求，成功显示模型与耗时
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
        if (!cancelled) setTestError('加载设置失败，请重载窗口重试');
      } finally {
        if (!cancelled) setLoading(false);
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
      setTestInfo(extra?.clearKey ? '已清除 API 密钥' : '设置已保存');
    } catch (err) {
      setTestError(`保存失败：${errorTextOf(err)}`);
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
      setTestInfo(`连接成功 · ${result.model ?? model} · ${result.latencyMs ?? 0}ms`);
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
          <h2 className="text-[15px] font-semibold">AI 设置</h2>
          <p className="mt-1 text-[12px] text-muted-foreground">
            配置 OpenAI 兼容的模型服务（OpenAI / DeepSeek / Moonshot / ollama / 企业网关等均可）。
          </p>
        </div>

        <label className="flex flex-col gap-1">
          <span className="text-[12px] font-medium">API 地址</span>
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
          <span className="text-[12px] font-medium">API 密钥</span>
          <div className="flex gap-2">
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={hasKey ? '••••••••（已配置，留空保持不变）' : 'sk-…'}
              disabled={loading}
              autoComplete="off"
              className="h-8 flex-1 rounded-sm border border-border bg-input px-2 text-[13px] outline-none focus:border-primary"
            />
            <Button
              variant="secondary"
              disabled={loading || saving || !hasKey}
              onClick={() => void save({ clearKey: true })}
            >
              清除
            </Button>
          </div>
          <span className="text-[11px] text-muted-foreground">
            密钥只保存在系统密钥库（SecretStorage），不会写入设置文件，也不会回显。
          </span>
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-[12px] font-medium">模型</span>
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
            {saving ? '保存中…' : '保存'}
          </Button>
          <Button variant="secondary" disabled={!canSubmit || testPhase === 'testing'} onClick={() => void test()}>
            {testPhase === 'testing' ? '测试中…' : '测试连接'}
          </Button>
        </div>

        {/* 固定隐私说明（交互稿 §15.1，不可关闭） */}
        <div className="mt-2 rounded-sm border border-border bg-panel px-3 py-2 text-[11px] leading-5 text-muted-foreground">
          使用 AI 功能时，当前库的<strong>表结构</strong>（表 / 列 / 类型 / 注释）将发送给你配置的服务；
          <strong>表数据不会发送</strong>。单库表较多时会先让你选择提供给 AI 的表。
        </div>
      </div>
    </div>
  );
}
