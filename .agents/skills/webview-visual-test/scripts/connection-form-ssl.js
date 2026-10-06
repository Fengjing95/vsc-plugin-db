// 连接表单场景：验证驱动 FormSchema hint 渲染（M7 批次 A-1：Redis ssl / sslInsecure 风险提示）
window.__DBX_STUB__ = {
  delayMs: 30,
  bootstrap: {
    page: 'connectionForm',
    viewId: 'form:new',
    params: { connId: '' },
  },
  handlers: {
    'sys.handshake': () => ({
      protocolVersion: 1,
      viewId: 'form',
      params: {},
      changeSet: { inserts: [], updates: [], deletes: [] },
      edit: { enabled: false, reason: '连接表单视图' },
      capabilities: { supportsSQL: false, supportsDdl: false },
    }),
    'conn.getMeta': () => ({
      drivers: [
        { id: 'redis', displayName: 'Redis' },
        { id: 'mysql', displayName: 'MySQL' },
      ],
      config: null,
      schema: {
        fields: [
          { key: 'host', label: '主机', type: 'string', required: true, placeholder: '127.0.0.1' },
          { key: 'port', label: '端口', type: 'number', required: true, default: 6379, validator: 'port' },
          { key: 'username', label: '用户名（ACL，可选）', type: 'string' },
          { key: 'password', label: '密码', type: 'password' },
          { key: 'database', label: '默认库编号', type: 'number', default: 0 },
          {
            key: 'ssl',
            label: 'SSL/TLS 加密连接',
            type: 'boolean',
            default: false,
            hint: '云托管 Redis（Upstash / Redis Cloud / Aiven 等）强制 TLS，须开启',
          },
          {
            key: 'sslInsecure',
            label: '跳过证书校验',
            type: 'boolean',
            default: false,
            group: '高级',
            hint: '⚠ 风险：不校验服务器证书，连接可被中间人窃听/篡改。仅限自签证书的受信内网环境使用',
          },
          { key: 'connectTimeout', label: '连接超时（ms）', type: 'number', default: 10000, group: '高级' },
        ],
      },
    }),
    'conn.getSchema': (p) => {
      // 驱动切换路径（M8 表单方案 A）：mysql 返回完整字段集；其余驱动沿用 redis 字段
      if (p && p.driverId === 'mysql') {
        return {
          schema: {
            fields: [
              { key: 'host', label: '主机', type: 'string', required: true, placeholder: '127.0.0.1' },
              { key: 'port', label: '端口', type: 'number', required: true, default: 3306, validator: 'port' },
              { key: 'username', label: '用户名', type: 'string', required: true },
              { key: 'password', label: '密码', type: 'password' },
              { key: 'database', label: '默认库', type: 'string' },
              {
                key: 'sslInsecure',
                label: '跳过证书校验',
                type: 'boolean',
                default: false,
                group: '高级',
                hint: '⚠ 风险：不校验服务器证书，连接可被中间人窃听/篡改。仅限自签证书的受信内网环境使用',
              },
              { key: 'connectTimeout', label: '连接超时（ms）', type: 'number', default: 10000, group: '高级' },
            ],
          },
        };
      }
      return { schema: { fields: [] } };
    },
    'conn.test': () => ({ ok: true, latencyMs: 8, serverVersion: '7.2.5' }),
    'conn.save': () => ({ connId: 'new-conn-id' }),
  },
};
