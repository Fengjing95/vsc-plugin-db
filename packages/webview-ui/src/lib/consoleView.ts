import type { ConsoleAi, ConsoleRun, ConsoleRunItem } from '@db-explorer/protocol';
import { t } from './i18n';

/**
 * Console 结果面板视图推导（交互稿 §7.3）：
 * - 多语句 → 按语句生成结果 Tab；SELECT 语句 = “结果 N”；非 SELECT 进“消息”Tab
 * - 消息 Tab 恒显示最后一条语句的耗时/影响行数/错误摘要
 * - M9-AI：存在 AI 解释时追加「AI 解释」Tab（交互稿 §15.3，排在消息后）
 * 纯函数，便于单测（与 store 分离，避免在 node 测试中触发 acquireVsCodeApi）。
 */

export interface ConsoleTab {
  id: string;
  kind: 'result' | 'message' | 'ai';
  label: string;
  /** kind=result 时对应的执行项 */
  item?: ConsoleRunItem;
}

export function deriveTabs(run: ConsoleRun | null, ai?: ConsoleAi | null): ConsoleTab[] {
  if (!run && !ai) {
    return [];
  }
  const tabs: ConsoleTab[] = [];
  let resultIndex = 0;
  for (const item of run?.items ?? []) {
    if (item.resultSet) {
      resultIndex++;
      tabs.push({ id: `result-${item.seq}`, kind: 'result', label: t('console.resultTab', [resultIndex]), item });
    }
  }
  tabs.push({ id: 'msg', kind: 'message', label: t('console.messagesTab') });
  if (ai) {
    tabs.push({ id: 'ai', kind: 'ai', label: t('ai.tabLabel') });
  }
  return tabs;
}

/** 单行化 SQL（Tab/状态行展示用） */
export function oneLineSql(sql: string): string {
  const line = sql.replace(/\s+/g, ' ').trim();
  return line.length > 60 ? `${line.slice(0, 60)}…` : line;
}

/** 执行项摘要（消息 Tab 行 / 状态行共用） */
export function runItemSummary(item: ConsoleRunItem): string {
  if (item.error) {
    return t('console.errorSummary', [item.error.code, item.error.message]);
  }
  if (item.affectedRows !== undefined) {
    return t('console.rowsAffected', [item.affectedRows, item.executionMs]);
  }
  return t('console.rowCountMs', [item.resultSet?.rowCount ?? 0, item.executionMs]);
}

function itemSummary(item: ConsoleRunItem): string {
  return runItemSummary(item);
}

/** 消息 Tab 内容：非 SELECT 汇总 + 警告 + 运行状态 + 最后一条语句摘要 */
export function messageLines(run: ConsoleRun): string[] {
  const lines: string[] = [];
  for (const item of run.items) {
    if (item.resultSet) {
      continue;
    }
    lines.push(t('console.itemLine', [item.seq, oneLineSql(item.sql)]));
    lines.push(t('console.itemSummaryLine', [itemSummary(item)]));
    for (const w of item.messages ?? []) {
      lines.push(t('console.warnLine', [w]));
    }
  }
  if (run.status === 'canceled') {
    lines.push(t('console.canceledLine'));
  }
  const last = run.items[run.items.length - 1];
  if (last) {
    lines.push(t('console.lastStatement', [itemSummary(last)]));
  } else if (run.status === 'running') {
    lines.push(t('console.running'));
  }
  return lines;
}

/** 状态行（结果 Tab）：`SELECT … · 12ms · 50 行` */
export function resultStatusLine(item: ConsoleRunItem): string {
  return t('console.resultStatusLine', [oneLineSql(item.sql), item.executionMs, item.resultSet?.rowCount ?? 0]);
}

/** 运行状态文案（状态行右段 / 消息 Tab） */
export function runStatusText(run: ConsoleRun): string {
  switch (run.status) {
    case 'running':
      return t('console.running');
    case 'ok':
      return t('console.done', [run.durationMs]);
    case 'canceled':
      return t('console.canceled');
    case 'error':
      return t('console.failed', [run.durationMs]);
  }
}

// ── 执行计划树形缩进（D-13：表格 + 树形缩进，关闭遗留 #2）──────────────────

/** MySQL 表格式 EXPLAIN 判定：语句 EXPLAIN 开头 + 结果列含 id 与 Extra（经典 12 列形状） */
export function isExplainResultSet(sql: string, columns: Array<{ name: string }>): boolean {
  if (!/^\s*EXPLAIN\b/i.test(sql)) {
    return false;
  }
  const names = new Set(columns.map((c) => c.name));
  return names.has('id') && names.has('Extra');
}

/**
 * EXPLAIN 行的缩进级别：按 `id` 列 distinct 升序的序位推导嵌套深度
 * （MySQL 约定：id 越大嵌套越深；同 id 为同一 JOIN 行序列）。
 * id 缺失/非数值的行视为顶层。返回与 rows 等长的级别数组。
 */
export function explainIndentLevels(rows: unknown[][], columns: string[]): number[] {
  const idIdx = columns.indexOf('id');
  if (idIdx < 0) {
    return rows.map(() => 0);
  }
  const ids: number[] = [];
  const rowNums = rows.map((row) => {
    const n = Number(row[idIdx]);
    return Number.isFinite(n) ? n : null;
  });
  for (const n of rowNums) {
    if (n !== null && !ids.includes(n)) {
      ids.push(n);
    }
  }
  ids.sort((a, b) => a - b);
  return rowNums.map((n) => (n === null ? 0 : ids.indexOf(n)));
}

/** 缩进级别 → 首列树形前缀（等宽字形；0 级无前缀） */
export function explainIndentPrefix(level: number): string {
  return level <= 0 ? '' : `${'│ '.repeat(level - 1)}└─ `;
}
