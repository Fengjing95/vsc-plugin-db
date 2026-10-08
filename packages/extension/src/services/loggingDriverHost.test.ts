import { describe, expect, it } from 'vitest';
import {
  DriverError,
  type ApplyResult,
  type ChangeSet,
  type DriverHost,
  type IConnection,
  type PreviewItem,
  type ResultSet,
} from '@db-explorer/core';
import type { Logger } from './logger';
import { LoggingDriverHost } from './loggingDriverHost';

/** 日志桩：按「级别 [tag] 消息」收集（Logger 的构造依赖 vscode.LogOutputChannel，测试不可用） */
function makeLogger() {
  const lines: string[] = [];
  const logger = {
    debug: (tag: string, msg: string) => lines.push(`debug [${tag}] ${msg}`),
    info: (tag: string, msg: string) => lines.push(`info [${tag}] ${msg}`),
    warn: (tag: string, msg: string) => lines.push(`warn [${tag}] ${msg}`),
    error: (tag: string, msg: string) => lines.push(`error [${tag}] ${msg}`),
    write: () => undefined,
    show: () => undefined,
  };
  return { logger: logger as unknown as Logger, lines };
}

const conn = {} as IConnection;

function rsOf(rowCount: number): ResultSet {
  return { columns: [], rows: [], rowCount, executionMs: 1 };
}

function makeInner(overrides: Partial<DriverHost> = {}): DriverHost {
  return {
    fetchRows: async () => rsOf(10),
    query: async () => [rsOf(3), rsOf(2)],
    previewChanges: async () => [{ sql: 'S' }] as PreviewItem[],
    applyChanges: async () =>
      ({
        items: [{ kind: 'insert', sql: 'I', affectedRows: 1 }],
        executionMs: 2,
      }) as ApplyResult,
    ...overrides,
  };
}

function makeHost(inner: DriverHost, connId?: string) {
  const { logger, lines } = makeLogger();
  const host = new LoggingDriverHost(inner, logger, () => connId);
  return { host, lines };
}

describe('LoggingDriverHost（§5.10 查询统一日志拦截）', () => {
  it('query 成功 → info：结果集数/行数/耗时 + SQL 摘要，返回值透传', async () => {
    const { host, lines } = makeHost(makeInner(), 'c1');
    const out = await host.query(conn, { sql: 'SELECT 1', maxRows: 10, timeoutMs: 1000 });
    expect(out).toHaveLength(2);
    const line = lines.find((l) => l.startsWith('info '));
    expect(line).toContain('[query]');
    expect(line).toContain('c1 执行完成：2 个结果集 / 5 行');
    expect(line).toContain('SELECT 1');
  });

  it('长 SQL 压平空白并截断到 120 字符（… 结尾）', async () => {
    const { host, lines } = makeHost(makeInner(), 'c1');
    await host.query(conn, { sql: `SELECT   ${'x'.repeat(300)}`, maxRows: 1, timeoutMs: 1000 });
    const line = lines.find((l) => l.startsWith('info '))!;
    expect(line).not.toContain('  '); // 空白已压平
    expect(line).toContain('…');
  });

  it('fetchRows 成功 → info：db.obj/offset/行数；connId 缺失退 unknown', async () => {
    const { host, lines } = makeHost(makeInner(), undefined);
    await host.fetchRows(conn, { db: 'demo', obj: 't1', limit: 100, offset: 20, timeoutMs: 1000 });
    const line = lines.find((l) => l.startsWith('info '))!;
    expect(line).toContain('unknown/demo.t1 取数：offset=20，10 行');
  });

  it('applyChanges 成功 → info：插/改/删计数 + 语句数', async () => {
    const cs = { inserts: [{}], updates: [{}, {}], deletes: [] } as unknown as ChangeSet;
    const { host, lines } = makeHost(makeInner(), 'c1');
    await host.applyChanges(conn, 'demo', 't1', cs, { timeoutMs: 1000 });
    const line = lines.find((l) => l.startsWith('info '))!;
    expect(line).toContain('c1/demo.t1 提交变更：插1/改2/删0 · 1 条语句');
  });

  it('previewChanges 成功 → debug（高频、非实际执行）', async () => {
    const cs = { inserts: [], updates: [], deletes: [] } as unknown as ChangeSet;
    const { host, lines } = makeHost(makeInner(), 'c1');
    await host.previewChanges(conn, 'demo', 't1', cs);
    expect(lines.some((l) => l.startsWith('debug ') && l.includes('预览变更：1 条语句'))).toBe(true);
    expect(lines.some((l) => l.startsWith('info '))).toBe(false);
  });

  it('失败 → error 携 DriverError code，异常原样透传', async () => {
    const { host, lines } = makeHost(
      makeInner({ query: async () => Promise.reject(new DriverError('E_TIMEOUT', '超时')) }),
      'c1',
    );
    await expect(host.query(conn, { sql: 'SELECT 1', maxRows: 1, timeoutMs: 1 })).rejects.toMatchObject({
      code: 'E_TIMEOUT',
    });
    const line = lines.find((l) => l.startsWith('error '))!;
    expect(line).toContain('[query]');
    expect(line).toContain('失败：E_TIMEOUT 超时');
    expect(line).toContain('SELECT 1');
  });

  it('E_CANCELED → info（主动取消非故障），不打 error', async () => {
    const { host, lines } = makeHost(
      makeInner({ fetchRows: async () => Promise.reject(new DriverError('E_CANCELED', '已取消')) }),
      'c1',
    );
    await expect(host.fetchRows(conn, { db: 'd', obj: 't', limit: 1, timeoutMs: 1 })).rejects.toMatchObject({
      code: 'E_CANCELED',
    });
    expect(lines.some((l) => l.startsWith('info ') && l.includes('取数 已取消'))).toBe(true);
    expect(lines.some((l) => l.startsWith('error '))).toBe(false);
  });
});
