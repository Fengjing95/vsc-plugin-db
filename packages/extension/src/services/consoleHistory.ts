import * as vscode from 'vscode';
import type { ConnectionManager } from './connectionManager';
import { t } from './i18n';

/**
 * Console 执行历史（概要设计 5.5.2 P1：workspaceState 持久化，上限 500 条，可搜索可重跑）：
 * - 完成的执行（成功/失败/取消）才记录；危险拦截不落历史（交互稿 §7.4）
 * - QuickPick 提供搜索与重跑（dbExplorer.queryHistory）
 */
export interface ConsoleHistoryItem {
  id: string;
  ts: number;
  connId: string;
  connName: string;
  db: string | null;
  sql: string;
  ok: boolean;
  /** 'ok' | 'error' | 'canceled' */
  status: 'ok' | 'error' | 'canceled';
  durationMs: number;
  /** 摘要（如 '50 行' / '3 rows affected' / 错误码） */
  summary: string;
  /** 危险横幅“仍要执行”覆盖（本地留痕，交互稿 §7.4） */
  dangerOverridden?: boolean;
}

const HISTORY_KEY = 'dbExplorer.console.history';
const HISTORY_LIMIT = 500;

interface StateStore {
  get<T>(key: string, fallback?: T): T | undefined;
  update(key: string, value: unknown): Thenable<void>;
}

export class ConsoleHistory {
  constructor(
    private readonly workspaceState: StateStore,
    private readonly connections: ConnectionManager,
  ) {}

  list(): ConsoleHistoryItem[] {
    return this.workspaceState.get<ConsoleHistoryItem[]>(HISTORY_KEY) ?? [];
  }

  async record(item: Omit<ConsoleHistoryItem, 'id' | 'ts' | 'connName'>): Promise<void> {
    const connName = this.connections.getConfig(item.connId)?.name ?? item.connId;
    const all = this.list();
    all.unshift({
      ...item,
      id: `hist-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      ts: Date.now(),
      connName,
    });
    await this.workspaceState.update(HISTORY_KEY, all.slice(0, HISTORY_LIMIT));
  }

  /** 连接被删除后清理其历史条目（避免重跑指向不存在的连接） */
  async removeConnection(connId: string): Promise<void> {
    const all = this.list().filter((i) => i.connId !== connId);
    await this.workspaceState.update(HISTORY_KEY, all);
  }
}

/** QuickPick 展示（可搜索可重跑）；返回选中项，Esc 返回 undefined */
export async function pickHistoryItem(items: ConsoleHistoryItem[]): Promise<ConsoleHistoryItem | undefined> {
  if (items.length === 0) {
    void vscode.window.showInformationMessage(t('还没有执行历史。'));
    return undefined;
  }
  const picks = items.map((item) => ({
    item,
    label: item.sql.replace(/\s+/g, ' ').slice(0, 80),
    description: `${item.connName}${item.db ? ` · ${item.db}` : ''} · ${new Date(item.ts).toLocaleString()}`,
    // 状态符号（✓/⊘/✗）留在键外（规则 5）：只有文案进 t()
    detail: `${item.status === 'ok' ? '✓' : item.status === 'canceled' ? `⊘ ${t('已取消')}` : '✗'} ${item.summary} · ${item.durationMs}ms`,
  }));
  const picked = await vscode.window.showQuickPick(picks, {
    title: t('SQL 执行历史（输入过滤，Enter 重跑）'),
    placeHolder: t('搜索历史语句…'),
    matchOnDescription: true,
    matchOnDetail: true,
  });
  return picked?.item;
}
