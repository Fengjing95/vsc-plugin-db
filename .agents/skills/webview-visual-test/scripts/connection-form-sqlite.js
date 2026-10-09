// 连接表单场景：M8-SQLite——SQLite 类型卡片（品牌图标）+ 文件路径 file 控件（输入框+浏览按钮，
// 浏览经 sys.pickFile 原生选择，stub 回放选中路径验证回填链路）+ 只读高级开关。
// 注意（P-47）：本场景 schema 是手写镜像，须与 driver-sqlite index.ts 的 formSchema 同步维护。
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
    // 浏览按钮（file 控件）数据源：模拟原生对话框选中结果（取消场景 path=null 由页面吞掉）
    'sys.pickFile': () => ({ path: '/Users/demo/data/app.db' }),
    'conn.getMeta': () => ({
      drivers: [
        { id: 'mysql', displayName: 'MySQL' },
        { id: 'postgres', displayName: 'PostgreSQL' },
        { id: 'redis', displayName: 'Redis' },
        { id: 'sqlite', displayName: 'SQLite' },
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
      // SQLite 字段（镜像 createSqliteDriver().getConnectionFormSchema()）：
      // path（string 必填 + hint）+ readonly（高级组布尔）
      if (p && p.driverId === 'sqlite') {
        return {
          schema: {
            fields: [
              {
                key: 'path',
                label: '数据库文件路径',
                type: 'file',
                required: true,
                placeholder: '~/data/app.db',
                hint: 'SQLite 单文件数据库；支持 ~（主目录）与相对工作区路径；文件必须已存在（不会自动创建）',
              },
              {
                key: 'readonly',
                label: '以只读打开',
                type: 'boolean',
                default: false,
                group: '高级',
                hint: '只读模式下拒绝写入语句，且永不写回文件',
              },
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
    'conn.test': () => ({ ok: true, latencyMs: 3, serverVersion: '3.49.1' }),
    'conn.save': () => ({ connId: 'new-conn-id' }),
  },
};
