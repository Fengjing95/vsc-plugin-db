import * as vscode from 'vscode';
import type { ConnectionManager } from '../services/connectionManager';

export type TreeNodeType = 'connection' | 'database' | 'folder' | 'table' | 'view' | 'column';

export interface DbTreeNode {
  id: string;
  type: TreeNodeType;
  label: string;
  description?: string;
  collapsibleState: vscode.TreeItemCollapsibleState;
  contextValue: string;
  iconId: string;
  payload: { connId?: string; db?: string; obj?: string; kind?: 'table' | 'view' };
}

const { Collapsed, None } = vscode.TreeItemCollapsibleState;

export class ConnectionsTreeProvider implements vscode.TreeDataProvider<DbTreeNode> {
  private readonly emitter = new vscode.EventEmitter<DbTreeNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private readonly connections: ConnectionManager) {}

  refresh(): void {
    this.emitter.fire(undefined);
  }

  getTreeItem(node: DbTreeNode): vscode.TreeItem {
    const item = new vscode.TreeItem(node.label, node.collapsibleState);
    item.id = node.id;
    item.contextValue = node.contextValue;
    item.iconPath = new vscode.ThemeIcon(node.iconId);
    if (node.description) {
      item.description = node.description;
    }
    if (node.type === 'table' || node.type === 'view') {
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
      return this.connections.list().map((c) => ({
        id: `conn:${c.config.id}`,
        type: 'connection',
        label: c.config.name,
        description: `${c.config.driverId} · ${c.config.env ?? 'dev'}`,
        collapsibleState: Collapsed,
        contextValue: 'connection',
        iconId: 'database',
        payload: { connId: c.config.id },
      }));
    }

    switch (node.type) {
      case 'connection': {
        const conn = await this.connections.ensureConnected(node.payload.connId!);
        const dbs = await conn.listDatabases();
        return dbs.map((db) => ({
          id: `${node.id}:${db.name}`,
          type: 'database',
          label: db.name,
          description: db.comment,
          collapsibleState: Collapsed,
          contextValue: 'database',
          iconId: 'server',
          payload: { connId: node.payload.connId, db: db.name },
        }));
      }

      case 'database': {
        return [
          {
            id: `${node.id}:folder-tables`,
            type: 'folder',
            label: '表',
            collapsibleState: Collapsed,
            contextValue: 'folder-tables',
            iconId: 'folder',
            payload: { ...node.payload, kind: 'table' },
          },
          {
            id: `${node.id}:folder-views`,
            type: 'folder',
            label: '视图',
            collapsibleState: Collapsed,
            contextValue: 'folder-views',
            iconId: 'folder',
            payload: { ...node.payload, kind: 'view' },
          },
        ];
      }

      case 'folder': {
        const conn = await this.connections.ensureConnected(node.payload.connId!);
        const objs: Awaited<ReturnType<typeof conn.listObjects>> = await conn.listObjects(
          node.payload.db!,
        );
        const kind = node.payload.kind ?? 'table';
        return objs
          .filter((o) => o.kind === kind)
          .map((o) => ({
            id: `${node.id}:${o.name}`,
            type: kind,
            label: o.name,
            description:
              o.rowEstimate !== undefined ? `~${o.rowEstimate} 行` : o.comment,
            collapsibleState: kind === 'table' ? Collapsed : None,
            contextValue: kind,
            iconId: kind === 'table' ? 'table' : 'eye',
            payload: { connId: node.payload.connId, db: node.payload.db, obj: o.name },
          }));
      }

      case 'table': {
        const conn = await this.connections.ensureConnected(node.payload.connId!);
        const cols = await conn.listColumns(node.payload.db!, node.payload.obj!);
        return cols.map((c) => ({
          id: `${node.id}:${c.name}`,
          type: 'column',
          label: c.name,
          description: columnDescription(c),
          collapsibleState: None,
          contextValue: 'column',
          iconId: 'symbol-field',
          payload: {},
        }));
      }

      default:
        return [];
    }
  }
}

function columnDescription(c: { dataType: string; isPrimaryKey: boolean; nullable: boolean }): string {
  const parts = [c.dataType];
  if (c.isPrimaryKey) parts.push('PK');
  if (!c.nullable) parts.push('NOT NULL');
  return parts.join(' ');
}
