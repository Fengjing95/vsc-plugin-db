import * as vscode from 'vscode';
import {
  DriverError,
  ER_MAX_TABLES,
  ER_LAYOUT_CONSTS,
  collectRelationGraph,
  layoutErGraph,
  type ErGraphScope,
  type MetadataCache,
} from '@db-explorer/core';
import { ErGraphParamsSchema, type ErGraphResult } from '@db-explorer/protocol';
import type { ConnectionManager } from './connectionManager';
import type { Logger } from './logger';
import { t } from './i18n';

/**
 * ER 图服务（M8-ER，概要 §5.11 / ADR D-22）：
 * - load：关系收集（collectRelationGraph，经 MetadataCache 包装——TTL 与 DDL 失效联动 §7.5）
 *   + 分层布局（layoutErGraph，Host 侧计算，C-13）→ er.getGraph 载荷
 * - refresh：绕缓存重拉（失效该库 objects/columns/keys 后重建，树节点刷新语义）
 * - prepareOpen：树命令打开引导——表数 ≤ ER_MAX_TABLES 直开全量；超限 QuickPick 选择表
 *   （默认全选、可输入过滤反选）→ selection scope（无白屏往返，交互稿 §13.2）
 *
 * 不经 DriverHost：ER 全链路是元数据自省（LoggingDriverHost 只拦查询执行，§5.10），无查询语句
 */

export class ErService {
  constructor(
    private readonly deps: {
      connections: ConnectionManager;
      cache: MetadataCache;
      logger: Logger;
    },
  ) {}

  async load(raw: unknown): Promise<ErGraphResult> {
    const p = ErGraphParamsSchema.parse(raw);
    const conn = await this.deps.connections.ensureConnected(p.connId);
    if (p.refresh) {
      this.deps.cache.invalidateDb(p.connId, p.db);
    }
    const started = Date.now();
    // 缓存包装（概要 §7.5）：重开同库毫秒级；collect 只消费自省面（IConnection 结构兼容）
    const source = {
      listObjects: (db: string) => this.deps.cache.getObjects(p.connId, db, () => conn.listObjects(db)),
      listColumns: (db: string, obj: string) =>
        this.deps.cache.getColumns(p.connId, db, obj, () => conn.listColumns(db, obj)),
      listKeys: (db: string, obj: string) =>
        this.deps.cache.getKeys(p.connId, db, obj, () => conn.listKeys!(db, obj)),
    };
    const graph = await collectRelationGraph(source, p.db, p.scope);
    const layout = layoutErGraph(
      graph.tables.map((t) => ({ name: t.name, rows: t.columns.length })),
      graph.edges.map((e) => ({ source: e.sourceTable, target: e.targetTable })),
    );
    this.deps.logger.debug(
      'er',
      `conn=${p.connId.slice(0, 8)} db=${p.db}：${graph.tables.length} 表 / ${graph.edges.length} 边 / ${Date.now() - started}ms`,
    );
    return {
      tables: graph.tables,
      edges: graph.edges,
      layout: {
        nodes: layout.nodes,
        width: layout.width,
        height: layout.height,
        ...ER_LAYOUT_CONSTS,
      },
      tableCount: graph.tables.length,
      hiddenEdges: graph.hiddenEdges,
    };
  }

  /**
   * 树命令打开引导（交互稿 §13.2）：> 硬上限时 QuickPick 多选（默认全选），
   * 取消（Esc / 空选集）返回 null（不打开面板）
   */
  async prepareOpen(connId: string, db: string): Promise<ErGraphScope | null> {
    const conn = await this.deps.connections.ensureConnected(connId);
    const objs = await this.deps.cache.getObjects(connId, db, () => conn.listObjects(db));
    const tables = objs.filter((o) => o.kind === 'table').map((o) => o.name);
    if (tables.length <= ER_MAX_TABLES) {
      return { kind: 'all' };
    }
    const picked = await pickTables(tables);
    if (!picked || picked.length === 0) {
      return null;
    }
    return { kind: 'selection', tables: picked };
  }

  /** erCapable 双检（树菜单已裁剪，命令面板直呼时防御性兜底） */
  assertCapable(connId: string): void {
    if (this.deps.connections.getDriver(connId)?.capabilities.supportsErDiagram !== true) {
      throw new DriverError('E_UNSUPPORTED', t('当前数据库类型不支持 ER 图'));
    }
  }
}

/** QuickPick 多选（默认全选、输入过滤反选）；Esc/关闭 = null */
async function pickTables(tables: string[]): Promise<string[] | null> {
  const qp = vscode.window.createQuickPick();
  qp.title = t('库内共 {0} 张表，超出单图上限：请选择要绘制的表', [tables.length]);
  qp.canSelectMany = true;
  qp.items = tables.map((name) => ({ label: name }));
  qp.selectedItems = qp.items;
  qp.placeholder = t('输入过滤表名，回车确认');
  return new Promise<string[] | null>((resolve) => {
    qp.onDidAccept(() => {
      resolve(qp.selectedItems.map((i) => i.label));
      qp.dispose();
    });
    qp.onDidHide(() => {
      resolve(null);
      qp.dispose();
    });
    qp.show();
  });
}
