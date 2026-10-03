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
  /** 最近一次构建的连接根节点（断开后收起节点用：reveal 需要「当前」元素对象，重建后旧引用失效） */
  private connectionNodes = new Map<string, DbTreeNode>();
  private view?: vscode.TreeView<DbTreeNode>;

  constructor(
    private readonly connections: ConnectionManager,
    private readonly cache: MetadataCache,
  ) {}

  /** extension.ts 创建 treeView 后回挂（reveal 收起节点需要视图句柄） */
  attachView(view: vscode.TreeView<DbTreeNode>): void {
    this.view = view;
  }

  refresh(): void {
    this.emitter.fire(undefined);
  }

  /**
   * 断开连接后收起该连接节点（断开 = 回到空闲态，展开内容已失效）。
   * 两头竞态（P-33）：
   * - 树刷新（状态事件触发）会恢复节点展开状态，必须等重建完成后再收起——收起早于刷新会被覆盖；
   * - 重建后的子级拉取若先到，会经 ensureConnected 把连接拉回（ConnectionManager 断开保护窗口兜底）。
   * reveal 重试至多 10 次（每次取最新节点引用，重建后旧引用失效），失败静默。
   */
  collapseConnection(connId: string): void {
    const attempts = 10;
    for (let i = 0; i < attempts; i++) {
      setTimeout(() => {
        const node = this.connectionNodes.get(`conn:${connId}`); // 每次取最新引用
        if (!node || !this.view) {
          return;
        }
        void Promise.resolve(this.view.reveal(node, { expand: false })).catch(() => undefined);
      }, 120 * i);
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
    item.id = node.id;
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
          contextValue: 'database',
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
          contextValue: kind,
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
      contextValue: `folder-${kind}`,
      iconId,
      payload: { ...parent.payload, kind, ...(group !== undefined ? { group } : {}) },
    };
  }
}

/** 目录节点统计：0 不显示（避免噪音） */
function countLabel(n: number): string | undefined {
  return n > 0 ? String(n) : undefined;
}
