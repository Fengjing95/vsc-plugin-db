import { describe, expect, it } from 'vitest';
import type { ConsoleRun, ConsoleRunItem } from '@db-explorer/protocol';
import { deriveTabs, messageLines, oneLineSql, resultStatusLine, runStatusText } from './consoleView';

function resultSetItem(seq: number, sql: string, rowCount: number, executionMs = 10): ConsoleRunItem {
  return {
    seq,
    sql,
    executionMs,
    resultSet: {
      columns: [{ name: 'id', type: 'integer' }],
      rows: Array.from({ length: rowCount }, (_, i) => [i + 1]),
      rowCount,
      executionMs,
      truncated: false,
    },
  };
}

function messageItem(seq: number, sql: string, affectedRows: number, executionMs = 8): ConsoleRunItem {
  return { seq, sql, executionMs, affectedRows };
}

const run: ConsoleRun = {
  consoleId: 'c1',
  runId: 'r1',
  startedAt: 0,
  durationMs: 20,
  status: 'ok',
  items: [
    resultSetItem(1, 'SELECT * FROM users', 50),
    messageItem(2, 'UPDATE users SET a = 1 WHERE id = 1', 1),
    resultSetItem(3, 'SELECT * FROM orders', 30),
  ],
};

describe('deriveTabs（交互稿 §7.3：多结果集 Tab）', () => {
  it('SELECT 语句 → 结果 N；非 SELECT 进消息 Tab；消息 Tab 恒存在', () => {
    const tabs = deriveTabs(run);
    expect(tabs.map((t) => t.label)).toEqual(['结果 1', '结果 2', '消息']);
    expect(tabs[0].item?.seq).toBe(1);
    expect(tabs[1].item?.seq).toBe(3);
    expect(tabs[2].kind).toBe('message');
  });

  it('全部非 SELECT → 只有消息 Tab', () => {
    const msgRun: ConsoleRun = { ...run, items: [messageItem(1, 'UPDATE t SET a=1', 3), messageItem(2, 'DELETE FROM t WHERE id=1', 1)] };
    const tabs = deriveTabs(msgRun);
    expect(tabs).toHaveLength(1);
    expect(tabs[0].label).toBe('消息');
  });

  it('空运行 → 无 Tab', () => {
    expect(deriveTabs(null)).toEqual([]);
    expect(deriveTabs({ ...run, items: [] })).toHaveLength(1);
  });
});

describe('messageLines（消息 Tab 恒显示最后一条语句摘要）', () => {
  it('非 SELECT 语句逐条汇总（rows affected · ms）', () => {
    const lines = messageLines(run);
    expect(lines).toContain('[2] UPDATE users SET a = 1 WHERE id = 1');
    expect(lines).toContain('  → 1 rows affected · 8ms');
    expect(lines).toContain('最后一条语句：30 行 · 10ms');
  });

  it('错误语句带错误码摘要；取消状态显示已取消', () => {
    const errRun: ConsoleRun = {
      ...run,
      status: 'error',
      items: [messageItem(1, 'SELECT * FROM nope', 0), { seq: 1, sql: 'SELECT * FROM nope', executionMs: 3, error: { code: 'E_NOT_FOUND', message: '表不存在' } }],
    };
    const lines = messageLines(errRun);
    expect(lines.some((l) => l.includes('E_NOT_FOUND'))).toBe(true);
    expect(errRun.items.length).toBeGreaterThan(0);

    const canceled: ConsoleRun = { ...run, status: 'canceled', items: [] };
    expect(messageLines(canceled)).toContain('⊘ 已取消');
  });

  it('警告消息进消息 Tab', () => {
    const warnRun: ConsoleRun = {
      ...run,
      items: [{ seq: 1, sql: 'UPDATE t SET a=1', executionMs: 1, affectedRows: 0, messages: ['Notes: 行数不符'] }],
    };
    expect(messageLines(warnRun).some((l) => l.includes('⚠ Notes: 行数不符'))).toBe(true);
  });
});

describe('状态行', () => {
  it('resultStatusLine：SQL · 耗时 · 行数', () => {
    expect(resultStatusLine(resultItem(50, 12))).toBe('SELECT * FROM users · 12ms · 50 行');
  });

  it('oneLineSql 折叠空白并截断长语句', () => {
    expect(oneLineSql('SELECT\n  *\nFROM  t')).toBe('SELECT * FROM t');
    expect(oneLineSql('x'.repeat(100))).toHaveLength(61);
  });

  it('runStatusText 分档', () => {
    expect(runStatusText({ ...run, status: 'running' })).toBe('执行中…');
    expect(runStatusText({ ...run, status: 'ok', durationMs: 20 })).toBe('完成（20ms）');
    expect(runStatusText({ ...run, status: 'canceled' })).toBe('已取消');
    expect(runStatusText({ ...run, status: 'error' })).toContain('出错');
  });
});

function resultItem(rowCount: number, ms: number): ConsoleRunItem {
  return resultSetItem(1, 'SELECT * FROM users', rowCount, ms);
}
