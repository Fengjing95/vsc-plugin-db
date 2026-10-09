// 连接表单场景：M8-Mongo——MongoDB 类型卡片（品牌图标 mongodb，注册即出现）+ 最小字段集表单
// （host/port/username/password/authDatabase/默认库 dynamicOptions）+ 高级组 directConnection 开关。
// 注意（P-47）：本场景 schema 是手写镜像，须与 driver-mongo index.ts 的 formSchema 同步维护。
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
    // 默认库 dynamicOptions='databases' 数据源：字段聚焦时触发（镜像 conn.dbOptions → listDatabaseOptions）
    'conn.dbOptions': () => ({ databases: ['cf_mongo', 'appdata', 'analytics'] }),
    'conn.getMeta': () => ({
      drivers: [
        { id: 'mysql', displayName: 'MySQL' },
        { id: 'postgres', displayName: 'PostgreSQL' },
        { id: 'redis', displayName: 'Redis' },
        { id: 'mongodb', displayName: 'MongoDB' },
      ],
      config: null,
      schema: {
        // 默认驱动（mysql）字段——非本场景重点，给最小集
        fields: [
          { key: 'host', label: '主机', type: 'string', required: true, placeholder: '127.0.0.1' },
          { key: 'port', label: '端口', type: 'number', required: true, default: 3306, validator: 'port' },
          { key: 'username', label: '用户名', type: 'string', required: true },
          { key: 'password', label: '密码', type: 'password' },
        ],
      },
    }),
    'conn.getSchema': (p) => {
      // MongoDB 字段（镜像 createMongoDriver().getConnectionFormSchema()）：
      // host/port 必填 + username/password 可选 + authDatabase 默认 admin +
      // database（dynamicOptions）+ 高级组 directConnection/connectTimeout
      if (p && p.driverId === 'mongodb') {
        return {
          schema: {
            fields: [
              { key: 'host', label: '主机', type: 'string', required: true, placeholder: '127.0.0.1', validator: 'host' },
              { key: 'port', label: '端口', type: 'number', required: true, default: 27017, validator: 'port' },
              { key: 'username', label: '用户名（可选）', type: 'string' },
              { key: 'password', label: '密码', type: 'password', hint: '留空 = 免认证实例' },
              { key: 'authDatabase', label: '认证库（authSource）', type: 'string', default: 'admin' },
              {
                key: 'database',
                label: '默认库（可选）',
                type: 'string',
                dynamicOptions: 'databases',
                hint: '树上的「库」为 MongoDB database（非库内 schema）',
              },
              {
                key: 'directConnection',
                label: '单机直连',
                type: 'boolean',
                default: true,
                group: '高级',
                hint: 'IP 直连目标的最稳口径；副本集自动发现可关闭',
              },
              { key: 'connectTimeout', label: '连接超时（ms）', type: 'number', default: 10000, group: '高级' },
            ],
          },
        };
      }
      // 驱动切换回 mysql：最小字段集（同 conn.getMeta）
      return {
        schema: {
          fields: [
            { key: 'host', label: '主机', type: 'string', required: true, placeholder: '127.0.0.1' },
            { key: 'port', label: '端口', type: 'number', required: true, default: 3306, validator: 'port' },
            { key: 'username', label: '用户名', type: 'string', required: true },
            { key: 'password', label: '密码', type: 'password' },
          ],
        },
      };
    },
    'conn.test': () => ({ ok: true, latencyMs: 5, serverVersion: '7.0.14' }),
    'conn.save': () => ({ connId: 'new-conn-id' }),
  },
};
