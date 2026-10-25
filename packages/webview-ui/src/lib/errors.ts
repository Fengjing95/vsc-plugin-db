import { t, type MessageKey } from './i18n';

/**
 * 错误码 → 文案基准（交互稿 §9.2：UI 只认 code，不解析 message 文本；C-6）。
 * i18n（D-25）：code → error.* 域键，词条在 protocol 词典（zh 源 + en 对译）；
 * 驱动抛出的 message 不翻译，作为 detail 原文拼接。
 */
const CODE_MESSAGE_KEYS: Record<string, MessageKey> = {
  E_AUTH: 'error.E_AUTH',
  E_CONN: 'error.E_CONN',
  E_TIMEOUT: 'error.E_TIMEOUT',
  E_READONLY: 'error.E_READONLY',
  E_CONFLICT: 'error.E_CONFLICT',
  E_CONSTRAINT: 'error.E_CONSTRAINT',
  E_PERMISSION: 'error.E_PERMISSION',
  E_NOT_FOUND: 'error.E_NOT_FOUND',
  E_VALIDATION: 'error.E_VALIDATION',
  E_UNSUPPORTED: 'error.E_UNSUPPORTED',
  E_CAPACITY: 'error.E_CAPACITY',
  E_CANCELED: 'error.E_CANCELED',
  E_UNKNOWN_METHOD: 'error.E_UNKNOWN_METHOD',
  // M9-AI（D-24 / 交互稿 §15.5）
  E_AI_NOT_CONFIGURED: 'error.E_AI_NOT_CONFIGURED',
  E_AI_REQUEST_FAILED: 'error.E_AI_REQUEST_FAILED',
  E_AI_ABORTED: 'error.E_AI_ABORTED',
};

export function errorCodeToMessage(code: string | undefined, fallback: string): string {
  const key = code !== undefined ? CODE_MESSAGE_KEYS[code] : undefined;
  if (key !== undefined) {
    return t('error.withCode', [t(key), code ?? '']);
  }
  return fallback;
}

/**
 * RPC 错误 → 完整文案（实机反馈：错误码映射模板会把 detail 吞掉，AI 类错误的
 * 具体原因——超时/401/模型名错——恰恰在 message 里）。已知码 = 模板 + 分隔 detail；
 * 未知码直接用 message（含 detail）。
 */
export function rpcErrorText(err: { code?: string; message: string }): string {
  const detail = err.message.replace(/^\[[A-Z_0-9]+\]\s*/, '').trim();
  const key = err.code !== undefined ? CODE_MESSAGE_KEYS[err.code] : undefined;
  if (key !== undefined) {
    const base = t(key);
    return detail !== '' && detail !== base ? t('error.withDetail', [base, detail]) : base;
  }
  return detail !== '' ? detail : (err.code ?? t('common.operationFailed'));
}
