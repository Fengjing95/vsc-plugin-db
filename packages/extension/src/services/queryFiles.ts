/**
 * 树「查询」目录的磁盘层：.vscode/db-queries/<connId>/<db>/*.sql（树查询管理，M8 优化）。
 * 与「保存查询」（savedQueryActions）同一根目录（§5.5.2）：connId 用 UUID——连接改名不失效；
 * db 段经消毒（Redis 通配浏览节点等名称含文件名非法字符）。多根工作区取第一个，与导出默认目录口径一致。
 * 含 vscode 依赖，不进单测（纯函数：默认名/显示名/路径段在 savedQueries.ts）。
 */
import * as vscode from 'vscode';
import { queryLabel, queryPathSegment } from './savedQueries';

export interface QueryFileEntry {
  /** 文件名（含 .sql 后缀） */
  fileName: string;
  /** 树显示名（不含 .sql 后缀） */
  label: string;
  uri: vscode.Uri;
}

export class QueryFilesService {
  /** 该连接/库的查询目录（同步：workspaceFolders 即取即用）；无工作区返回 undefined */
  dirUri(connId: string, db: string): vscode.Uri | undefined {
    const ws = vscode.workspace.workspaceFolders?.[0];
    if (!ws) {
      return undefined;
    }
    return vscode.Uri.joinPath(ws.uri, '.vscode', 'db-queries', connId, queryPathSegment(db));
  }

  /** 列出该库的查询（仅 *.sql，按显示名排序）；目录不存在 = 还没有查询 */
  async list(connId: string, db: string): Promise<QueryFileEntry[]> {
    const dir = this.dirUri(connId, db);
    if (!dir) {
      return [];
    }
    let entries: Array<[string, vscode.FileType]>;
    try {
      entries = await vscode.workspace.fs.readDirectory(dir);
    } catch {
      return [];
    }
    return entries
      .filter(([name, type]) => type === vscode.FileType.File && /\.sql$/i.test(name))
      .map(([name]) => ({ fileName: name, label: queryLabel(name), uri: vscode.Uri.joinPath(dir, name) }))
      .sort((a, b) => a.label.localeCompare(b.label, 'zh-Hans-CN', { numeric: true }));
  }

  /** 新建空查询文件（目录惰性创建），返回文件 URI */
  async create(connId: string, db: string, name: string): Promise<vscode.Uri> {
    const dir = this.dirUri(connId, db);
    if (!dir) {
      throw new Error('当前没有打开的工作区，无法创建查询。');
    }
    await vscode.workspace.fs.createDirectory(dir);
    const uri = vscode.Uri.joinPath(dir, `${name}.sql`);
    await vscode.workspace.fs.writeFile(uri, new Uint8Array());
    return uri;
  }

  /** 「打开目录」前确保目录存在（首次使用时落地），返回目录 URI */
  async ensureDir(connId: string, db: string): Promise<vscode.Uri | undefined> {
    const dir = this.dirUri(connId, db);
    if (!dir) {
      return undefined;
    }
    await vscode.workspace.fs.createDirectory(dir);
    return dir;
  }

  /** 删除查询文件（进系统回收站，可恢复） */
  delete(uri: vscode.Uri): Thenable<void> {
    return vscode.workspace.fs.delete(uri, { useTrash: true });
  }
}
