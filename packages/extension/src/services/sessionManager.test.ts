import { describe, expect, it, vi } from 'vitest';
import { DriverError, type ISession, type QueryRequest } from '@db-explorer/core';
import { SessionManager, type SessionHost } from './sessionManager';

/** 可控的假 ISession：记录调用，commit/rollback 可配置失败 */
function fakeSession() {
  const calls: string[] = [];
  const session: ISession = {
    execute: async (req: QueryRequest) => {
      calls.push(`execute:${req.sql}`);
      return [{ columns: [], rows: [], rowCount: 0, executionMs: 1 }];
    },
    commit: async () => {
      calls.push('commit');
    },
    rollback: async () => {
      calls.push('rollback');
    },
    dispose: async () => {
      calls.push('dispose');
    },
  };
  return { session, calls };
}

/** 会话宿主桩：openSession 可选，模拟能力缺失 */
function fakeHost(opts: { withSession?: boolean } = {}): SessionHost & { opened: number } {
  const state = { opened: 0 };
  return {
    opened: state.opened,
    ensureConnected: async () => {
      state.opened++;
      if (opts.withSession === false) {
        return {};
      }
      return {
        openSession: async () => {
          const s = fakeSession();
          openedSessions.push(s);
          return s.session;
        },
      };
    },
  };
}

const openedSessions: Array<ReturnType<typeof fakeSession>> = [];

function makeManager(host: SessionHost, idleTimeoutMs = 60_000) {
  const notifications: string[] = [];
  const manager = new SessionManager(host, () => idleTimeoutMs, (msg) => notifications.push(msg));
  return { manager, notifications };
}

describe('SessionManager（§4.6 / D-09）', () => {
  it('begin → execute → commit：语句走会话并结束', async () => {
    const host = fakeHost();
    const { manager } = makeManager(host);
    await manager.begin('c1');
    expect(manager.hasActive('c1')).toBe(true);
    await manager.execute('c1', { sql: 'UPDATE t SET x=1', maxRows: 10, timeoutMs: 1000 });
    await manager.commit('c1');
    expect(manager.hasActive('c1')).toBe(false);
    expect(openedSessions.at(-1)!.calls).toEqual(['execute:UPDATE t SET x=1', 'commit', 'dispose']);
  });

  it('单连接重复 begin 拒绝；commit/rollback 后可重新开启', async () => {
    const host = fakeHost();
    const { manager } = makeManager(host);
    await manager.begin('c1');
    await expect(manager.begin('c1')).rejects.toMatchObject({ code: 'E_VALIDATION' });
    await manager.rollback('c1');
    expect(manager.hasActive('c1')).toBe(false);
    await manager.begin('c1');
    expect(manager.hasActive('c1')).toBe(true);
  });

  it('驱动不支持 openSession → E_UNSUPPORTED', async () => {
    const host = fakeHost({ withSession: false });
    const { manager } = makeManager(host);
    await expect(manager.begin('c1')).rejects.toMatchObject({ code: 'E_UNSUPPORTED' });
    expect(manager.hasActive('c1')).toBe(false);
  });

  it('无会话时 commit/rollback/execute → E_VALIDATION', async () => {
    const { manager } = makeManager(fakeHost());
    await expect(manager.commit('c1')).rejects.toMatchObject({ code: 'E_VALIDATION' });
    await expect(manager.rollback('c1')).rejects.toMatchObject({ code: 'E_VALIDATION' });
    await expect(manager.execute('c1', { sql: 'SELECT 1', maxRows: 1, timeoutMs: 1 })).rejects.toMatchObject({
      code: 'E_VALIDATION',
    });
  });

  it('空闲超时自动 ROLLBACK + 通知 + onDidChange', async () => {
    vi.useFakeTimers();
    try {
      const host = fakeHost();
      const { manager, notifications } = makeManager(host, 50);
      const changes = vi.fn();
      manager.onDidChange(changes);
      await manager.begin('c1');
      expect(changes).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(80);
      expect(manager.hasActive('c1')).toBe(false);
      expect(openedSessions.at(-1)!.calls).toContain('rollback');
      expect(openedSessions.at(-1)!.calls).toContain('dispose');
      expect(notifications.some((m) => m.includes('自动回滚'))).toBe(true);
      expect(changes).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('会话内语句刷新空闲计时（不超时）', async () => {
    vi.useFakeTimers();
    try {
      const host = fakeHost();
      const { manager } = makeManager(host, 50);
      await manager.begin('c1');
      for (let i = 0; i < 4; i++) {
        await vi.advanceTimersByTimeAsync(30);
        await manager.execute('c1', { sql: `SELECT ${i}`, maxRows: 1, timeoutMs: 10 });
      }
      expect(manager.hasActive('c1')).toBe(true);
      await vi.advanceTimersByTimeAsync(80);
      expect(manager.hasActive('c1')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('dispose 全部回滚（不提交悬挂事务）', async () => {
    const host = fakeHost();
    const { manager } = makeManager(host);
    await manager.begin('c1');
    await manager.begin('c2');
    manager.dispose();
    expect(manager.hasActive('c1')).toBe(false);
    expect(manager.hasActive('c2')).toBe(false);
    const rolls = openedSessions.filter((s) => s.calls.includes('rollback'));
    expect(rolls.length).toBeGreaterThanOrEqual(2);
  });

  it('DriverError.is 兼容：错误码可被 UI 路由', async () => {
    const { manager } = makeManager(fakeHost());
    const err = await manager.commit('nope').catch((e: unknown) => e);
    expect(DriverError.is(err)).toBe(true);
  });
});
