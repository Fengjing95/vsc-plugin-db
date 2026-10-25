import {
  DriverError,
  splitSqlStatements,
  type ApplyResult,
  type ChangeSet,
  type ColumnMeta,
  type CompletionSource,
  type DataTypeOption,
  type ConnectionConfig,
  type DatabaseMeta,
  type DatabaseSpec,
  type DdlStatement,
  type DriverCapabilities,
  type FetchRowsRequest,
  type FilterCondition,
  type FormSchema,
  type IConnection,
  type IDatabaseDriver,
  type IndexMeta,
  type ISession,
  type KeyMeta,
  type ObjectMeta,
  type PreviewItem,
  type QueryRequest,
  type ResultSet,
  type RowKey,
  type TableSpec,
  type TestResult,
} from '@db-explorer/core';
import { compileOrderBy, compileWhere } from './whereEval';
import { executeMockSelect, parseMockStatement } from './query';
import {
  buildMockAlterTable,
  buildMockCreateTable,
  executeMockDdlSql,
  isMockDdlStatement,
  type MockDdlRegistry,
} from './ddl';

/**
 * M0 演示驱动：纯内存数据源。
 * 用途：验证“实现 IDatabaseDriver + 注册即接入”的可插拔契约（核心代码 0 改动），
 * 并为资源树 / 表格视图开发提供稳定数据。
 * M4：实现内存版 previewChanges/applyChanges（驱动规范 §8 语义：字段级乐观锁、
 * IS NULL 匹配、失败整体回滚），数据为**共享物化存储**——跨连接一致（模拟真实
 * 服务端），冲突场景可经两个视图人为构造；测试用 resetMockStore() 复位。
 * M5：实现最小 SQL 执行（SELECT/INSERT/UPDATE/DELETE 子集，query.ts），
 * 本地无真实库时供 SQL Console 自测。
 */
export const MOCK_DRIVER_ID = 'mock';

/** 表结构编辑器类型建议词表（表设计器批次 A，交互稿 §12.3）：通用 SQL 词表（契约基准驱动，
 *  无方言），按常用度排序；建议不是白名单——词表外类型照常手输。 */
export const MOCK_DATA_TYPES: DataTypeOption[] = [
  { value: 'INTEGER' },
  { value: 'BIGINT' },
  { value: 'VARCHAR', template: 'VARCHAR()' },
  { value: 'TEXT' },
  { value: 'DECIMAL', template: 'DECIMAL(,)' },
  { value: 'BOOLEAN' },
  { value: 'DATE' },
  { value: 'DATETIME' },
  { value: 'TIMESTAMP' },
  { value: 'TIME' },
  { value: 'FLOAT' },
  { value: 'DOUBLE' },
  { value: 'CHAR', template: 'CHAR()' },
  { value: 'JSON' },
  { value: 'BLOB' },
];

const capabilities: DriverCapabilities = {
  supportsSQL: true, // M5 起支持最小 SQL 子集（Console 本地自测）；Redis 类 supportsSQL=false 走命令白名单
  supportsTransaction: true, // applyChanges 整体回滚（内存快照恢复）
  supportsInteractiveTransaction: true, // M7：openSession（缓冲写 + commit/rollback），交互式事务契约组覆盖
  supportsMultipleDatabases: true,
  supportsMultiStatement: false,
  supportsCancel: false,
  supportsDdl: false,
  supportsDdlEditor: true, // M8-B2：buildCreateTable/buildAlterTable + query() 执行 DDL（内存）
  supportsDatabaseDdl: true, // M8-DBDDL：buildCreateDatabase/buildAlterDatabase/buildDropDatabase（内存库列表）
  supportsErDiagram: true, // M8-ER：listKeys FK 元数据完整（关系收集契约基准，概要 §5.11 / D-22）
  lazyCell: true, // 单元格查看器批次：fetchCell 按需拉取（交互稿 §4.6；契约组 lazy-cell 基准）
  hierarchy: ['connection', 'database', 'folder', 'table', 'view', 'column'],
  editable: true,
  pagination: 'offset',
  // M8-PG B6：mock 是契约测试/DoD 基准驱动，不再作为可创建的连接类型暴露（概要 §7.1 测试用）
  internal: true,
};

const formSchema: FormSchema = {
  fields: [
    { key: 'host', label: '主机', type: 'string', required: true, placeholder: '127.0.0.1' },
    { key: 'port', label: '端口', type: 'number', required: true, default: 3306, validator: 'port' },
    { key: 'username', label: '用户名', type: 'string', required: true },
    { key: 'password', label: '密码', type: 'password' },
    { key: 'database', label: '默认库', type: 'string' },
    { key: 'readonly', label: '只读打开', type: 'boolean', group: '高级' },
  ],
};

interface TableDef {
  kind: 'table' | 'view';
  comment?: string;
  columns: ColumnMeta[];
  primaryKey: string[];
  rows: () => unknown[][];
  indexes?: IndexMeta[];
  keys?: KeyMeta[];
}

function col(
  name: string,
  dataType: string,
  normalizedType: ColumnMeta['normalizedType'],
  ordinal: number,
  opts?: Partial<Pick<ColumnMeta, 'nullable' | 'isPrimaryKey' | 'autoIncrement'>>,
): ColumnMeta {
  return {
    name,
    dataType,
    normalizedType,
    ordinal,
    nullable: opts?.nullable ?? true,
    isPrimaryKey: opts?.isPrimaryKey ?? false,
    autoIncrement: opts?.autoIncrement,
  };
}

const USERS_ROWS = 60;
const ORDERS_ROWS = 30;

const tableDefs: Record<string, TableDef> = {
  'demo.users': {
    kind: 'table',
    comment: '用户表',
    primaryKey: ['id'],
    columns: [
      col('id', 'bigint', 'integer', 1, { nullable: false, isPrimaryKey: true, autoIncrement: true }),
      col('name', 'varchar(64)', 'string', 2),
      col('email', 'varchar(128)', 'string', 3),
      col('created_at', 'datetime', 'datetime', 4),
    ],
    rows: () =>
      Array.from({ length: USERS_ROWS }, (_, i) => {
        const id = i + 1;
        return [id, `用户${id}`, `user${id}@example.com`, '2024-01-01 08:00:00'];
      }),
    indexes: [{ name: 'idx_email', columns: ['email'], unique: true, type: 'BTREE' }],
    keys: [{ name: 'PRIMARY', kind: 'PK', columns: ['id'] }],
  },
  'demo.orders': {
    kind: 'table',
    comment: '订单表',
    primaryKey: ['id'],
    columns: [
      col('id', 'bigint', 'integer', 1, { nullable: false, isPrimaryKey: true, autoIncrement: true }),
      col('user_id', 'bigint', 'integer', 2, { nullable: false }),
      col('amount', 'decimal(10,2)', 'decimal', 3, { nullable: false }),
      col('status', 'varchar(16)', 'string', 4),
      col('created_at', 'datetime', 'datetime', 5),
    ],
    rows: () =>
      Array.from({ length: ORDERS_ROWS }, (_, i) => {
        const id = i + 1;
        return [id, (id % USERS_ROWS) + 1, `${(id * 15).toFixed(2)}`, id % 2 === 0 ? 'paid' : 'created', '2024-02-01 12:00:00'];
      }),
    keys: [
      { name: 'PRIMARY', kind: 'PK', columns: ['id'] },
      { name: 'fk_user', kind: 'FK', columns: ['user_id'], refTable: 'users', refColumns: ['id'] },
    ],
  },
  'demo.v_active_users': {
    kind: 'view',
    comment: '活跃用户视图（演示）',
    primaryKey: ['id'],
    columns: [
      col('id', 'bigint', 'integer', 1, { nullable: false, isPrimaryKey: true }),
      col('name', 'varchar(64)', 'string', 2),
    ],
    rows: () =>
      Array.from({ length: USERS_ROWS / 2 }, (_, i) => {
        const id = (i + 1) * 2;
        return [id, `用户${id}`];
      }),
  },
  'analytics.events': {
    kind: 'table',
    comment: '埋点事件',
    primaryKey: ['id'],
    columns: [
      col('id', 'bigint', 'integer', 1, { nullable: false, isPrimaryKey: true, autoIncrement: true }),
      col('event', 'varchar(64)', 'string', 2, { nullable: false }),
      col('payload', 'json', 'json', 3),
    ],
    rows: () =>
      Array.from({ length: 10 }, (_, i) => [
        i + 1,
        `page_view_${i + 1}`,
        { page: `/p/${i + 1}`, ts: 1700000000000 + i * 1000 },
      ]),
  },
  'demo.wide': {
    kind: 'table',
    comment: '宽表演示（1000 行 × 20 列，M3 DoD：打开 <1.5s）',
    primaryKey: ['id'],
    columns: [
      col('id', 'bigint', 'integer', 1, { nullable: false, isPrimaryKey: true, autoIncrement: true }),
      col('name', 'varchar(64)', 'string', 2),
      col('email', 'varchar(128)', 'string', 3),
      col('category', 'varchar(32)', 'string', 4),
      col('price', 'decimal(10,2)', 'decimal', 5),
      col('quantity', 'int', 'integer', 6),
      col('active', 'boolean', 'boolean', 7),
      col('score', 'double', 'float', 8),
      col('created_at', 'datetime', 'datetime', 9),
      col('birthday', 'date', 'date', 10),
      col('wake_up', 'time', 'time', 11),
      col('meta', 'json', 'json', 12),
      col('avatar', 'blob', 'binary', 13),
      col('note', 'text', 'string', 14),
      col('tag_a', 'varchar(16)', 'string', 15),
      col('tag_b', 'varchar(16)', 'string', 16),
      col('lag01', 'bigint', 'integer', 17),
      col('lag02', 'varchar(32)', 'string', 18),
      col('lag03', 'decimal(8,3)', 'decimal', 19),
      col('deleted_at', 'datetime', 'datetime', 20),
    ],
    rows: () =>
      Array.from({ length: 1000 }, (_, i) => {
        const id = i + 1;
        return [
          id,
          `用户${id}`,
          `user${id}@example.com`,
          ['vip', 'normal', 'guest'][i % 3],
          `${(id * 3.33).toFixed(2)}`,
          id % 97,
          id % 2 === 0,
          (id % 100) / 7,
          '2024-03-01 09:30:00',
          '1990-06-15',
          '08:30:00.000',
          { idx: id, tags: ['a', 'b'] },
          id % 5 === 0 ? null : Buffer.from(`bin-${id}`).toString('base64'),
          id % 4 === 0 ? null : `备注文本 ${id}`,
          `tag-${id % 7}`,
          id % 3 === 0 ? null : `tag-${id % 11}`,
          id * 1000,
          id % 6 === 0 ? null : `x${id}`,
          `${(id / 3).toFixed(3)}`,
          id % 10 === 0 ? '2024-05-01 00:00:00' : null,
        ];
      }),
  },

  // ── shop 库：ER 关系演示（D-22 展示数据）。8 表 9 FK，覆盖自引用（分类树/汇报线）、
  // 多对多 junction（订单明细）、复合外键（发货单 → 明细复合主键）三类关系形态 ──
  'shop.customers': {
    kind: 'table',
    comment: '顾客',
    primaryKey: ['id'],
    columns: [
      col('id', 'bigint', 'integer', 1, { nullable: false, isPrimaryKey: true, autoIncrement: true }),
      col('name', 'varchar(64)', 'string', 2, { nullable: false }),
      col('phone', 'varchar(32)', 'string', 3),
      col('city', 'varchar(32)', 'string', 4),
      col('created_at', 'datetime', 'datetime', 5),
    ],
    rows: () =>
      Array.from({ length: 24 }, (_, i) => {
        const id = i + 1;
        return [id, `顾客${id}`, `138${String(10000000 + id * 137).slice(0, 8)}`, ['上海', '北京', '广州', '深圳'][i % 4], '2024-01-05 10:00:00'];
      }),
    keys: [
      { name: 'PRIMARY', kind: 'PK', columns: ['id'] },
      { name: 'uk_phone', kind: 'UNIQUE', columns: ['phone'] },
    ],
    indexes: [{ name: 'uk_phone', columns: ['phone'], unique: true, type: 'BTREE' }],
  },
  'shop.categories': {
    kind: 'table',
    comment: '商品分类（自引用父子树）',
    primaryKey: ['id'],
    columns: [
      col('id', 'bigint', 'integer', 1, { nullable: false, isPrimaryKey: true, autoIncrement: true }),
      col('name', 'varchar(64)', 'string', 2, { nullable: false }),
      col('parent_id', 'bigint', 'integer', 3),
    ],
    rows: () =>
      Array.from({ length: 10 }, (_, i) => {
        const id = i + 1;
        return [id, ['数码', '家电', '服饰', '食品', '手机', '笔记本', '相机', '冰箱', '男装', '零食'][i], id <= 4 ? null : ((i % 4) + 1)];
      }),
    keys: [
      { name: 'PRIMARY', kind: 'PK', columns: ['id'] },
      { name: 'fk_parent', kind: 'FK', columns: ['parent_id'], refTable: 'categories', refColumns: ['id'] },
    ],
  },
  'shop.suppliers': {
    kind: 'table',
    comment: '供应商',
    primaryKey: ['id'],
    columns: [
      col('id', 'bigint', 'integer', 1, { nullable: false, isPrimaryKey: true, autoIncrement: true }),
      col('name', 'varchar(64)', 'string', 2, { nullable: false }),
      col('city', 'varchar(32)', 'string', 3),
    ],
    rows: () =>
      Array.from({ length: 6 }, (_, i) => [i + 1, `供应商${i + 1}`, ['上海', '深圳', '杭州', '成都'][i % 4]]),
    keys: [{ name: 'PRIMARY', kind: 'PK', columns: ['id'] }],
  },
  'shop.products': {
    kind: 'table',
    comment: '商品',
    primaryKey: ['id'],
    columns: [
      col('id', 'bigint', 'integer', 1, { nullable: false, isPrimaryKey: true, autoIncrement: true }),
      col('name', 'varchar(64)', 'string', 2, { nullable: false }),
      col('price', 'decimal(10,2)', 'decimal', 3, { nullable: false }),
      col('stock', 'int', 'integer', 4),
      col('category_id', 'bigint', 'integer', 5, { nullable: false }),
      col('supplier_id', 'bigint', 'integer', 6, { nullable: false }),
    ],
    rows: () =>
      Array.from({ length: 30 }, (_, i) => {
        const id = i + 1;
        return [id, `商品${id}`, `${(id * 7.5).toFixed(2)}`, (id * 13) % 500, ((i * 3) % 10) + 1, (i % 6) + 1];
      }),
    keys: [
      { name: 'PRIMARY', kind: 'PK', columns: ['id'] },
      { name: 'fk_category', kind: 'FK', columns: ['category_id'], refTable: 'categories', refColumns: ['id'] },
      { name: 'fk_supplier', kind: 'FK', columns: ['supplier_id'], refTable: 'suppliers', refColumns: ['id'] },
    ],
  },
  'shop.employees': {
    kind: 'table',
    comment: '店员（自引用汇报线）',
    primaryKey: ['id'],
    columns: [
      col('id', 'bigint', 'integer', 1, { nullable: false, isPrimaryKey: true, autoIncrement: true }),
      col('name', 'varchar(64)', 'string', 2, { nullable: false }),
      col('title', 'varchar(32)', 'string', 3),
      col('manager_id', 'bigint', 'integer', 4),
    ],
    rows: () =>
      Array.from({ length: 8 }, (_, i) => {
        const id = i + 1;
        return [id, `店员${id}`, id <= 2 ? '店长' : '店员', id <= 2 ? null : ((i % 2) + 1)];
      }),
    keys: [
      { name: 'PRIMARY', kind: 'PK', columns: ['id'] },
      { name: 'fk_manager', kind: 'FK', columns: ['manager_id'], refTable: 'employees', refColumns: ['id'] },
    ],
  },
  'shop.orders': {
    kind: 'table',
    comment: '订单',
    primaryKey: ['id'],
    columns: [
      col('id', 'bigint', 'integer', 1, { nullable: false, isPrimaryKey: true, autoIncrement: true }),
      col('customer_id', 'bigint', 'integer', 2, { nullable: false }),
      col('employee_id', 'bigint', 'integer', 3, { nullable: false }),
      col('status', 'varchar(16)', 'string', 4),
      col('total', 'decimal(10,2)', 'decimal', 5),
      col('created_at', 'datetime', 'datetime', 6),
    ],
    rows: () =>
      Array.from({ length: 40 }, (_, i) => {
        const id = i + 1;
        return [id, ((i * 5) % 24) + 1, (i % 8) + 1, ['created', 'paid', 'shipped'][i % 3], `${(id * 23.4).toFixed(2)}`, '2024-03-15 14:00:00'];
      }),
    keys: [
      { name: 'PRIMARY', kind: 'PK', columns: ['id'] },
      { name: 'fk_customer', kind: 'FK', columns: ['customer_id'], refTable: 'customers', refColumns: ['id'] },
      { name: 'fk_employee', kind: 'FK', columns: ['employee_id'], refTable: 'employees', refColumns: ['id'] },
    ],
  },
  'shop.order_items': {
    kind: 'table',
    comment: '订单明细（复合主键，订单×商品 junction）',
    primaryKey: ['order_id', 'line_no'],
    columns: [
      col('order_id', 'bigint', 'integer', 1, { nullable: false, isPrimaryKey: true }),
      col('line_no', 'int', 'integer', 2, { nullable: false, isPrimaryKey: true }),
      col('product_id', 'bigint', 'integer', 3, { nullable: false }),
      col('quantity', 'int', 'integer', 4),
      col('unit_price', 'decimal(10,2)', 'decimal', 5),
    ],
    rows: () => {
      const rows: unknown[][] = [];
      for (let order = 1; order <= 40; order++) {
        const lines = (order % 2) + 1;
        for (let line = 1; line <= lines; line++) {
          rows.push([order, line, ((order * 3 + line * 7 - 1) % 30) + 1, ((order + line) % 3) + 1, `${(line * 12.5).toFixed(2)}`]);
        }
      }
      return rows;
    },
    keys: [
      { name: 'PRIMARY', kind: 'PK', columns: ['order_id', 'line_no'] },
      { name: 'fk_item_order', kind: 'FK', columns: ['order_id'], refTable: 'orders', refColumns: ['id'] },
      { name: 'fk_item_product', kind: 'FK', columns: ['product_id'], refTable: 'products', refColumns: ['id'] },
    ],
  },
  'shop.shipments': {
    kind: 'table',
    comment: '发货单（复合外键 → 明细）',
    primaryKey: ['id'],
    columns: [
      col('id', 'bigint', 'integer', 1, { nullable: false, isPrimaryKey: true, autoIncrement: true }),
      col('order_id', 'bigint', 'integer', 2, { nullable: false }),
      col('line_no', 'int', 'integer', 3, { nullable: false }),
      col('shipped_at', 'datetime', 'datetime', 4),
    ],
    rows: () => {
      const rows: unknown[][] = [];
      let id = 0;
      for (let order = 1; order <= 40; order += 2) {
        id += 1;
        rows.push([id, order, 1, '2024-03-20 09:00:00']);
      }
      return rows;
    },
    keys: [
      { name: 'PRIMARY', kind: 'PK', columns: ['id'] },
      {
        name: 'fk_ship_item',
        kind: 'FK',
        columns: ['order_id', 'line_no'],
        refTable: 'order_items',
        refColumns: ['order_id', 'line_no'],
      },
    ],
  },
};

const databases: DatabaseMeta[] = [
  { name: 'demo', charset: 'utf8mb4', comment: '演示业务库' },
  { name: 'shop', charset: 'utf8mb4', comment: '电商示例库（ER 关系演示：自引用 / 多对多 / 复合外键）' },
  { name: 'analytics', charset: 'utf8mb4', comment: '分析库' },
  { name: 'big', charset: 'utf8mb4', comment: '规模演示库（100 表 × 5 万行，M3 性能验收）' },
];

/** big 库：t001..t100，每表 5 万行（M3 DoD：5 万行虚拟滚动不卡顿） */
const BIG_TABLE_COUNT = 100;

/** mock 库名校验（fail-closed，D-19 契约组用例）：仅字母/数字/下划线，防注入 */
function validateMockDbName(name: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name)) {
    throw new DriverError('E_VALIDATION', `非法库名："${name.slice(0, 32)}"（仅允许字母/数字/下划线）`);
  }
}
const BIG_TABLE_ROWS = 50_000;

function bigDef(_obj: string): TableDef {
  return {
    kind: 'table',
    comment: 'big 表',
    primaryKey: ['id'],
    columns: [
      col('id', 'bigint', 'integer', 1, { nullable: false, isPrimaryKey: true, autoIncrement: true }),
      col('name', 'varchar(32)', 'string', 2),
      col('value', 'decimal(10,2)', 'decimal', 3),
    ],
    rows: () =>
      Array.from({ length: BIG_TABLE_ROWS }, (_, i) => {
        const id = i + 1;
        return [id, `row${id}`, `${(id * 1.5).toFixed(2)}`];
      }),
  };
}

function getDef(db: string, obj: string): TableDef | undefined {
  const def = tableDefs[`${db}.${obj}`];
  if (def) {
    return def;
  }
  if (db === 'big' && /^t\d{3}$/.test(obj)) {
    const n = Number(obj.slice(1));
    if (n >= 1 && n <= BIG_TABLE_COUNT) {
      return bigDef(obj);
    }
  }
  return undefined;
}

function defOf(db: string, obj: string): TableDef {
  const def = getDef(db, obj);
  if (!def) {
    throw new DriverError('E_NOT_FOUND', `表 "${db}.${obj}" 不存在`);
  }
  return def;
}

// ── 共享物化存储（跨连接一致，冲突可构造；测试用 resetMockStore 复位）──

const store = new Map<string, unknown[][]>();
const nextIds = new Map<string, number>();

function storeKey(db: string, obj: string): string {
  return `${db}.${obj}`;
}

function materialize(db: string, obj: string): unknown[][] {
  const key = storeKey(db, obj);
  let rows = store.get(key);
  if (!rows) {
    const def = defOf(db, obj);
    rows = def.rows();
    store.set(key, rows);
    // 自增主键水位：物化时一次性扫描
    const aiIdx = def.columns.findIndex((c) => c.autoIncrement);
    if (aiIdx >= 0) {
      let max = 0;
      for (const row of rows) {
        const n = Number(row[aiIdx]);
        if (Number.isFinite(n) && n > max) {
          max = n;
        }
      }
      nextIds.set(key, max + 1);
    }
  }
  return rows;
}

/** 测试复位：清空物化存储（下次访问按初始数据重新物化） */
export function resetMockStore(): void {
  store.clear();
  nextIds.clear();
}

/** M8-B2 DDL 执行器的注册表句柄：对 tableDefs/store 就地变更（P-18 共享物化存储语义） */
const mockDdlRegistry: MockDdlRegistry = {
  databases: () => databases.map((d) => d.name),
  getTable: (db, obj) => {
    const def = getDef(db, obj);
    if (!def) {
      return undefined;
    }
    // columns/primaryKey/keys/indexes 必须是活对象引用（执行器就地改标记/增删条目）
    def.keys ??= [];
    def.indexes ??= [];
    return { comment: def.comment, columns: def.columns, primaryKey: def.primaryKey, keys: def.keys, indexes: def.indexes };
  },
  createTable: (db, obj, def) => {
    tableDefs[`${db}.${obj}`] = {
      kind: 'table',
      comment: def.comment,
      columns: def.columns,
      primaryKey: def.primaryKey,
      keys: def.keys,
      indexes: def.indexes,
      rows: () => [],
    };
    store.set(storeKey(db, obj), []);
  },
  dropTable: (db, obj) => {
    delete tableDefs[`${db}.${obj}`];
    const key = storeKey(db, obj);
    store.delete(key);
    nextIds.delete(key);
  },
  renameTable: (db, obj, newDb, newObj) => {
    const def = tableDefs[`${db}.${obj}`];
    if (!def) {
      return;
    }
    delete tableDefs[`${db}.${obj}`];
    tableDefs[`${newDb}.${newObj}`] = def;
    const oldKey = storeKey(db, obj);
    store.set(storeKey(newDb, newObj), store.get(oldKey) ?? []);
    store.delete(oldKey);
    nextIds.delete(oldKey);
  },
  appendColumnCells: (db, obj) => {
    for (const row of materialize(db, obj)) {
      row.push(null);
    }
  },
  spliceColumnCells: (db, obj, index) => {
    for (const row of materialize(db, obj)) {
      row.splice(index, 1);
    }
  },
};

function cellToString(v: unknown): string {
  if (v === null || v === undefined) return '';
  return typeof v === 'string' ? v : JSON.stringify(v);
}

function toNum(v: unknown): number | undefined {
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean' || v === null || v === undefined) return undefined;
  if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) return Number(v);
  return undefined;
}

/** 值相等：严格相等优先，数值化后比较（SQL 语义：DECIMAL 字符串 '15.0' = 15） */
function valEq(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  const na = toNum(a);
  const nb = toNum(b);
  if (na !== undefined && nb !== undefined) return na === nb;
  return false;
}

function valCmp(a: unknown, b: unknown): number {
  const na = toNum(a);
  const nb = toNum(b);
  if (na !== undefined && nb !== undefined) return na - nb;
  const sa = cellToString(a);
  const sb = cellToString(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

/**
 * SQL 三值逻辑筛选：与 NULL 的任何比较均为 unknown → 行被排除，
 * 仅 isNull / isNotNull 涉及 NULL（契约基准与 driver-conformance 一致）。
 */
function applyFilters(rows: unknown[][], columns: ColumnMeta[], filters: FilterCondition[]): unknown[][] {
  let out = rows;
  for (const f of filters) {
    const idx = columns.findIndex((c) => c.name === f.column);
    if (idx < 0) {
      throw new DriverError('E_VALIDATION', `未知筛选列 "${f.column}"`);
    }
    out = out.filter((row) => {
      const v = row[idx];
      switch (f.op) {
        case 'isNull':
          return v === null;
        case 'isNotNull':
          return v !== null;
        default:
          break;
      }
      if (v === null || v === undefined) return false;
      switch (f.op) {
        case 'eq':
          return valEq(v, f.value);
        case 'ne':
          return !valEq(v, f.value);
        case 'gt':
          return valCmp(v, f.value) > 0;
        case 'ge':
          return valCmp(v, f.value) >= 0;
        case 'lt':
          return valCmp(v, f.value) < 0;
        case 'le':
          return valCmp(v, f.value) <= 0;
        case 'like':
          return cellToString(v).includes(cellToString(f.value));
        case 'notLike':
          return !cellToString(v).includes(cellToString(f.value));
        case 'in':
          return (f.values ?? []).some((x) => valEq(v, x));
        case 'notIn':
          return !(f.values ?? []).some((x) => valEq(v, x));
        case 'between': {
          const [lo, hi] = f.values ?? [];
          return valCmp(v, lo) >= 0 && valCmp(v, hi) <= 0;
        }
        default:
          throw new DriverError('E_VALIDATION', `筛选操作符 "${f.op}" 暂不支持`);
      }
    });
  }
  return out;
}

// ── 变更语句构建（previewChanges / applyChanges 同源，驱动规范 §8-6）──

/** 乐观锁原值匹配：键值全等 + 变更列原值全等；null 语义 = IS NULL（当前值必须也是 NULL） */
function cellMatches(current: unknown, expected: unknown): boolean {
  if (expected === null || expected === undefined) {
    return current === null || current === undefined;
  }
  if (current === null || current === undefined) {
    return false;
  }
  return valEq(current, expected);
}

function rowMatches(
  row: unknown[],
  idxOf: (name: string) => number,
  rowKey: RowKey,
  changes: Record<string, { old: unknown; new: unknown }> | undefined,
): boolean {
  for (const [colName, expected] of Object.entries(rowKey)) {
    const i = idxOf(colName);
    if (i < 0 || !cellMatches(row[i], expected)) {
      return false;
    }
  }
  for (const [colName, ch] of Object.entries(changes ?? {})) {
    if (colName in rowKey) continue; // 全列匹配模式下 RowKey 已覆盖
    const i = idxOf(colName);
    if (i < 0 || !cellMatches(row[i], ch.old)) {
      return false;
    }
  }
  return true;
}

interface MockStatement {
  kind: 'insert' | 'update' | 'delete';
  tempId?: string;
  rowKey?: RowKey;
  changes?: Record<string, { old: unknown; new: unknown }>;
  values?: Record<string, unknown>;
  sql: string;
  /** 与 sql 中 ? 按序对应的参数（PreviewItem.params 同源透传，预览回填依赖） */
  params: unknown[];
}

function quoteMockIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * ChangeSet → mock 语句（与 applyChanges 共用同一函数，预览即执行）。
 * 形状对齐 SQL 驱动：标识符引用 + 值以"参数"形式在 statement 上随行。
 */
export function buildMockStatements(db: string, obj: string, cs: ChangeSet): MockStatement[] {
  const table = `${quoteMockIdentifier(db)}.${quoteMockIdentifier(obj)}`;
  const statements: MockStatement[] = [];

  for (const ins of cs.inserts) {
    const cols = Object.keys(ins.values);
    if (cols.length === 0) {
      throw new DriverError('E_VALIDATION', '新增行没有任何列值', {
        meta: { kind: 'insert', tempId: ins.tempId },
      });
    }
    statements.push({
      kind: 'insert',
      tempId: ins.tempId,
      values: ins.values,
      sql: `INSERT INTO ${table} (${cols.map(quoteMockIdentifier).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
      params: cols.map((c) => ins.values[c]),
    });
  }

  for (const upd of cs.updates) {
    const setCols = Object.keys(upd.changes);
    if (setCols.length === 0) {
      continue;
    }
    const where: string[] = [];
    const whereParams: unknown[] = [];
    const pushCond = (colName: string, expected: unknown): void => {
      const c = quoteMockIdentifier(colName);
      if (expected === null || expected === undefined) {
        where.push(`${c} IS NULL`);
      } else {
        where.push(`${c} = ?`);
        whereParams.push(expected);
      }
    };
    for (const [colName, expected] of Object.entries(upd.rowKey)) {
      pushCond(colName, expected);
    }
    for (const colName of setCols) {
      if (colName in upd.rowKey) continue;
      pushCond(colName, upd.changes[colName].old);
    }
    if (where.length === 0) {
      throw new DriverError('E_VALIDATION', 'UPDATE 缺少定位条件（无主键且无原值）', {
        meta: { kind: 'update', rowKey: upd.rowKey },
      });
    }
    statements.push({
      kind: 'update',
      rowKey: upd.rowKey,
      changes: upd.changes,
      sql: `UPDATE ${table} SET ${setCols.map((c) => `${quoteMockIdentifier(c)} = ?`).join(', ')} WHERE ${where.join(' AND ')}`,
      params: [...setCols.map((c) => upd.changes[c].new), ...whereParams],
    });
  }

  for (const del of cs.deletes) {
    const where: string[] = [];
    const params: unknown[] = [];
    for (const [colName, expected] of Object.entries(del.rowKey)) {
      if (expected === null || expected === undefined) {
        where.push(`${quoteMockIdentifier(colName)} IS NULL`);
      } else {
        where.push(`${quoteMockIdentifier(colName)} = ?`);
        params.push(expected);
      }
    }
    if (where.length === 0) {
      throw new DriverError('E_VALIDATION', 'DELETE 缺少主键定位条件', {
        meta: { kind: 'delete', rowKey: del.rowKey },
      });
    }
    statements.push({
      kind: 'delete',
      rowKey: del.rowKey,
      sql: `DELETE FROM ${table} WHERE ${where.join(' AND ')}`,
      params,
    });
  }

  return statements;
}

export class MockConnection implements IConnection {
  readonly connectionId: string;

  constructor(private readonly cfg: ConnectionConfig) {
    this.connectionId = cfg.id;
  }

  ping(): Promise<void> {
    return Promise.resolve();
  }

  listDatabases(): Promise<DatabaseMeta[]> {
    return Promise.resolve(databases);
  }

  listObjects(db: string): Promise<ObjectMeta[]> {
    if (db === 'big') {
      return Promise.resolve(
        Array.from({ length: BIG_TABLE_COUNT }, (_, i) => {
          const name = `t${String(i + 1).padStart(3, '0')}`;
          return {
            name,
            kind: 'table' as const,
            comment: 'big 表',
            rowEstimate: BIG_TABLE_ROWS,
          };
        }),
      );
    }
    const prefix = `${db}.`;
    return Promise.resolve(
      Object.entries(tableDefs)
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, def]) => ({
          name: key.slice(prefix.length),
          kind: def.kind,
          comment: def.comment,
          rowEstimate: materialize(db, key.slice(prefix.length)).length,
        })),
    );
  }

  listColumns(db: string, obj: string): Promise<ColumnMeta[]> {
    return Promise.resolve(defOf(db, obj).columns);
  }

  listIndexes(db: string, obj: string): Promise<IndexMeta[]> {
    return Promise.resolve(defOf(db, obj).indexes ?? []);
  }

  listKeys(db: string, obj: string): Promise<KeyMeta[]> {
    return Promise.resolve(defOf(db, obj).keys ?? []);
  }

  // ── 表结构编辑（M8-B2，概要 §5.9）：语句生成 + query() 内存执行 ──

  buildCreateTable(db: string, spec: TableSpec): Promise<DdlStatement[]> {
    return Promise.resolve(buildMockCreateTable(db, spec));
  }

  buildAlterTable(db: string, obj: string, spec: TableSpec, current: TableSpec): Promise<DdlStatement[]> {
    return Promise.resolve(buildMockAlterTable(db, obj, spec, current));
  }

  async fetchRows(req: FetchRowsRequest): Promise<ResultSet> {
    const def = defOf(req.db, req.obj);
    const columns = def.columns;
    let rows = materialize(req.db, req.obj);

    if (req.search) {
      const kw = req.search;
      rows = rows.filter((r) => r.some((cell) => cellToString(cell).includes(kw)));
    }
    if (req.filters?.length) {
      rows = applyFilters(rows, columns, req.filters);
    }
    if (req.whereSql) {
      // 用户手写 WHERE 片段（驱动规范 §4）：内存求值，语法/列名错误 → E_VALIDATION
      const pred = compileWhere(req.whereSql, columns);
      if (pred) {
        rows = rows.filter(pred);
      }
    }
    const totalCount = rows.length;

    // 排序链：结构化 sorts 在前，用户 ORDER BY 片段在后；
    // 片段未含主键时追加主键升序兜底（P-10 翻页稳定，与 MySQL 同规则）
    const sortSpecs: Array<{ column: string; dir: 'asc' | 'desc' }> = [...(req.sorts ?? [])];
    if (req.orderBySql?.trim()) {
      const orderTerms = compileOrderBy(req.orderBySql, columns);
      for (const o of orderTerms) {
        sortSpecs.push({ column: columns[o.index].name, dir: o.dir });
      }
      const pkCols = def.columns.filter((c) => c.isPrimaryKey).map((c) => c.name);
      const hasPk = orderTerms.some((o) => pkCols.includes(columns[o.index].name));
      if (!hasPk) {
        for (const pk of pkCols) {
          sortSpecs.push({ column: pk, dir: 'asc' as const });
        }
      }
    }
    if (sortSpecs.length > 0) {
      rows = [...rows].sort((a, b) => {
        for (const s of sortSpecs) {
          const idx = columns.findIndex((c) => c.name === s.column);
          if (idx < 0) continue;
          const av = a[idx];
          const bv = b[idx];
          // MySQL NULL 序：ASC 最前、DESC 最后
          const aNull = av === null || av === undefined;
          const bNull = bv === null || bv === undefined;
          let cmp: number;
          if (aNull && bNull) cmp = 0;
          else if (aNull) cmp = -1;
          else if (bNull) cmp = 1;
          else cmp = valCmp(av, bv);
          if (cmp !== 0) return s.dir === 'asc' ? cmp : -cmp;
        }
        return 0;
      });
    }

    const offset = req.offset ?? 0;
    const page = rows.slice(offset, offset + req.limit);
    const outColumns =
      req.columns && req.columns.length > 0
        ? columns.filter((c) => req.columns?.includes(c.name))
        : columns;
    const outIndexes = outColumns.map((c) => columns.findIndex((c2) => c2.name === c.name));
    const outRows = page.map((row) => outIndexes.map((i) => row[i]));

    return {
      columns: outColumns.map((c) => ({ name: c.name, type: c.normalizedType })),
      rows: outRows,
      rowCount: outRows.length,
      totalCount,
      primaryKey: def.primaryKey,
      executionMs: 1,
    };
  }

  async query(req: QueryRequest): Promise<ResultSet[]> {
    const started = Date.now();
    // supportsMultiStatement=false：core 已切分；收到多语句按契约违反处理
    const stmts = splitSqlStatements(req.sql);
    if (stmts.length === 0) {
      throw new DriverError('E_VALIDATION', '空语句');
    }
    if (stmts.length > 1) {
      throw new DriverError('E_VALIDATION', 'mock 驱动不支持一次执行多条语句');
    }
    // M8-DBDDL：库级 DDL（buildCreateDatabase/... 生成的语句形状；内存库列表变更）
    const dbDdl = /^(\w+)\s+DATABASE\s+`?([A-Za-z_][A-Za-z0-9_]*)`?/i.exec(stmts[0].text);
    if (dbDdl) {
      const verb = dbDdl[1]!.toUpperCase();
      const name = dbDdl[2]!;
      const idx = databases.findIndex((d) => d.name === name);
      if (verb === 'CREATE') {
        if (idx >= 0) {
          throw new DriverError('E_CONFLICT', `库 "${name}" 已存在`);
        }
        databases.push({ name, charset: 'utf8mb4' });
      } else if (verb === 'DROP') {
        if (idx < 0) {
          throw new DriverError('E_NOT_FOUND', `库 "${name}" 不存在`);
        }
        databases.splice(idx, 1);
      }
      // ALTER：内存元数据无 charset 语义，语句接受即成功
      return [
        {
          columns: [],
          rows: [],
          rowCount: 0,
          affectedRows: verb === 'DROP' ? 1 : 0,
          executionMs: Math.max(Date.now() - started, 1),
        },
      ];
    }
    // M8-B2：DDL 走表结构编辑执行链（只认本驱动生成的语句形状）
    if (isMockDdlStatement(stmts[0].text)) {
      executeMockDdlSql(mockDdlRegistry, stmts[0].text);
      return [
        {
          columns: [],
          rows: [],
          rowCount: 0,
          affectedRows: 0,
          executionMs: Math.max(Date.now() - started, 1),
        },
      ];
    }
    const plan = parseMockStatement(stmts[0].text);
    const db = plan.ref.db ?? req.db;
    if (!db) {
      throw new DriverError('E_VALIDATION', `表 "${plan.ref.table}" 未限定库且连接未设默认库`);
    }
    const def = defOf(db, plan.ref.table);
    const key = storeKey(db, plan.ref.table);
    const rows = materialize(db, plan.ref.table);
    const columns = def.columns;
    const idxOf = (name: string): number => {
      const i = columns.findIndex((c) => c.name.toLowerCase() === name.toLowerCase());
      if (i < 0) {
        throw new DriverError('E_VALIDATION', `mock 驱动：表 "${plan.ref.table}" 无列 "${name}"`);
      }
      return i;
    };

    if (plan.kind === 'select') {
      return [executeMockSelect(plan, { columns, rows }, started)];
    }

    if (plan.kind === 'insert') {
      for (const tuple of plan.tuples) {
        const row = columns.map((c) => {
          const pos = plan.columns.findIndex((n) => n.toLowerCase() === c.name.toLowerCase());
          return pos >= 0 ? tuple[pos] : null;
        });
        for (let i = 0; i < columns.length; i++) {
          const c = columns[i];
          if (c.autoIncrement && (row[i] === null || row[i] === undefined)) {
            const next = nextIds.get(key) ?? 1;
            row[i] = next;
            nextIds.set(key, next + 1);
          }
        }
        rows.push(row);
      }
      return [
        {
          columns: [],
          rows: [],
          rowCount: 0,
          affectedRows: plan.tuples.length,
          executionMs: Math.max(Date.now() - started, 1),
        },
      ];
    }

    // update / delete：WHERE 缺省时作用于全表（Console 危险横幅负责前置确认）
    const pred = (plan.where ? compileWhere(plan.where, columns) : null) ?? (() => true);
    if (plan.kind === 'update') {
      const setIdx = plan.sets.map((s) => ({ idx: idxOf(s.column), value: s.value }));
      let affected = 0;
      for (const row of rows) {
        if (pred(row)) {
          affected++;
          for (const { idx, value } of setIdx) {
            row[idx] = value;
          }
        }
      }
      return [
        {
          columns: [],
          rows: [],
          rowCount: 0,
          affectedRows: affected,
          executionMs: Math.max(Date.now() - started, 1),
        },
      ];
    }

    // delete：原地过滤（store 持有同一数组引用，必须就地变更）
    const kept = rows.filter((row) => !pred(row));
    const affected = rows.length - kept.length;
    rows.length = 0;
    rows.push(...kept);
    return [
      {
        columns: [],
        rows: [],
        rowCount: 0,
        affectedRows: affected,
        executionMs: Math.max(Date.now() - started, 1),
      },
    ];
  }

  previewChanges(db: string, obj: string, cs: ChangeSet): Promise<PreviewItem[]> {
    try {
      const def = defOf(db, obj);
      if (def.kind === 'view') {
        throw new DriverError('E_UNSUPPORTED', '视图不可编辑');
      }
      const items: PreviewItem[] = buildMockStatements(db, obj, cs).map((s) => ({
        kind: s.kind,
        tempId: s.tempId,
        rowKey: s.rowKey,
        sql: s.sql,
        params: s.params,
      }));
      return Promise.resolve(items);
    } catch (err) {
      return Promise.reject(err instanceof DriverError ? err : new DriverError('E_INTERNAL', String(err)));
    }
  }

  /** 内存短事务：逐条执行 + 失败整体回滚（快照恢复），任一 update/delete 匹配行数 ≠ 1 → E_CONFLICT */
  /** 单元格查看器批次（交互稿 §4.6）：按 RowKey 取单格 C-7 值——内存数据本就完整，
   *  mock 提供该方法是作为契约组 lazy-cell 的基准实现（roundtrip / 错误码口径） */
  async fetchCell(db: string, obj: string, rowKey: RowKey, column: string): Promise<unknown> {
    const def = defOf(db, obj);
    const idxOf = (name: string) => def.columns.findIndex((c) => c.name === name);
    if (idxOf(column) < 0) {
      throw new DriverError('E_VALIDATION', `列不存在: ${column}`);
    }
    const rows = materialize(db, obj);
    for (const row of rows) {
      if (rowMatches(row, idxOf, rowKey, undefined)) {
        return row[idxOf(column)];
      }
    }
    // 不带 meta（rowKey 承载行数据值，C-10 不入日志/错误）
    throw new DriverError('E_NOT_FOUND', '行不存在或已被删除');
  }

  async applyChanges(db: string, obj: string, cs: ChangeSet): Promise<ApplyResult> {
    const def = defOf(db, obj);
    if (def.kind === 'view') {
      throw new DriverError('E_UNSUPPORTED', '视图不可编辑');
    }
    const started = Date.now();
    const statements = buildMockStatements(db, obj, cs);
    if (statements.length === 0) {
      return { items: [], executionMs: 0 };
    }
    const key = storeKey(db, obj);
    const rows = materialize(db, obj);
    // 回滚快照（深拷贝受影响表的行数据）
    const rollback = JSON.parse(JSON.stringify(rows)) as unknown[][];
    const columns = def.columns;
    const idxOf = (name: string) => columns.findIndex((c) => c.name === name);
    const items: ApplyResult['items'] = [];

    try {
      for (const stmt of statements) {
        if (stmt.kind === 'insert') {
          const values = stmt.values ?? {};
          const row = columns.map((c) => (c.name in values ? values[c.name] : null));
          for (let i = 0; i < columns.length; i++) {
            const c = columns[i];
            if (c.autoIncrement && (row[i] === null || row[i] === undefined)) {
              const next = nextIds.get(key) ?? 1;
              row[i] = next;
              nextIds.set(key, next + 1);
            }
          }
          rows.push(row);
          const rowKey: RowKey = {};
          for (const pk of def.primaryKey) {
            const i = idxOf(pk);
            if (i >= 0) {
              rowKey[pk] = row[i];
            }
          }
          items.push({ kind: 'insert', tempId: stmt.tempId, rowKey, sql: stmt.sql, affectedRows: 1 });
          continue;
        }

        // update / delete：乐观锁匹配；匹配行数 ≠ 1 → E_CONFLICT（驱动规范 §8-2）
        let matched = -1;
        let matchCount = 0;
        for (let r = 0; r < rows.length; r++) {
          if (rowMatches(rows[r], idxOf, stmt.rowKey ?? {}, stmt.changes)) {
            matchCount++;
            if (matchCount > 1) break;
            matched = r;
          }
        }
        if (matchCount !== 1) {
          throw new DriverError('E_CONFLICT', '数据已被他人修改，本次提交已回滚', {
            meta: { kind: stmt.kind, tempId: stmt.tempId, rowKey: stmt.rowKey },
          });
        }
        if (stmt.kind === 'update') {
          for (const [colName, ch] of Object.entries(stmt.changes ?? {})) {
            rows[matched][idxOf(colName)] = ch.new;
          }
        } else {
          rows.splice(matched, 1);
        }
        items.push({ kind: stmt.kind, rowKey: stmt.rowKey, sql: stmt.sql, affectedRows: 1 });
      }
      return { items, executionMs: Date.now() - started };
    } catch (err) {
      // 整体回滚：恢复快照（规范 §8-1 不得半提交）
      store.set(key, rollback);
      throw err;
    }
  }

  listDataTypes(): DataTypeOption[] {
    return MOCK_DATA_TYPES;
  }

  getCompletionSource(db?: string): Promise<CompletionSource> {
    const prefix = db ? `${db}.` : '';
    const objs = Object.entries(tableDefs).filter(([key]) => key.startsWith(prefix));
    return Promise.resolve({
      keywords: ['SELECT', 'FROM', 'WHERE', 'ORDER BY', 'LIMIT'],
      functions: ['COUNT', 'SUM', 'NOW'],
      databases: databases.map((d) => d.name),
      tables: objs.map(([key, def]) => ({
        name: key.split('.')[1],
        comment: def.comment,
      })),
      columns: objs.flatMap(([key, def]) =>
        def.columns.map((c) => ({ table: key.split('.')[1], name: c.name })),
      ),
    });
  }

  quoteIdentifier(name: string): string {
    return quoteMockIdentifier(name);
  }

  getDdl(db: string, obj: string): Promise<string> {
    const def = defOf(db, obj);
    const q = (n: string) => `\`${n.replace(/`/g, '``')}\``;
    if (def.kind === 'view') {
      return Promise.resolve(`CREATE VIEW ${q(obj)} AS\nSELECT * FROM ${q(db)};\n`);
    }
    const lines = def.columns.map(
      (c) =>
        `  ${q(c.name)} ${c.dataType}${c.nullable ? '' : ' NOT NULL'}${c.autoIncrement ? ' AUTO_INCREMENT' : ''}${c.comment ? ` COMMENT '${c.comment}'` : ''}`,
    );
    const pk = def.columns.filter((c) => c.isPrimaryKey).map((c) => c.name);
    if (pk.length > 0) {
      lines.push(`  PRIMARY KEY (${pk.map(q).join(', ')})`);
    }
    for (const idx of def.indexes ?? []) {
      lines.push(
        `  ${idx.unique ? 'UNIQUE KEY' : 'KEY'} ${q(idx.name)} (${idx.columns.map(q).join(', ')})`,
      );
    }
    return Promise.resolve(
      `CREATE TABLE ${q(obj)} (\n${lines.join(',\n')}\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4${def.comment ? ` COMMENT='${def.comment}'` : ''};\n`,
    );
  }

  dispose(): void {
    // 内存驱动无资源需要释放；未提交会话随连接丢弃（dispose = 放弃）
    this.activeSession = null;
  }

  /**
   * 交互式事务会话（M7，概要 §4.6 / D-09）：写语句缓冲（含 req.db，回放不丢库）、
   * commit 依序落库、rollback 丢弃。简化：会话内 SELECT 读基线数据（自身未提交写不可见）；
   * 单连接最多 1 会话（重复开启拒绝）。
   */
  private activeSession: { writes: Array<{ sql: string; db?: string }> } | null = null;

  openSession(): Promise<ISession> {
    if (this.activeSession) {
      return Promise.reject(new DriverError('E_VALIDATION', '已有进行中的事务会话（单连接最多 1 个）'));
    }
    const state = { writes: [] as Array<{ sql: string; db?: string }> };
    this.activeSession = state;
    const assertLive = (): void => {
      if (this.activeSession !== state) {
        throw new DriverError('E_CONN', '事务会话已结束（dispose/重复开启）');
      }
    };
    const session: ISession = {
      execute: async (req: QueryRequest): Promise<ResultSet[]> => {
        assertLive();
        const head = /^\s*([A-Za-z]+)/.exec(req.sql)?.[1]?.toUpperCase() ?? '';
        if (head === 'SELECT') {
          return this.query(req);
        }
        state.writes.push({ sql: req.sql, db: req.db });
        return [{ columns: [], rows: [], rowCount: 0, affectedRows: 0, executionMs: 0 }];
      },
      commit: async () => {
        assertLive();
        const pending = [...state.writes];
        for (const w of pending) {
          await this.query({ sql: w.sql, db: w.db, maxRows: 1, timeoutMs: 15_000 });
        }
        state.writes.length = 0;
      },
      rollback: async () => {
        assertLive();
        state.writes.length = 0;
      },
      dispose: async () => {
        if (this.activeSession === state) {
          this.activeSession = null; // 未提交写随会话丢弃（dispose = 放弃）
        }
      },
    };
    return Promise.resolve(session);
  }
}

export function createMockDriver(): IDatabaseDriver {
  return {
    id: MOCK_DRIVER_ID,
    displayName: 'Mock 数据源',
    apiVersion: 1,
    capabilities,
    getConnectionFormSchema: () => formSchema,
    // ── 库级 DDL（M8-DBDDL / D-19：内存库列表变更，query() 拦截执行对应语句）──
    getDatabaseFormSchema: () => ({
      fields: [
        { key: 'name', label: '库名', type: 'string', required: true, placeholder: 'newdb' },
        {
          key: 'charset',
          label: '字符集',
          type: 'select',
          default: 'utf8mb4',
          options: [
            { label: 'utf8mb4', value: 'utf8mb4' },
            { label: 'utf8', value: 'utf8' },
            { label: 'latin1', value: 'latin1' },
          ],
        },
      ],
    }),
    buildCreateDatabase: async (spec: DatabaseSpec) => {
      validateMockDbName(spec.name);
      if (databases.some((d) => d.name === spec.name)) {
        throw new DriverError('E_CONFLICT', `库 "${spec.name}" 已存在`);
      }
      const charset = spec.charset ?? 'utf8mb4';
      return [{ sql: `CREATE DATABASE \`${spec.name}\` CHARACTER SET ${charset}` }];
    },
    buildAlterDatabase: async (db: string, spec: DatabaseSpec, current: DatabaseMeta) => {
      validateMockDbName(db);
      const diff: string[] = [];
      if (spec.charset && spec.charset !== current.charset) {
        diff.push(`CHARACTER SET ${spec.charset}`);
      }
      if (spec.collation && spec.collation !== current.collation) {
        diff.push(`COLLATE ${spec.collation}`);
      }
      if (diff.length === 0) {
        return []; // 无差异（契约组口径）
      }
      return [{ sql: `ALTER DATABASE \`${db}\` ${diff.join(' ')}` }];
    },
    buildDropDatabase: async (db: string) => {
      validateMockDbName(db);
      return [{ sql: `DROP DATABASE \`${db}\``, destructive: true }];
    },
    testConnection: async (): Promise<TestResult> => {
      const start = Date.now();
      return { ok: true, latencyMs: Date.now() - start + 5, serverVersion: 'mock-1.0' };
    },
    connect: (cfg: ConnectionConfig) => Promise.resolve(new MockConnection(cfg)),
  };
}
