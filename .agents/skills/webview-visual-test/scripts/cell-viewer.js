// 单元格查看器场景（交互稿 §4.6）：JSON 树/原文双 Tab + 二进制 hex/图片嗅探 + 超长文本编辑写回。
// handshake 声明 capabilities.lazyCell=true → 查看器经 cell.fetch 走按需拉取路径（加载态可截）。
const PNG_1PX =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const COLS = [
  { name: 'id', type: 'integer' },
  { name: 'name', type: 'string' },
  { name: 'meta', type: 'json' },
  { name: 'avatar', type: 'binary' },
  { name: 'doc', type: 'string' },
];

function rowValues(i) {
  return [
    i,
    `用户${i}`,
    {
      idx: i,
      tags: ['vip', 'beta'],
      profile: { city: '上海', level: i % 5, extras: ['x', 'y', 'z'] },
    },
    i === 1 ? PNG_1PX : btoa(`bin-${i}-${i}-${i}`),
    i === 1
      ? `这是第一行的超长说明文本。`.repeat(30)
      : `备注 ${i}`,
  ];
}

const ROWS = Array.from({ length: 12 }, (_, k) => rowValues(k + 1));

window.__DBX_STUB__ = {
  delayMs: 40,
  bootstrap: {
    page: 'table',
    viewId: 'cell-viewer-view',
    params: { connId: 'c1', db: 'demo', obj: 'wide', env: 'test', rowEstimate: '1000' },
  },
  handlers: {
    'sys.copyText': (p) => ({ written: (p?.text ?? '').length }),
    'sys.saveFile': () => ({ path: '/tmp/wide-avatar.bin' }),
    'sys.handshake': () => ({
      protocolVersion: 1,
      viewId: 'cell-viewer-view',
      params: {},
      changeSet: { inserts: [], updates: [], deletes: [] },
      edit: { enabled: true },
      capabilities: { supportsSQL: true, supportsDdl: true, lazyCell: true },
    }),
    'table.fetchRows': () => ({
      columns: COLS,
      rows: ROWS,
      rowCount: ROWS.length,
      totalCount: 1000,
      primaryKey: ['id'],
      executionMs: 8,
    }),
    'cell.fetch': (p) => {
      const row = ROWS.find((r) => r[0] === p?.rowKey?.id);
      if (!row) {
        throw { code: 'E_NOT_FOUND', message: '行不存在或已被删除' };
      }
      const idx = COLS.findIndex((c) => c.name === p?.column);
      if (idx < 0) {
        throw { code: 'E_VALIDATION', message: `列不存在: ${p?.column}` };
      }
      // 模拟真实驱动的整值返回（JSON 为对象、binary 为 base64、NULL=null）
      return { value: row[idx] };
    },
    'table.editChanges': () => ({ counts: { inserts: 0, updates: 0, deletes: 0 } }),
  },
};
