/** 错误码 → 文案基准（交互稿 §9.2：UI 只认 code，不解析 message 文本） */
const CODE_MESSAGES: Record<string, string> = {
  E_AUTH: '认证失败：请检查用户名/密码',
  E_CONN: '无法连接到数据库（网络不可达或连接中断）',
  E_TIMEOUT: '操作超时，可在设置中调整超时时间',
  E_READONLY: '连接已开启只读保护，写操作被拒绝',
  E_CONFLICT: '数据已被他人修改，请刷新后重试',
  E_CONSTRAINT: '违反约束（唯一键/外键/非空）',
  E_PERMISSION: '当前用户权限不足',
  E_NOT_FOUND: '对象不存在，可能已被删除',
  E_VALIDATION: '请求参数非法',
  E_UNSUPPORTED: '当前驱动不支持该能力',
  E_CAPACITY: '结果超出上限',
  E_CANCELED: '已取消',
  E_UNKNOWN_METHOD: '插件与视图版本不一致，请重载窗口',
  // M9-AI（D-24 / 交互稿 §15.5）
  E_AI_NOT_CONFIGURED: 'AI 功能需要先配置模型服务',
  E_AI_REQUEST_FAILED: 'AI 服务请求失败',
  E_AI_ABORTED: '已取消',
};

export function errorCodeToMessage(code: string | undefined, fallback: string): string {
  if (code !== undefined && CODE_MESSAGES[code] !== undefined) {
    return `${CODE_MESSAGES[code]}（${code}）`;
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
  const base = err.code !== undefined ? CODE_MESSAGES[err.code] : undefined;
  if (base !== undefined) {
    return detail !== '' && detail !== base ? `${base}：${detail}` : base;
  }
  return detail !== '' ? detail : (err.code ?? '操作失败');
}
