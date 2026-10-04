import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DriverError, type DriverHost, type ResultSet } from '@db-explorer/core';
import type { ExportDoneEvent, ExportProgressEvent } from '@db-explorer/protocol';
import type { ConnectionManager } from './connectionManager';
import { ExportTaskRunner, type ExportHostUi, type ExportTaskDeps } from './exportTasks';

/**
 * 导出任务引擎单测（M8 后台化 §5.7/#16）：
 * 调度即回执（run 不等待流结束）、终态三路回执、通知中心取消、失败 Toast、多任务并发。
 * UI 全部走桩（ExportHostUi），fetchRows 用 gate 手动放行控制时序。
 */

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** 手动放行的单批 host：首调返回 gate（挂起），后续批次按脚本出队 */
function gatedHost(gate: Promise<ResultSet>, rest: ResultSet[]): { host: DriverHost } {
  let call = 0;
  return {
    host: {
      fetchRows: () => {
        call++;
        return call === 1 ? gate : Promise.resolve(rest.length > 0 ? (rest.shift() as ResultSet) : page([]));
      },
    } as unknown as DriverHost,
  };
}

function page(rows: unknown[][]): ResultSet {
  return {
    columns: [
      { name: 'id', type: 'integer' },
      { name: 'name', type: 'string' },
    ],
    rows,
    rowCount: rows.length,
    executionMs: 1,
  };
}

interface Harness {
  runner: ExportTaskRunner;
  /** null = 保存对话框被用户取消 */
  target: string | null;
  progressHandles: Array<{ onCancel: () => void; closed: boolean }>;
  messages: Array<{ kind: 'info' | 'error'; message: string; action?: string }>;
  revealed: string[];
  progressEvents: ExportProgressEvent[];
  doneEvents: ExportDoneEvent[];
  logs: string[];
}

function makeHarness(opts: { target?: string | null; host?: DriverHost } = {}): Harness {
  const h: Harness = {
    target: opts.target === undefined ? path.join(tmpDir, 'out.csv') : opts.target,
    runner: undefined as unknown as ExportTaskRunner,
    progressHandles: [],
    messages: [],
    revealed: [],
    progressEvents: [],
    doneEvents: [],
    logs: [],
  };
  const ui: ExportHostUi = {
    pickTargetFile: async () => (h.target === null ? undefined : h.target),
    showProgress: async (_title, onCancel) => {
      const handle = { onCancel, closed: false };
      h.progressHandles.push(handle);
      return {
        close: () => {
          handle.closed = true;
        },
      };
    },
    showMessage: async (kind, message, action) => {
      h.messages.push({ kind, message, action });
      return action;
    },
    revealFile: (filePath) => h.revealed.push(filePath),
  };
  const deps: ExportTaskDeps = {
    ui,
    events: {
      progress: (p) => h.progressEvents.push(p),
      done: (p) => h.doneEvents.push(p),
    },
    log: (line) => h.logs.push(line),
  };
  h.runner = new ExportTaskRunner(
    {
      connections: { ensureConnected: async () => ({}) } as unknown as ConnectionManager,
      host: opts.host ?? ({} as DriverHost),
      chunkRows: 2,
      timeoutMs: 15_000,
    },
    deps,
  );
  return h;
}

const baseParams = { connId: 'c1', db: 'mydb', obj: 'users', format: 'csv', scope: 'result' } as const;

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbexp-export-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('ExportTaskRunner（M8 导出后台化）', () => {
  it('run() 调度即回执 exportId，不等待取数流结束', async () => {
    const gate = deferred<ResultSet>();
    const { host } = gatedHost(gate.promise, []);
    const h = makeHarness({ host });

    const ack = await h.runner.run({ ...baseParams });
    expect(ack.exportId).not.toBe('');
    expect(ack.canceled).toBeUndefined();
    expect(h.doneEvents).toHaveLength(0); // 流未结束，终态未发

    gate.resolve(page([[1, 'a']]));
    await vi.waitFor(() => expect(h.doneEvents).toHaveLength(1));
    expect(h.doneEvents[0]).toMatchObject({ exportId: ack.exportId, rows: 1 });
    expect(h.doneEvents[0].error).toBeUndefined();
    expect(h.messages).toEqual([{ kind: 'info', message: '已导出 1 行 → out.csv', action: '定位文件' }]);
    expect(h.progressHandles[0].closed).toBe(true);
  });

  it('定位文件动作触发 revealFile', async () => {
    const gate = deferred<ResultSet>();
    const { host } = gatedHost(gate.promise, []);
    const h = makeHarness({ host });
    const ack = await h.runner.run({ ...baseParams });
    gate.resolve(page([[1, 'a']]));
    await vi.waitFor(() => expect(h.messages).toHaveLength(1));
    // showMessage 桩原样返回 action → 引擎应触发定位
    expect(h.revealed).toEqual([h.target]);
    expect(ack.exportId).not.toBe('');
  });

  it('保存对话框取消：回执 canceled 且不起任务（无进度/无事件）', async () => {
    const h = makeHarness({ target: null });
    const ack = await h.runner.run({ ...baseParams });
    expect(ack).toEqual({ exportId: '', canceled: true });
    expect(h.progressHandles).toHaveLength(0);
    expect(h.doneEvents).toHaveLength(0);
  });

  it('多批取数：progress 逐批上报（行数递增），done 汇总总行数', async () => {
    const gate = deferred<ResultSet>();
    const { host } = gatedHost(gate.promise, [page([[3, 'c']])]);
    const h = makeHarness({ host });

    const ack = await h.runner.run({ ...baseParams });
    gate.resolve(page([[1, 'a'], [2, 'b']]));
    await vi.waitFor(() => expect(h.doneEvents).toHaveLength(1));
    expect(h.progressEvents.map((p) => p.rows)).toEqual([2, 3]);
    expect(h.doneEvents[0].rows).toBe(3);
    expect(h.progressEvents.every((p) => p.exportId === ack.exportId)).toBe(true);
    const content = await fs.promises.readFile(h.target as string, 'utf8');
    expect(content).toContain('id,name');
    expect(content).toContain('3,c');
  });

  it('通知中心取消（onCancel）：done 回执 canceled、无成功 Toast、进度关闭', async () => {
    const gate = deferred<ResultSet>();
    const { host } = gatedHost(gate.promise, []);
    const h = makeHarness({ host });

    const ack = await h.runner.run({ ...baseParams });
    await vi.waitFor(() => expect(h.progressHandles).toHaveLength(1));
    h.progressHandles[0].onCancel(); // 用户点击通知上的取消
    // 在途批次放行满页 → 下一轮循环顶检查 signal → E_CANCELED 路径
    gate.resolve(page([[1, 'a'], [2, 'b']]));
    await vi.waitFor(() => expect(h.doneEvents).toHaveLength(1));
    expect(h.doneEvents[0]).toMatchObject({ exportId: ack.exportId, canceled: true });
    expect(h.doneEvents[0].error).toBeUndefined();
    expect(h.messages).toHaveLength(0); // 取消静默（仅日志）
    expect(h.logs.some((l) => l.includes('已取消'))).toBe(true);
    expect(h.progressHandles[0].closed).toBe(true);
    // 终态后再次 cancel 同 id：无任务可取消，不抛
    expect(() => h.runner.cancel({ exportId: ack.exportId })).not.toThrow();
  });

  it('取数失败：done 携带结构化错误 + error Toast，进度关闭', async () => {
    const host = {
      fetchRows: () => Promise.reject(new DriverError('E_CONN', '无法连接')),
    } as unknown as DriverHost;
    const h = makeHarness({ host });

    await h.runner.run({ ...baseParams });
    await vi.waitFor(() => expect(h.doneEvents).toHaveLength(1));
    expect(h.doneEvents[0].error).toEqual({ code: 'E_CONN', message: '无法连接' });
    expect(h.doneEvents[0].canceled).toBeUndefined();
    expect(h.messages).toEqual([{ kind: 'error', message: '导出失败：无法连接' }]);
    expect(h.progressHandles[0].closed).toBe(true);
  });

  it('export.cancel 中止在途任务（终态 canceled）', async () => {
    const gate = deferred<ResultSet>();
    const { host } = gatedHost(gate.promise, []);
    const h = makeHarness({ host });

    const ack = await h.runner.run({ ...baseParams });
    await vi.waitFor(() => expect(h.progressHandles).toHaveLength(1));
    h.runner.cancel({ exportId: ack.exportId });
    gate.resolve(page([[1, 'a'], [2, 'b']]));
    await vi.waitFor(() => expect(h.doneEvents).toHaveLength(1));
    expect(h.doneEvents[0].canceled).toBe(true);
  });

  it('多任务并发：各自独立取数与终态回执，互不干扰', async () => {
    const g1 = deferred<ResultSet>();
    const g2 = deferred<ResultSet>();
    let calls = 0;
    const host = {
      fetchRows: () => {
        calls++;
        return calls === 1 ? g1.promise : calls === 2 ? g2.promise : page([]);
      },
    } as unknown as DriverHost;
    const h = makeHarness({ host });

    const ack1 = await h.runner.run({ ...baseParams });
    const ack2 = await h.runner.run({ ...baseParams, obj: 'orders', format: 'json' });
    expect(ack1.exportId).not.toBe(ack2.exportId);
    g2.resolve(page([[2, 'b']])); // 任务 2 先完成
    await vi.waitFor(() => expect(h.doneEvents).toHaveLength(1));
    expect(h.doneEvents[0].exportId).toBe(ack2.exportId);
    g1.resolve(page([[1, 'a']]));
    await vi.waitFor(() => expect(h.doneEvents).toHaveLength(2));
    expect(h.doneEvents.map((d) => d.exportId)).toContain(ack1.exportId);
  });
});
