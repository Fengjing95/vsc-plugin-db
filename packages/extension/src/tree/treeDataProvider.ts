import * as vscode from 'vscode';
import type { MetadataCache, ObjectMeta } from '@db-explorer/core';
import type { ConnectionManager } from '../services/connectionManager';

export type TreeNodeType =
  | 'connection'
  | 'database'
  | 'folder'
  | 'table'
  | 'view'
  | 'collection'
  | 'column'
  | 'key'
  | 'index';

export type FolderKind = 'table' | 'view' | 'collection' | 'columns' | 'keys' | 'indexes';

/** 数据源的目录分组（kind → 目录标签/图标）：数据驱动渲染，非 SQL 数据源（collection）同构处理 */
const KIND_FOLDERS: Array<{ kind: FolderKind; label: string; iconId: string }> = [
  { kind: 'table', label: '表', iconId: 'folder' },
  { kind: 'view', label: '视图', iconId: 'folder' },
  { kind: 'collection', label: 'Keys', iconId: 'folder' },
];

export interface DbTreeNode {
  id: string;
  type: TreeNodeType;
  label: string;
  description?: string;
  collapsibleState: vscode.TreeItemCollapsibleState;
  contextValue: string;
  iconId: string;
  payload: {
    connId?: string;
    db?: string;
    obj?: string;
    kind?: FolderKind;
    /** collection 目录的分组 id（= ObjectMeta.schema，键值数据源按类型归组） */
    group?: string;
    column?: string;
    rowEstimate?: number;
  };
}

const { Collapsed, None } = vscode.TreeItemCollapsibleState;

export class ConnectionsTreeProvider implements vscode.TreeDataProvider<DbTreeNode> {
  private readonly emitter = new vscode.EventEmitter<DbTreeNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  /** 最近一次构建的连接根节点（断开收起用：元素级刷新需要「当前」元素对象） */
  private connectionNodes = new Map<string, DbTreeNode>();
  /**
   * 连接节点的 TreeItem id 代数（P-33）：VSCode 按 TreeItem.id 记忆展开状态，
   * 且 reveal({expand:false}) 收不起已展开节点（实测）。断开时递增代数并元素级刷新，
   * 视图将其视为新节点 → 按构建时的 Collapsed 渲染，收起为确定性行为。
   */
  private readonly collapseEpoch = new Map<string, number>();

  constructor(
    private readonly connections: ConnectionManager,
    private readonly cache: MetadataCache,
    /** 交互式事务会话（§4.6）：「事务进行中」树徽标数据源 */
    private readonly sessions?: { hasActive(connId: string): boolean },
  ) {}

  /** extension.ts 创建 treeView 后回挂（保留句柄以备 reveal 类需求） */
  attachView(_view: vscode.TreeView<DbTreeNode>): void {
    // P-33 起收起不再依赖 reveal（按 id 代数方案），句柄暂无消费方——保留挂载点
  }

  refresh(): void {
    this.emitter.fire(undefined);
  }

  /**
   * 断开连接后收起该连接节点（断开 = 回到空闲态，展开内容已失效）。
   * P-33：VSCode 按 TreeItem.id 记忆展开状态，reveal({expand:false}) 收不起已展开节点（实测）。
   * 方案：递增该连接的 id 代数 + 元素级刷新 → 视图按新建节点（Collapsed）渲染，确定性行为；
   * 刷新期间子级拉取由 ConnectionManager 断开保护窗口兜底（不自动重连）。
   */
  collapseConnection(connId: string): void {
    this.collapseEpoch.set(connId, (this.collapseEpoch.get(connId) ?? 0) + 1);
    const node = this.connectionNodes.get(`conn:${connId}`);
    if (node) {
      this.emitter.fire(node);
    } else {
      this.refresh(); // 兜底：根重建同样带新代数 id
    }
  }

  /** 子树刷新：仅失效该节点以下的缓存（概要设计 5.3.3） */
  refreshSubtree(node: DbTreeNode): void {
    const { connId, db } = node.payload;
    if (node.type === 'connection' && connId) {
      this.cache.invalidateConnection(connId);
    } else if (node.type === 'database' && connId && db) {
      this.cache.invalidateDb(connId, db);
    }
    this.refresh();
  }

  /** 全局刷新：清空全部缓存并重载（概要设计 5.3.3） */
  clearCacheAndRefresh(): void {
    this.cache.clear();
    this.refresh();
  }

  getTreeItem(node: DbTreeNode): vscode.TreeItem {
    const item = new vscode.TreeItem(node.label, node.collapsibleState);
    // 连接节点 id 带代数：断开收起时递增代数 → 视图展开缓存（按 id 记忆）失效 → 按新节点渲染
    const epoch = node.type === 'connection' ? this.collapseEpoch.get(node.payload.connId ?? '') ?? 0 : null;
    item.id = epoch !== null ? `${node.id}#${epoch}` : node.id;
    item.contextValue = node.contextValue;
    item.iconPath = new vscode.ThemeIcon(node.iconId);
    if (node.description) {
      item.description = node.description;
    }
    if (node.type === 'table' || node.type === 'view' || node.type === 'collection') {
      item.command = {
        command: 'dbExplorer.openTable',
        title: '打开表格视图',
        arguments: [node],
      };
    }
    return item;
  }

  async getChildren(node?: DbTreeNode): Promise<DbTreeNode[]> {
    if (!node) {
      const configs = await this.connections.listConfigs();
      const rootNodes = configs.map((c) => {
        const connectionNode: DbTreeNode = {
          id: `conn:${c.id}`,
          type: 'connection',
          label: c.name,
          // 连接状态徽标（概要 §8.1：未连接 / 已连接）；懒连接语义下展开即建连
          description: [
            c.driverId,
            c.env ?? 'dev',
            c.readOnly ? '只读' : undefined,
            this.sessions?.hasActive(c.id) ? '事务进行中' : undefined,
            this.connections.isConnected(c.id) ? '已连接' : '未连接',
          ]
            .filter(Boolean)
            .join(' · '),
          collapsibleState: Collapsed,
          // 已连接节点附加 connected 令牌：package.json when 据此隐藏未连接时的
          // 新建 Console/刷新/断开按钮（M7 评审：未连接时这三个操作要么强制建连要么无意义）
          contextValue: this.connections.isConnected(c.id) ? 'connection connected' : 'connection',
          iconId: 'database',
          payload: { connId: c.id },
        };
        this.connectionNodes.set(connectionNode.id, connectionNode);
        return connectionNode;
      });
      // 清掉已删除连接的残留引用
      for (const key of [...this.connectionNodes.keys()]) {
        if (!rootNodes.some((n) => n.id === key)) {
          this.connectionNodes.delete(key);
        }
      }
      return rootNodes;
    }

    switch (node.type) {
      case 'connection': {
        const connId = node.payload.connId!;
        // P-33 竞态防护：断开触发的树刷新会重新拉取「展开着」的连接节点的子级，
        // ensureConnected 会把刚断开的连接静默拉起（本地握手毫秒级，稳赢延迟收起）。
        // 断开保护窗口内返回空子级，等收起完成后由用户主动展开再连（D-10 展开即重连）。
        if (!this.connections.isConnected(connId) && this.connections.recentlyDisconnected(connId)) {
          return [];
        }
        const conn = await this.connections.ensureConnected(connId);
        const dbs = await this.cache.getDatabases(connId, () => conn.listDatabases());
        return dbs.map((db) => ({
          id: `${node.id}:${db.name}`,
          type: 'database',
          label: db.name,
          description: db.comment,
          collapsibleState: Collapsed,
          // M8-B2：支持表结构编辑的驱动追加 ddl 令牌（package.json when 控制新建表入口显隐）
          contextValue: this.ddlCapable(connId) ? 'database ddl' : 'database',
          iconId: 'server',
          payload: { connId, db: db.name },
        }));
      }

      case 'database': {
        // 目录节点按 listObjects 实际返回的 kind 数据驱动生成（M6：Redis 类型目录，
        // 概要设计 §5.1.3 —— UI 经数据决定渲染层级，不做数据源硬编码）。
        // collection 条目按 ObjectMeta.schema 归组（驱动虚拟化的分组 id）；
        // 无 schema 条目归入默认 Keys 目录（如 '*' 模式浏览节点）
        const connId = node.payload.connId!;
        const db = node.payload.db!;
        const conn = await this.connections.ensureConnected(connId);
        const objs = await this.cache.getObjects(connId, db, () => conn.listObjects(db));
        const folders: DbTreeNode[] = [];
        for (const k of KIND_FOLDERS) {
          if (k.kind === 'collection') {
            const groups = new Map<string, ObjectMeta[]>();
            for (const o of objs) {
              if (o.kind === 'collection') {
                const g = o.schema ?? '';
                groups.set(g, [...(groups.get(g) ?? []), o]);
              }
            }
            for (const [group, members] of groups) {
              folders.push(
                this.folderNode(
                  node,
                  'collection',
                  group === '' ? 'Keys' : group,
                  'folder',
                  countLabel(members.length),
                  group,
                ),
              );
            }
          } else {
            const members = objs.filter((o) => o.kind === k.kind);
            if (members.length > 0) {
              folders.push(this.folderNode(node, k.kind, k.label, k.iconId, countLabel(members.length)));
            }
          }
        }
        return folders;
      }

      case 'table': {
        const connId = node.payload.connId!;
        const db = node.payload.db!;
        const obj = node.payload.obj!;
        const conn = await this.connections.ensureConnected(connId);
        const [cols, keys, indexes] = await Promise.all([
          this.cache.getColumns(connId, db, obj, () => conn.listColumns(db, obj)),
          this.cache.getKeys(connId, db, obj, () =>
            conn.listKeys ? conn.listKeys(db, obj) : Promise.resolve([]),
          ),
          this.cache.getIndexes(connId, db, obj, () =>
            conn.listIndexes ? conn.listIndexes(db, obj) : Promise.resolve([]),
          ),
        ]);
        return [
          this.folderNode(node, 'columns', '列', 'symbol-field', countLabel(cols.length)),
          this.folderNode(node, 'keys', '键', 'key', countLabel(keys.length)),
          this.folderNode(node, 'indexes', '索引', 'list-ordered', countLabel(indexes.length)),
        ];
      }

      case 'folder': {
        return this.getFolderChildren(node);
      }

      default:
        return [];
    }
  }

  private async getFolderChildren(node: DbTreeNode): Promise<DbTreeNode[]> {
    const connId = node.payload.connId!;
    const db = node.payload.db!;
    const conn = await this.connections.ensureConnected(connId);
    const kind = node.payload.kind ?? 'table';

    if (kind === 'table' || kind === 'view') {
      const objs = await this.cache.getObjects(connId, db, () => conn.listObjects(db));
      return objs
        .filter((o) => o.kind === kind)
        .map((o) => ({
          id: `${node.id}:${o.name}`,
          type: kind,
          label: o.name,
          // 行估算不再上树（M4 评审反馈，交互稿 §8.1 v0.1.2）；注释可得时展示
          description: o.comment,
          collapsibleState: kind === 'table' ? Collapsed : None,
          // M8-B2：table 且驱动支持表结构编辑时追加 ddl 令牌（修改表结构/删表/清空入口显隐）
          contextValue: kind === 'table' && this.ddlCapable(connId) ? `${kind} ddl` : kind,
          iconId: kind === 'table' ? 'table' : 'eye',
          // rowEstimate 仍随 payload 供表格分页栏“约 N 行”（交互稿 §4.7）
          payload: { connId, db, obj: o.name, rowEstimate: o.rowEstimate },
        }));
    }

    if (kind === 'collection') {
      // M6 键值数据源：仅列出该分组（payload.group = ObjectMeta.schema）的条目；
      // 模式分组节点（名称含 glob）与单键都打开表格视图
      const group = node.payload.group ?? '';
      const objs = await this.cache.getObjects(connId, db, () => conn.listObjects(db));
      return objs
        .filter((o) => o.kind === 'collection' && (o.schema ?? '') === group)
        .map((o) => ({
          id: `${node.id}:${o.name}`,
          type: 'collection' as const,
          label: o.name,
          description: o.comment,
          collapsibleState: None,
          contextValue: 'collection',
          iconId: o.name.includes('*') || o.name.includes('?') ? 'search' : 'key',
          payload: { connId, db, obj: o.name, rowEstimate: o.rowEstimate },
        }));
    }

    if (kind === 'columns') {
      const obj = node.payload.obj!;
      const cols = await this.cache.getColumns(connId, db, obj, () => conn.listColumns(db, obj));
      return cols.map((c) => ({
        id: `${node.id}:${c.name}`,
        type: 'column',
        label: c.name,
        description: [c.dataType, c.isPrimaryKey ? 'PK' : undefined, c.nullable ? undefined : 'NOT NULL']
          .filter(Boolean)
          .join(' '),
        collapsibleState: None,
        contextValue: 'column',
        iconId: 'symbol-field',
        payload: { connId, db, obj, column: c.name },
      }));
    }

    if (kind === 'keys') {
      const obj = node.payload.obj!;
      const keys = await this.cache.getKeys(connId, db, obj, () =>
        conn.listKeys ? conn.listKeys(db, obj) : Promise.resolve([]),
      );
      return keys.map((k) => ({
        id: `${node.id}:${k.kind}:${k.name}`,
        type: 'key',
        label:
          k.kind === 'FK'
            ? `FK  ${k.columns.join(', ')} → ${k.refTable ?? '?'}.${(k.refColumns ?? ['?']).join(', ')}`
            : k.kind === 'PK'
              ? `PK  ${k.columns.join(', ')}`
              : `${k.name}  (${k.columns.join(', ')})`,
        description: k.kind === 'UNIQUE' ? 'UNIQUE' : k.name,
        collapsibleState: None,
        contextValue: 'key',
        iconId: k.kind === 'FK' ? 'references' : 'key',
        payload: { connId, db, obj },
      }));
    }

    // indexes
    const obj = node.payload.obj!;
    const idx = await this.cache.getIndexes(connId, db, obj, () =>
      conn.listIndexes ? conn.listIndexes(db, obj) : Promise.resolve([]),
    );
    return idx.map((i) => ({
      id: `${node.id}:${i.name}`,
      type: 'index',
      label: i.name,
      description: [i.unique ? 'UNIQUE' : undefined, i.type, `(${i.columns.join(', ')})`]
        .filter(Boolean)
        .join(' '),
      collapsibleState: None,
      contextValue: 'index',
      iconId: 'list-ordered',
      payload: { connId, db, obj },
    }));
  }

  private folderNode(
    parent: DbTreeNode,
    kind: FolderKind,
    label: string,
    iconId: string,
    count?: string,
    group?: string,
  ): DbTreeNode {
    return {
      id: `${parent.id}:folder-${kind}-${group || 'default'}`,
      type: 'folder',
      label,
      description: count,
      collapsibleState: Collapsed,
      // M8-B2：表目录在支持表结构编辑的驱动上追加 ddl 令牌（新建表入口显隐）
      contextValue: kind === 'table' && this.ddlCapable(parent.payload.connId!) ? `folder-${kind} ddl` : `folder-${kind}`,
      iconId,
      payload: { ...parent.payload, kind, ...(group !== undefined ? { group } : {}) },
    };
  }

  /** 驱动是否支持表结构编辑（概要 §5.9 supportsDdlEditor）；驱动未注册时保守为不支持 */
  private ddlCapable(connId: string): boolean {
    return this.connections.getDriver(connId)?.capabilities.supportsDdlEditor === true;
  }
}

/** 目录节点统计：0 不显示（避免噪音） */
function countLabel(n: number): string | undefined {
  return n > 0 ? String(n) : undefined;
}
