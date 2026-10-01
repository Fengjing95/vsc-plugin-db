import type { ConsoleRun, ConsoleRunItem } from '@db-explorer/protocol';

/**
 * Console 结果面板视图推导（交互稿 §7.3）：
 * - 多语句 → 按语句生成结果 Tab；SELECT 语句 = “结果 N”；非 SELECT 进“消息”Tab
 * - 消息 Tab 恒显示最后一条语句的耗时/影响行数/错误摘要
 * 纯函数，便于单测（与 store 分离，避免在 node 测试中触发 acquireVsCodeApi）。
 */

export interface ConsoleTab {
  id: string;
  kind: 'result' | 'message';
  label: string;
  /** kind=result 时对应的执行项 */
  item?: ConsoleRunItem;
}

export function deriveTabs(run: ConsoleRun | null): ConsoleTab[] {
  if (!run) {
    return [];
  }
  const tabs: ConsoleTab[] = [];
  let resultIndex = 0;
  for (const item of run.items) {
    if (item.resultSet) {
      resultIndex++;
      tabs.push({ id: `result-${item.seq}`, kind: 'result', label: `结果 ${resultIndex}`, item });
    }
  }
  tabs.push({ id: 'msg', kind: 'message', label: '消息' });
  return tabs;
}

/** 单行化 SQL（Tab/状态行展示用） */
export function oneLineSql(sql: string): string {
  const line = sql.replace(/\s+/g, ' ').trim();
  return line.length > 60 ? `${line.slice(0, 60)}…` : line;
}

function itemSummary(item: ConsoleRunItem): string {
  if (item.error) {
    return `错误 ${item.error.code}: ${item.error.message}`;
  }
  if (item.affectedRows !== undefined) {
    return `${item.affectedRows} rows affected · ${item.executionMs}ms`;
  }
  return `${item.resultSet?.rowCount ?? 0} 行 · ${item.executionMs}ms`;
}

/** 消息 Tab 内容：非 SELECT 汇总 + 警告 + 运行状态 + 最后一条语句摘要 */
export function messageLines(run: ConsoleRun): string[] {
  const lines: string[] = [];
  for (const item of run.items) {
    if (item.resultSet) {
      continue;
    }
    lines.push(`[${item.seq}] ${oneLineSql(item.sql)}`);
    lines.push(`  → ${itemSummary(item)}`);
    for (const w of item.messages ?? []) {
      lines.push(`  ⚠ ${w}`);
    }
  }
  if (run.status === 'canceled') {
    lines.push('⊘ 已取消');
  }
  const last = run.items[run.items.length - 1];
  if (last) {
    lines.push(`最后一条语句：${itemSummary(last)}`);
  } else if (run.status === 'running') {
    lines.push('执行中…');
  }
  return lines;
}

/** 状态行（结果 Tab）：`SELECT … · 12ms · 50 行` */
export function resultStatusLine(item: ConsoleRunItem): string {
  return `${oneLineSql(item.sql)} · ${item.executionMs}ms · ${item.resultSet?.rowCount ?? 0} 行`;
}

/** 运行状态文案（状态行右段 / 消息 Tab） */
export function runStatusText(run: ConsoleRun): string {
  switch (run.status) {
    case 'running':
      return '执行中…';
    case 'ok':
      return `完成（${run.durationMs}ms）`;
    case 'canceled':
      return '已取消';
    case 'error':
      return `出错（${run.durationMs}ms）`;
  }
}
