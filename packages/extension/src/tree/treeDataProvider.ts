import * as vscode from 'vscode';
import type { MetadataCache } from '@db-explorer/core';
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
    column?: string;
    rowEstimate?: number;
  };
}

const { Collapsed, None } = vscode.TreeItemCollapsibleState;

export class ConnectionsTreeProvider implements vscode.TreeDataProvider<DbTreeNode> {
  private readonly emitter = new vscode.EventEmitter<DbTreeNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(
    private readonly connections: ConnectionManager,
    private readonly cache: MetadataCache,
  ) {}

  refresh(): void {
    this.emitter.fire(undefined);
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
      return configs.map((c) => ({
        id: `conn:${c.id}`,
        type: 'connection',
        label: c.name,
        description: [c.driverId, c.env ?? 'dev', c.readOnly ? '只读' : undefined]
          .filter(Boolean)
          .join(' · '),
        collapsibleState: Collapsed,
        contextValue: 'connection',
        iconId: 'database',
        payload: { connId: c.id },
      }));
    }

    switch (node.type) {
      case 'connection': {
        const connId = node.payload.connId!;
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
        // 目录节点按 listObjects 实际返回的 kind 数据驱动生成（M6：Redis 仅 Keys 目录，
        // 概要设计 §5.1.3 —— UI 经 capabilities/数据决定渲染层级，不做数据源硬编码）
        const connId = node.payload.connId!;
        const db = node.payload.db!;
        const conn = await this.connections.ensureConnected(connId);
        const objs = await this.cache.getObjects(connId, db, () => conn.listObjects(db));
        return KIND_FOLDERS.filter((k) => objs.some((o) => o.kind === k.kind)).map((k) => {
          const count = objs.filter((o) => o.kind === k.kind).length;
          return this.folderNode(node, k.kind, k.label, k.iconId, countLabel(count));
        });
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
      // M6 键值数据源：模式分组节点（名称含 glob）与单键（comment=类型）都打开表格视图
      const objs = await this.cache.getObjects(connId, db, () => conn.listObjects(db));
      return objs
        .filter((o) => o.kind === 'collection')
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

  private folderNode(parent: DbTreeNode, kind: FolderKind, label: string, iconId: string, count?: string): DbTreeNode {
    return {
      id: `${parent.id}:folder-${kind}`,
      type: 'folder',
      label,
      description: count,
      collapsibleState: Collapsed,
      contextValue: `folder-${kind}`,
      iconId,
      payload: { ...parent.payload, kind },
    };
  }
}

/** 目录节点统计：0 不显示（避免噪音） */
function countLabel(n: number): string | undefined {
  return n > 0 ? String(n) : undefined;
}
