import { describe, expect, it } from 'vitest';
import type { ConsoleTabSource } from './consoleTabs';
import { deriveConsoleTabs, type ConsoleTabEnv } from './consoleTabs';

/**
 * 会话 Tab 推导单测（M8 #11）：收纳口径（绑定可达/有结果/执行中）、
 * 连接名回退、事务徽标来源（SessionManager 按连接）、排序稳定性。
 */

function src(overrides: Partial<ConsoleTabSource> & { consoleId: string }): ConsoleTabSource {
  return {
    connId: 'c1',
    db: null,
    running: false,
    hasRun: false,
    lastRunAt: null,
    ...overrides,
  };
}

function env(overrides: Partial<ConsoleTabEnv> = {}): ConsoleTabEnv {
  const labels: Record<string, string> = { c1: '本地 MySQL', c2: '生产库' };
  const addressable = new Set(['console-1', 'console-2']);
  const txn = new Set<string>();
  return {
    connLabelOf: (connId) => labels[connId],
    addressable: (consoleId) => addressable.has(consoleId),
    txnActive: (connId) => txn.has(connId),
    ...overrides,
  };
}

describe('deriveConsoleTabs（M8 会话 Tab）', () => {
  it('绑定可达的会话恒收纳，标签 = 连接名 · 库', () => {
    const tabs = deriveConsoleTabs(
      [src({ consoleId: 'console-1', connId: 'c1', db: 'myapp' })],
      env(),
    );
    expect(tabs).toEqual([
      {
        consoleId: 'console-1',
        connLabel: '本地 MySQL',
        db: 'myapp',
        running: false,
        txnActive: false,
        hasRun: false,
        lastRunAt: null,
      },
    ]);
  });

  it('绑定已失但有执行结果的会话保留（会话保持）；从未执行且绑定失的回收', () => {
    const tabs = deriveConsoleTabs(
      [
        src({ consoleId: 'gone-no-run', connId: 'c1' }), // 不可达 + 无结果 → 回收
        src({ consoleId: 'gone-ran', connId: 'c1', hasRun: true, lastRunAt: 42 }), // 不可达 + 有结果 → 保留
        src({ consoleId: 'gone-running', connId: 'c2', running: true }), // 不可达 + 执行中 → 保留
      ],
      env(),
    );
    expect(tabs.map((t) => t.consoleId)).toEqual(['gone-ran', 'gone-running']);
    expect(tabs[0].connLabel).toBe('本地 MySQL');
    expect(tabs[1].connLabel).toBe('生产库');
  });

  it('连接已删除时 connLabel 回退 connId', () => {
    const tabs = deriveConsoleTabs(
      [src({ consoleId: 'console-2', connId: 'deleted-conn', db: null })],
      env({ connLabelOf: () => undefined }),
    );
    expect(tabs[0].connLabel).toBe('deleted-conn');
  });

  it('事务徽标按连接取（同连接多会话都亮）', () => {
    const txn = new Set(['c1']);
    const tabs = deriveConsoleTabs(
      [src({ consoleId: 'console-1', connId: 'c1' }), src({ consoleId: 'console-2', connId: 'c1', db: 'other' })],
      env({ txnActive: (connId) => txn.has(connId) }),
    );
    expect(tabs.map((t) => t.txnActive)).toEqual([true, true]);
  });

  it('按会话创建顺序稳定排列（不做时间重排）', () => {
    const tabs = deriveConsoleTabs(
      [
        src({ consoleId: 'console-1', connId: 'c1', hasRun: true, lastRunAt: 100 }),
        src({ consoleId: 'console-2', connId: 'c2', hasRun: true, lastRunAt: 5 }),
      ],
      env(),
    );
    expect(tabs.map((t) => t.consoleId)).toEqual(['console-1', 'console-2']);
  });
});
