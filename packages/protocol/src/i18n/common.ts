/** common 域词表（D-25/C-17）：跨页面复用的通用文案。zh 值=UI 原文逐字节；en 同步对译。 */
export const zhCommon = {
  'common.retry': '重试',
  'common.close': '关闭',
  'common.cancel': '取消',
  'common.copy': '复制',
  'common.loading': '加载中…',
  'common.operationFailed': '操作失败',
} as const;

export type CommonKey = keyof typeof zhCommon;

export const enCommon: Partial<Record<CommonKey, string>> = {
  'common.retry': 'Retry',
  'common.close': 'Close',
  'common.cancel': 'Cancel',
  'common.copy': 'Copy',
  'common.loading': 'Loading…',
  'common.operationFailed': 'Operation failed',
};
