/**
 * 树「查询」目录的磁盘层：<查询根>/<connId>/<db>/*.sql（树查询管理，M8 优化）。
 * 查询根不与工作区绑定：默认扩展全局存储（globalStorage/queries，Windows 即 %APPDATA% 下），
 * 可经 `dbExplorer.queries.directory` 指向任意磁盘目录（支持 ~/ 前缀，如文稿）。
 * connId 用 UUID——连接改名不失效；db 段经消毒（Redis 通配浏览节点等名称含文件名非法字符）。
 * 含 vscode 依赖，不进单测（纯函数：默认名/显示名/路径段/目录展开在 savedQueries.ts）。
 */
import { homedir } from 'node:os';
import * as vscode from 'vscode';
import { expandQueryDirectory, queryLabel, queryPathSegment } from './savedQueries';

export interface QueryFileEntry {
  /** 文件名（含 .sql 后缀） */
  fileName: string;
  /** 树显示名（不含 .sql 后缀） */
  label: string;
  uri: vscode.Uri;
}

/** 全量查询条目（打开保存的查询选择器用）：附所属连接/库目录段 */
export interface QueryFileRef extends QueryFileEntry {
  connId: string;
  /** 已消毒的 db 目录段（原始库名不可还原，仅作展示/分组） */
  db: string;
}

export class QueryFilesService {
  constructor(private readonly globalStorageUri: vscode.Uri) {}

  /** 查询根目录：dbExplorer.queries.directory（~/ 展开）→ 扩展全局存储 queries/（同步：配置即取即用） */
  rootUri(): vscode.Uri {
    const configured = expandQueryDirectory(
      vscode.workspace.getConfiguration('dbExplorer').get<string>('queries.directory', ''),
      homedir(),
    );
    return configured ? vscode.Uri.file(configured) : vscode.Uri.joinPath(this.globalStorageUri, 'queries');
  }

  /** 该连接/库的查询目录 */
  dirUri(connId: string, db: string): vscode.Uri {
    return vscode.Uri.joinPath(this.rootUri(), connId, queryPathSegment(db));
  }

  /** 列出该库的查询（仅 *.sql，按显示名排序）；目录不存在 = 还没有查询 */
  async list(connId: string, db: string): Promise<QueryFileEntry[]> {
    return this.listIn(this.dirUri(connId, db));
  }

  /** 全量列出查询（遍历 <connId>/<db>/ 两级目录；根不存在 = 空） */
  async listAll(): Promise<QueryFileRef[]> {
    const root = this.rootUri();
    let conns: Array<[string, vscode.FileType]>;
    try {
      conns = await vscode.workspace.fs.readDirectory(root);
    } catch {
      return [];
    }
    const out: QueryFileRef[] = [];
    for (const [connId, connType] of conns) {
      if (connType !== vscode.FileType.Directory) {
        continue;
      }
      let dbs: Array<[string, vscode.FileType]>;
      try {
        dbs = await vscode.workspace.fs.readDirectory(vscode.Uri.joinPath(root, connId));
      } catch {
        continue;
      }
      for (const [dbSeg, dbType] of dbs) {
        if (dbType !== vscode.FileType.Directory) {
          continue;
        }
        const files = await this.listIn(vscode.Uri.joinPath(root, connId, dbSeg));
        for (const f of files) {
          out.push({ ...f, connId, db: dbSeg });
        }
      }
    }
    return out;
  }

  /** 新建空查询文件（目录惰性创建），返回文件 URI */
  async create(connId: string, db: string, name: string): Promise<vscode.Uri> {
    const dir = this.dirUri(connId, db);
    await vscode.workspace.fs.createDirectory(dir);
    const uri = vscode.Uri.joinPath(dir, `${name}.sql`);
    await vscode.workspace.fs.writeFile(uri, new Uint8Array());
    return uri;
  }

  /** 「打开目录」前确保目录存在（首次使用时落地），返回目录 URI */
  async ensureDir(connId: string, db: string): Promise<vscode.Uri> {
    const dir = this.dirUri(connId, db);
    await vscode.workspace.fs.createDirectory(dir);
    return dir;
  }

  /** 删除查询文件（进系统回收站，可恢复） */
  delete(uri: vscode.Uri): Thenable<void> {
    return vscode.workspace.fs.delete(uri, { useTrash: true });
  }

  /** 同目录内重命名查询文件（自动补 .sql 后缀；目标重名由调用方预检，overwrite=false 双保险） */
  rename(dir: vscode.Uri, fileName: string, newBaseName: string): Thenable<void> {
    return vscode.workspace.fs.rename(
      vscode.Uri.joinPath(dir, fileName),
      vscode.Uri.joinPath(dir, `${newBaseName}.sql`),
      { overwrite: false },
    );
  }

  /** 单目录 .sql 列表（过滤 + 显示名排序，list/listAll 共用） */
  private async listIn(dir: vscode.Uri): Promise<QueryFileEntry[]> {
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
}
