import {
  DriverError,
  type ChangeSet,
  type ColumnMeta,
  type CompletionSource,
  type ConnectionConfig,
  type DatabaseMeta,
  type DriverCapabilities,
  type FetchRowsRequest,
  type FilterCondition,
  type FormSchema,
  type IConnection,
  type IDatabaseDriver,
  type IndexMeta,
  type KeyMeta,
  type ObjectMeta,
  type PreviewItem,
  type QueryRequest,
  type ResultSet,
  type TestResult,
} from '@db-explorer/core';

/**
 * M0 演示驱动：纯内存数据源。
 * 用途：验证“实现 IDatabaseDriver + 注册即接入”的可插拔契约（核心代码 0 改动），
 * 并为资源树 / 表格视图开发提供稳定数据。
 */
export const MOCK_DRIVER_ID = 'mock';

const capabilities: DriverCapabilities = {
  supportsSQL: false, // M5 由真实驱动实现
  supportsTransaction: false,
  supportsInteractiveTransaction: false,
  supportsMultipleDatabases: true,
  supportsMultiStatement: false,
  supportsCancel: false,
  supportsDdl: false,
  hierarchy: ['connection', 'database', 'folder', 'table', 'view', 'column'],
  editable: false, // M4 接入 ChangeSet 后开启
  pagination: 'offset',
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
};

const databases: DatabaseMeta[] = [
  { name: 'demo', charset: 'utf8mb4', comment: '演示业务库' },
  { name: 'analytics', charset: 'utf8mb4', comment: '分析库' },
  { name: 'big', charset: 'utf8mb4', comment: '规模演示库（100 表，M2 性能验收）' },
];

/** big 库：t001..t100，验证“展开 100 表库 <1s”（概要设计 §10 M2 DoD） */
const BIG_TABLE_COUNT = 100;

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
      Array.from({ length: 20 }, (_, i) => [i + 1, `row${i + 1}`, `${(i + 1) * 1.5}`]),
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

function cellToString(v: unknown): string {
  if (v === null || v === undefined) return '';
  return typeof v === 'string' ? v : JSON.stringify(v);
}

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
        case 'eq':
          return v === f.value;
        case 'ne':
          return v !== f.value;
        case 'like':
          return cellToString(v).includes(String(f.value ?? ''));
        case 'gt':
          return Number(v) > Number(f.value);
        case 'lt':
          return Number(v) < Number(f.value);
        case 'in':
          return (f.values ?? []).some((x) => x === v);
        case 'isNull':
          return v === null;
        case 'isNotNull':
          return v !== null;
        default:
          throw new DriverError('E_VALIDATION', `筛选操作符 "${f.op}" 暂不支持`);
      }
    });
  }
  return out;
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
            rowEstimate: 20,
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
          rowEstimate: def.rows().length,
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

  async fetchRows(req: FetchRowsRequest): Promise<ResultSet> {
    const def = defOf(req.db, req.obj);
    const columns = def.columns;
    let rows = def.rows();

    if (req.search) {
      const kw = req.search;
      rows = rows.filter((r) => r.some((cell) => cellToString(cell).includes(kw)));
    }
    if (req.filters?.length) {
      rows = applyFilters(rows, columns, req.filters);
    }
    const totalCount = rows.length;

    if (req.sorts?.length) {
      rows = [...rows].sort((a, b) => {
        for (const s of req.sorts ?? []) {
          const idx = columns.findIndex((c) => c.name === s.column);
          if (idx < 0) continue;
          const av = a[idx];
          const bv = b[idx];
          let cmp: number;
          if (typeof av === 'number' && typeof bv === 'number') {
            cmp = av - bv;
          } else {
            cmp = cellToString(av).localeCompare(cellToString(bv));
          }
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

  query(_req: QueryRequest): Promise<ResultSet[]> {
    return Promise.reject(
      new DriverError('E_UNSUPPORTED', 'M0 演示驱动未实现 SQL 执行（M5 SQL Console 接入）'),
    );
  }

  previewChanges(_db: string, _obj: string, _cs: ChangeSet): Promise<PreviewItem[]> {
    return Promise.reject(
      new DriverError('E_UNSUPPORTED', 'M0 演示驱动未实现变更提交（M4 表格编辑接入）'),
    );
  }

  applyChanges(_db: string, _obj: string, _cs: ChangeSet) {
    return Promise.reject(
      new DriverError('E_UNSUPPORTED', 'M0 演示驱动未实现变更提交（M4 表格编辑接入）'),
    );
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
    return `"${name.replace(/"/g, '""')}"`;
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
    // 内存驱动无资源需要释放
  }
}

export function createMockDriver(): IDatabaseDriver {
  return {
    id: MOCK_DRIVER_ID,
    displayName: 'Mock 数据源',
    apiVersion: 1,
    capabilities,
    getConnectionFormSchema: () => formSchema,
    testConnection: async (): Promise<TestResult> => {
      const start = Date.now();
      return { ok: true, latencyMs: Date.now() - start + 5, serverVersion: 'mock-1.0' };
    },
    connect: (cfg: ConnectionConfig) => Promise.resolve(new MockConnection(cfg)),
  };
}
