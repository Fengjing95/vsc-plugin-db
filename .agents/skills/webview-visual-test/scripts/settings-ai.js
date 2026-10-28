// AI P2A 批次 A4 场景：设置中心 AI 分类——采样参数（temperature/maxTokens）+ 用量统计
window.__DBX_STUB__ = {
  delayMs: 40,
  bootstrap: {
    page: 'settings',
    viewId: 'settings',
    params: { category: 'ai' },
  },
  handlers: {
    'ai.getSettings': () => ({ endpoint: 'https://api.deepseek.com/v1', model: 'deepseek-chat', hasKey: true }),
    'ai.saveSettings': (p) => ({ endpoint: p.endpoint, model: p.model, hasKey: !p.clearKey }),
    'ai.testSettings': () => ({ ok: true, latencyMs: 412, model: 'deepseek-chat' }),
    // A4：用量统计（SSE usage 累计口径）
    'ai.usage': () => ({ requests: 23, promptTokens: 18450, completionTokens: 6120, totalTokens: 24570 }),
    'settings.get': () => ({
      version: '0.8.0',
      values: {
        'dbExplorer.query.maxRows': 1000,
        'dbExplorer.query.timeoutMs': 15000,
        'dbExplorer.connection.connectTimeoutMs': 10000,
        'dbExplorer.queries.directory': '',
        'dbExplorer.export.defaultFormat': 'csv',
        'dbExplorer.export.chunkRows': 1000,
        'dbExplorer.transaction.idleTimeoutMs': 300000,
        'dbExplorer.edit.allowNoPrimaryKey': false,
        'dbExplorer.ai.temperature': 0.7,
        'dbExplorer.ai.maxTokens': 2048,
      },
    }),
    'settings.update': (p) => {
      window.__SETTINGS_UPDATES__ = [...(window.__SETTINGS_UPDATES__ ?? []), p];
      // 模拟 Host 分型校验：temperature 负数拒绝（number0）、maxTokens ≤0 拒绝（number）
      if (p.key === 'dbExplorer.ai.temperature' && (typeof p.value !== 'number' || p.value < 0)) {
        throw { code: 'E_VALIDATION', message: `${p.key} 需要不小于 0 的数值` };
      }
      if (p.key === 'dbExplorer.ai.maxTokens' && (typeof p.value !== 'number' || p.value <= 0)) {
        throw { code: 'E_VALIDATION', message: `${p.key} 需要正数` };
      }
      return {};
    },
    'settings.openInVscodeSettings': () => ({}),
    'settings.hubAction': () => ({}),
  },
};
