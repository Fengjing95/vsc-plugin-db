// 连接表单场景（M8-PG）：验证 PostgreSQL 驱动 FormSchema 渲染——
// 默认库 hint 消歧（D-15）、高级组 section 小节、SSL/TLS toggle（sslInsecure 随 ssl 显隐）；
// B5：默认库聚焦动态建议（conn.dbOptions）——成功路径默认；URL 带 ?fail=1 验证失败无感降级
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
        { id: 'mysql', displayName: 'MySQL' },
        { id: 'postgres', displayName: 'PostgreSQL' },
        { id: 'redis', displayName: 'Redis' },
      ],
      config: null,
      schema: {
        fields: [
          { key: 'host', label: '主机', type: 'string', required: true, placeholder: '127.0.0.1' },
          { key: 'port', label: '端口', type: 'number', required: true, default: 3306, validator: 'port' },
        ],
      },
    }),
    'conn.dbOptions': (p) => {
      // 拉取计数（浏览器侧断言用）：window.__DBX_DBOPTIONS_CALLS
      window.__DBX_DBOPTIONS_CALLS = (window.__DBX_DBOPTIONS_CALLS ?? 0) + 1;
      if (new URLSearchParams(location.search).has('fail')) {
        throw new Error('E_CONN simulated'); // Host 正常不会 error 帧——传输层异常按无感降级验证
      }
      return { databases: ['postgres', 'app_db', 'reporting'] };
    },
    'conn.getSchema': (p) => {
      // M8-PG：postgres 驱动字段集（镜像 driver-postgres formSchema，含 D-15 hint 消歧）
      if (p && p.driverId === 'postgres') {
        return {
          schema: {
            fields: [
              { key: 'host', label: '主机', type: 'string', required: true, placeholder: '127.0.0.1' },
              { key: 'port', label: '端口', type: 'number', required: true, default: 5432, validator: 'port' },
              { key: 'username', label: '用户名', type: 'string', required: true },
              { key: 'password', label: '密码', type: 'password' },
              {
                key: 'database',
                label: '默认库',
                type: 'string',
                placeholder: 'postgres',
                hint: 'PG 数据库名（连接级绑定，PG 协议不可跨库切换）；树上展开的「库」为该数据库内的 schema',
                dynamicOptions: 'databases',
              },
              { key: 'connectTimeout', label: '连接超时（ms）', type: 'number', default: 10000, group: '高级', section: '超时与连接池' },
              { key: 'maxConnections', label: '连接池上限', type: 'number', default: 4, group: '高级', section: '超时与连接池' },
              { key: 'ssl', label: '启用 SSL', type: 'boolean', default: false, group: '高级', section: 'SSL/TLS' },
              {
                key: 'sslInsecure',
                label: '跳过证书校验',
                type: 'boolean',
                default: false,
                group: '高级',
                section: 'SSL/TLS',
                toggle: 'ssl',
                hint: '不校验服务器证书（sslmode=require）——存在中间人风险，仅用于开发/自签环境',
              },
            ],
          },
        };
      }
      if (p && p.driverId === 'mysql') {
        return {
          schema: {
            fields: [
              { key: 'host', label: '主机', type: 'string', required: true, placeholder: '127.0.0.1' },
              { key: 'port', label: '端口', type: 'number', required: true, default: 3306, validator: 'port' },
            ],
          },
        };
      }
      return { schema: { fields: [] } };
    },
    'conn.test': () => ({ ok: true, latencyMs: 8, serverVersion: 'PostgreSQL 16.4' }),
    'conn.save': () => ({ connId: 'new-pg-conn' }),
  },
};
