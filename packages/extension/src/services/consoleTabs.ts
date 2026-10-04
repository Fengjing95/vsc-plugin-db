import type { ConsoleTabInfo } from '@db-explorer/protocol';

/**
 * 结果面板会话 Tab 推导（M8 #11 多 Tab 结果 & 会话保持，交互稿 §7.3）：
 * 「会话」= 一个已绑定连接的 Console 文档——连接/库绑定 + 最近一次执行结果 +
 * 经由连接的交互式事务上下文。纯函数，零 vscode 依赖，便于单测。
 */

/** ConsoleService 内部状态的极简投影（避免纯层依赖 vscode 侧类型） */
export interface ConsoleTabSource {
  consoleId: string;
  connId: string;
  db: string | null;
  /** 有执行在进行中 */
  running: boolean;
  /** 有最近一次执行结果（state.run 非 null） */
  hasRun: boolean;
  /** 最近一次执行开始时间 */
  lastRunAt: number | null;
}

export interface ConsoleTabEnv {
  /** 连接显示名（连接已删除时回退 connId） */
  connLabelOf(connId: string): string | undefined;
  /** 会话的绑定是否仍可达：untitled 绑定存活或文件绑定存在 */
  addressable(consoleId: string): boolean;
  /** 该会话连接上是否有交互式事务进行中（SessionManager，§4.6） */
  txnActive(connId: string): boolean;
}

/**
 * 推导会话 Tab 列表（按会话创建顺序稳定排列）。
 * 收纳口径：绑定可达（文档开着/文件可重开）恒收；绑定已失（untitled 关闭超回收窗口）
 * 但有执行结果或执行中的会话保留——结果仍可查看/重跑（会话保持）；
 * 绑定失且从未执行过的回收出列表（无事可展示）。
 */
export function deriveConsoleTabs(sources: ConsoleTabSource[], env: ConsoleTabEnv): ConsoleTabInfo[] {
  const tabs: ConsoleTabInfo[] = [];
  for (const s of sources) {
    const keep = env.addressable(s.consoleId) || s.hasRun || s.running;
    if (!keep) {
      continue;
    }
    tabs.push({
      consoleId: s.consoleId,
      connLabel: env.connLabelOf(s.connId) ?? s.connId,
      db: s.db,
      running: s.running,
      txnActive: env.txnActive(s.connId),
      hasRun: s.hasRun,
      lastRunAt: s.lastRunAt,
    });
  }
  return tabs;
}
