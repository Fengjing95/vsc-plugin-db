/** error 域词表（D-25/C-17）：错误码 → 文案映射（C-6：UI 只认 code，本表即 code→文案基准的本地化层）。
 * 键 = `error.<错误码>`；zh 值=webview lib/errors.ts 原文案逐字节；en 同步对译。 */
export const zhError = {
  'error.E_AUTH': '认证失败：请检查用户名/密码',
  'error.E_CONN': '无法连接到数据库（网络不可达或连接中断）',
  'error.E_TIMEOUT': '操作超时，可在设置中调整超时时间',
  'error.E_READONLY': '连接已开启只读保护，写操作被拒绝',
  'error.E_CONFLICT': '数据已被他人修改，请刷新后重试',
  'error.E_CONSTRAINT': '违反约束（唯一键/外键/非空）',
  'error.E_PERMISSION': '当前用户权限不足',
  'error.E_NOT_FOUND': '对象不存在，可能已被删除',
  'error.E_VALIDATION': '请求参数非法',
  'error.E_UNSUPPORTED': '当前驱动不支持该能力',
  'error.E_CAPACITY': '结果超出上限',
  'error.E_CANCELED': '已取消',
  'error.E_UNKNOWN_METHOD': '插件与视图版本不一致，请重载窗口',
  'error.E_AI_NOT_CONFIGURED': 'AI 功能需要先配置模型服务',
  'error.E_AI_REQUEST_FAILED': 'AI 服务请求失败',
  'error.E_AI_ABORTED': '已取消',
  // 拼接模板：错误码后缀 / detail 拼接（en 用半角标点，zh 保持原文标点）
  'error.withCode': '{0}（{1}）',
  'error.withDetail': '{0}：{1}',
} as const;

export type ErrorKey = keyof typeof zhError;

export const enError: Partial<Record<ErrorKey, string>> = {
  'error.E_AUTH': 'Authentication failed: check the username/password',
  'error.E_CONN': 'Cannot connect to the database (network unreachable or connection lost)',
  'error.E_TIMEOUT': 'The operation timed out; adjust the timeout in Settings',
  'error.E_READONLY': 'The connection is read-only; write operations are rejected',
  'error.E_CONFLICT': 'The data was modified by someone else; refresh and retry',
  'error.E_CONSTRAINT': 'Constraint violated (unique key / foreign key / not null)',
  'error.E_PERMISSION': 'Insufficient permissions for the current user',
  'error.E_NOT_FOUND': 'The object does not exist; it may have been dropped',
  'error.E_VALIDATION': 'Invalid request parameters',
  'error.E_UNSUPPORTED': 'The current driver does not support this capability',
  'error.E_CAPACITY': 'The result exceeds the limit',
  'error.E_CANCELED': 'Canceled',
  'error.E_UNKNOWN_METHOD': 'Extension and view versions mismatch; reload the window',
  'error.E_AI_NOT_CONFIGURED': 'AI requires a configured model service first',
  'error.E_AI_REQUEST_FAILED': 'The AI service request failed',
  'error.E_AI_ABORTED': 'Canceled',
  'error.withCode': '{0} ({1})',
  'error.withDetail': '{0}: {1}',
};
