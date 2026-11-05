import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DriverError, type DriverHost, type IConnection, type MetadataCache } from '@db-explorer/core';
import type { ColumnMeta } from '@db-explorer/core';
import type { ImportDoneEvent, ImportProgressEvent } from '@db-explorer/protocol';
import type { ConnectionManager } from './connectionManager';
import type { EditGuard } from './editGuard';
import { ImportTaskRunner, type ImportHostUi, type ImportTaskDeps } from './importTasks';
import { readXlsxSheet } from './xlsxReader';
import { writeXlsxFile } from './xlsxWriter';

/**
 * 数据导入任务引擎单测（§5.13 / ADR D-32）：
 * parse（试转换/映射建议/错行报告）、run 分批写入（applyChanges 复用）、失败批回滚已写批保留、
 * 取消、护栏（只读/prod 确认/映射校验）、P-37 终态清理时序。UI 全部走桩。
 */

const COLUMNS: ColumnMeta[] = [
  { name: 'id', dataType: 'int', normalizedType: 'integer', nullable: false, isPrimaryKey: true, autoIncrement: false, ordinal: 1 },
  { name: 'name', dataType: 'varchar', normalizedType: 'string', nullable: false, isPrimaryKey: false, autoIncrement: false, ordinal: 2 },
  { name: 'city', dataType: 'varchar', normalizedType: 'string', nullable: true, isPrimaryKey: false, autoIncrement: false, ordinal: 3 },
  { name: 'payload', dataType: 'json', normalizedType: 'json', nullable: true, isPrimaryKey: false, autoIncrement: false, ordinal: 4 },
];

interface Harness {
  runner: ImportTaskRunner;
  messages: Array<{ kind: 'info' | 'error'; message: string }>;
  progressEvents: ImportProgressEvent[];
  doneEvents: ImportDoneEvent[];
  logs: string[];
  timeline: string[];
  appliedChanges: Array<{ db: string; obj: string; inserts: Array<{ tempId: string; values: Record<string, unknown> }> }>;
  progressHandles: Array<{ onCancel: () => void; closed: boolean }>;
}

function makeHarness(opts: {
  columns?: ColumnMeta[];
  permission?: { enabled: boolean; reason?: string };
  confirmApply?: boolean;
  applyChanges?: (db: string, obj: string, inserts: unknown[]) => Promise<void>;
} = {}): Harness {
  const h: Harness = {
    runner: undefined as unknown as ImportTaskRunner,
    messages: [],
    progressEvents: [],
    doneEvents: [],
    logs: [],
    timeline: [],
    appliedChanges: [],
    progressHandles: [],
  };
  const ui: ImportHostUi = {
    pickImportFile: async () => undefined,
    showProgress: async (_title, onCancel) => {
      const handle = {
        onCancel,
        closed: false,
        close: () => {
          if (!handle.closed) {
            handle.closed = true;
            h.timeline.push('progress:close');
          }
        },
      };
      h.progressHandles.push(handle);
      return { close: () => handle.close() };
    },
    showMessage: async (kind, message) => {
      h.messages.push({ kind, message });
      h.timeline.push(`message:${kind}`);
      return undefined;
    },
  };
  const connections = {
    ensureConnected: async (): Promise<IConnection> => ({}) as IConnection,
  } as unknown as ConnectionManager;
  const cache = {
    getColumns: async () => opts.columns ?? COLUMNS,
  } as unknown as MetadataCache;
  const editGuard = {
    getPermission: async () => opts.permission ?? { enabled: true },
    confirmApply: async () => opts.confirmApply ?? true,
  } as unknown as EditGuard;
  const host = {
    applyChanges: async (_conn: unknown, db: string, obj: string, cs: { inserts: Array<{ tempId: string; values: Record<string, unknown> }> }) => {
      if (opts.applyChanges) {
        await opts.applyChanges(db, obj, cs.inserts);
      }
      h.appliedChanges.push({ db, obj, inserts: cs.inserts });
      return { items: [], executionMs: 1 };
    },
  } as unknown as DriverHost;
  const deps: ImportTaskDeps = {
    ui,
    events: {
      progress: (p) => h.progressEvents.push(p),
      done: (p) => h.doneEvents.push(p),
    },
    log: (line) => h.logs.push(line),
  };
  h.runner = new ImportTaskRunner(
    { connections, host, cache, editGuard, batchRows: 2, timeoutMs: 15_000 },
    deps,
  );
  return h;
}

const baseRun = {
  connId: 'c1',
  db: 'mydb',
  obj: 'users',
  format: 'csv' as const,
  mapping: [
    { fileColumn: 'id', tableColumn: 'id', type: 'integer' },
    { fileColumn: 'name', tableColumn: 'name', type: 'string' },
    { fileColumn: 'city', tableColumn: 'city', type: 'string' },
    { fileColumn: 'payload', tableColumn: 'payload', type: 'json' },
  ],
  emptyAsNull: true,
};

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbexp-import-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeCsv(name: string, content: string): string {
  const p = path.join(tmpDir, name);
  fs.writeFileSync(p, content, 'utf8');
  return p;
}

describe('ImportTaskRunner.parse', () => {
  it('解析 + 映射建议 + 试转换（错行报告不写入）', async () => {
    const file = writeCsv(
      'users.csv',
      'id,name,city,payload,extra\n1,alice,北京,"{""k"":1}",x\nabc,bob,,,\n2,carol,,,\n',
    );
    const h = makeHarness();
    const r = await h.runner.parse({ connId: 'c1', db: 'mydb', obj: 'users', file });
    expect(r.canceled).toBeUndefined();
    expect(r.fileName).toBe('users.csv');
    expect(r.format).toBe('csv');
    expect(r.fileColumns).toEqual(['id', 'name', 'city', 'payload', 'extra']);
    expect(r.tableColumns.map((c) => c.name)).toEqual(['id', 'name', 'city', 'payload']);
    // 映射建议：按名对齐；extra 无匹配 → null
    expect(r.mapping.find((m) => m.fileColumn === 'extra')?.tableColumn).toBeNull();
    expect(r.mapping.find((m) => m.fileColumn === 'id')?.tableColumn).toBe('id');
    // 第 2 行 id='abc' 类型不符 → 错行；其余 2 行有效
    expect(r.rowsTotal).toBe(3);
    expect(r.validRows).toBe(2);
    expect(r.skippedRows).toBe(1);
    expect(r.errorsTotal).toBe(1);
    expect(r.errors[0]).toMatchObject({ row: 2 });
    // 前 10 行预览 = 文件原值（CSV 全字符串，转换发生在写入侧）
    expect(r.preview).toHaveLength(3);
    expect(r.preview[0]).toEqual(['1', 'alice', '北京', '{"k":1}', 'x']);
  });

  it('文件选择取消：canceled 回执', async () => {
    const h = makeHarness();
    const r = await h.runner.parse({ connId: 'c1', db: 'mydb', obj: 'users' });
    expect(r.canceled).toBe(true);
  });

  it('行数超限：ImportRowCountError（E_VALIDATION）', async () => {
    const file = writeCsv('big.csv', 'id,name\n');
    // 构造 5 万 + 1 行（用重复行）
    fs.writeFileSync(file, 'id,name\n' + '1,a\n'.repeat(50_001), 'utf8');
    const h = makeHarness();
    await expect(h.runner.parse({ connId: 'c1', db: 'mydb', obj: 'users', file })).rejects.toMatchObject({
      code: 'E_VALIDATION',
    });
  });

  it('JSON 数组形态：null/对象保真', async () => {
    const file = path.join(tmpDir, 'users.json');
    fs.writeFileSync(
      file,
      JSON.stringify([
        { id: 1, name: 'a', city: null, payload: { k: [1, 2] } },
        { id: 2, name: 'b', city: 'x', payload: null },
      ]),
      'utf8',
    );
    const h = makeHarness();
    const r = await h.runner.parse({ connId: 'c1', db: 'mydb', obj: 'users', file });
    expect(r.format).toBe('json');
    expect(r.validRows).toBe(2);
    expect(r.preview[0]).toEqual([1, 'a', null, { k: [1, 2] }]);
  });
});

describe('ImportTaskRunner.run（分批写入复用 applyChanges）', () => {
  it('500 行/批配置下按 batchRows 分批；progress 逐批；done 汇总；P-37 时序', async () => {
    const file = writeCsv('users.csv', 'id,name,city,payload\n1,a,x,null\n2,b,,{"k":1}\n3,c,y,null\n4,d,,null\n5,e,z,null\n');
    const h = makeHarness();
    const ack = await h.runner.run({ ...baseRun, file, delimiter: ',' });
    expect(ack.importId).not.toBe('');
    await vi.waitFor(() => expect(h.doneEvents).toHaveLength(1));
    // 5 行 / 批 2 → 3 批
    expect(h.appliedChanges).toHaveLength(3);
    expect(h.appliedChanges.flatMap((c) => c.inserts).map((i) => i.values.id)).toEqual([1, 2, 3, 4, 5]);
    // 空字段（emptyAsNull=true）→ null；JSON 文本 → 解析对象
    expect(h.appliedChanges[1].inserts[0].values).toMatchObject({ id: 3, city: 'y', payload: null });
    expect(h.appliedChanges[1].inserts[1].values).toMatchObject({ id: 4, city: null, payload: null });
    expect(h.appliedChanges[0].inserts[1].values.payload).toEqual({ k: 1 });
    expect(h.progressEvents.map((p) => p.written)).toEqual([2, 4, 5]);
    expect(h.doneEvents[0]).toMatchObject({ status: 'ok', total: 5, written: 5, skipped: 0, failedRows: 0 });
    expect(h.doneEvents[0]).toMatchObject({ connId: 'c1', db: 'mydb', obj: 'users' });
    expect(h.messages).toEqual([{ kind: 'info', message: '已导入 5 行 → users（跳过 0 行）' }]);
    expect(h.timeline).toEqual(['progress:close', 'message:info']);
  });

  it('错行跳过写入：类型不符行不进入 ChangeSet', async () => {
    const file = writeCsv('users.csv', 'id,name,city,payload\nabc,a,x,null\n2,b,,null\n');
    const h = makeHarness();
    await h.runner.run({ ...baseRun, file });
    await vi.waitFor(() => expect(h.doneEvents).toHaveLength(1));
    expect(h.appliedChanges).toHaveLength(1);
    expect(h.appliedChanges[0].inserts).toHaveLength(1);
    expect(h.doneEvents[0]).toMatchObject({ status: 'ok', total: 1, written: 1, skipped: 1 });
    expect(h.doneEvents[0].errors?.[0]).toMatchObject({ row: 1 });
  });

  it('第 2 批失败：该批回滚（不重试）、已写批保留、失败即停', async () => {
    const file = writeCsv('users.csv', 'id,name,city,payload\n1,a,x,null\n2,b,,null\n3,c,y,null\n4,d,,null\n');
    const h = makeHarness({
      applyChanges: async (_db, _obj, inserts) => {
        if ((inserts as Array<{ values: { id: number } }>)[0].values.id === 3) {
          throw new DriverError('E_CONSTRAINT', 'duplicate key');
        }
      },
    });
    await h.runner.run({ ...baseRun, file });
    await vi.waitFor(() => expect(h.doneEvents).toHaveLength(1));
    // 第 1 批成功入记录；第 2 批尝试即抛（未入记录）；第 3 批不再发起（失败即停）
    expect(h.appliedChanges).toHaveLength(1);
    expect(h.doneEvents[0]).toMatchObject({ status: 'error', written: 2, failedRows: 2, total: 4 });
    expect(h.doneEvents[0].error).toEqual({ code: 'E_CONSTRAINT', message: 'duplicate key' });
    expect(h.doneEvents[0].errors?.some((e) => e.row === 3 && e.message.includes('duplicate key'))).toBe(true);
    expect(h.messages[0].kind).toBe('error');
    expect(h.timeline).toEqual(['progress:close', 'message:error']);
  });

  it('通知中心取消：批间取消位生效，已写批保留', async () => {
    const file = writeCsv(
      'users.csv',
      'id,name,city,payload\n' + Array.from({ length: 6 }, (_, i) => `${i + 1},n,,null`).join('\n') + '\n',
    );
    let calls = 0;
    let release!: () => void;
    const hangBatch2 = new Promise<void>((r) => {
      release = r;
    });
    const h = makeHarness({
      applyChanges: async () => {
        calls++;
        if (calls === 2) {
          await hangBatch2; // 第 2 批在途挂住，测试置位取消信号
        }
      },
    });
    await h.runner.run({ ...baseRun, file });
    await vi.waitFor(() => expect(calls).toBe(2));
    h.progressHandles[0]?.onCancel();
    release(); // 第 2 批完成落库（取消信号晚于该批提交）
    await vi.waitFor(() => expect(h.doneEvents).toHaveLength(1));
    expect(h.doneEvents[0].status).toBe('canceled');
    expect(h.doneEvents[0].written).toBe(4);
    expect(h.messages).toEqual([{ kind: 'info', message: '导入已取消：已写入 4 行' }]);
  });

  it('只读连接：E_READONLY（护栏 fail-closed，不调度）', async () => {
    const h = makeHarness({ permission: { enabled: false, reason: '只读' } });
    await expect(h.runner.run({ ...baseRun, file: path.join(tmpDir, 'x.csv') })).rejects.toMatchObject({
      code: 'E_READONLY',
    });
    expect(h.doneEvents).toHaveLength(0);
  });

  it('prod 确认取消：E_CANCELED，不调度', async () => {
    const h = makeHarness({ confirmApply: false });
    await expect(h.runner.run({ ...baseRun, file: path.join(tmpDir, 'x.csv') })).rejects.toMatchObject({
      code: 'E_CANCELED',
    });
    expect(h.doneEvents).toHaveLength(0);
  });

  it('映射校验：全部忽略 → E_VALIDATION；重复目标列 → E_VALIDATION', async () => {
    const h = makeHarness();
    const file = writeCsv('users.csv', 'id,name\n1,a\n');
    await expect(
      h.runner.run({ ...baseRun, file, mapping: [{ fileColumn: 'id', tableColumn: null, type: 'unknown' }] }),
    ).rejects.toMatchObject({ code: 'E_VALIDATION' });
    await expect(
      h.runner.run({
        ...baseRun,
        file,
        mapping: [
          { fileColumn: 'id', tableColumn: 'name', type: 'string' },
          { fileColumn: 'name', tableColumn: 'name', type: 'string' },
        ],
      }),
    ).rejects.toMatchObject({ code: 'E_VALIDATION' });
  });

  it('cancel 后终态再 cancel 同 id：不抛（幂等）', async () => {
    const file = writeCsv('users.csv', 'id,name,city,payload\n1,a,x,null\n');
    const h = makeHarness();
    const ack = await h.runner.run({ ...baseRun, file });
    await vi.waitFor(() => expect(h.doneEvents).toHaveLength(1));
    expect(() => h.runner.cancel({ importId: ack.importId })).not.toThrow();
  });
});

describe('xlsxReader（读侧 P-35 注记适用）', () => {
  it('写→读往返：表头/值矩阵/空值', async () => {
    const target = path.join(tmpDir, 'rt.xlsx');
    const batches: unknown[][][] = [
      [
        ['北京', 1, null, '{"k":1}'],
        ['上海', 2.5, true, ''],
      ],
    ];
    await writeXlsxFile(target, [{ name: 'city' }, { name: 'num' }, { name: 'flag' }, { name: 'payload' }], batches);
    const sheet = await readXlsxSheet(target, 100);
    expect(sheet.headers).toEqual(['city', 'num', 'flag', 'payload']);
    expect(sheet.rows).toHaveLength(2);
    expect(sheet.rows[0]).toEqual(['北京', 1, null, '{"k":1}']);
    // xlsx 空串单元格落为空 cell → 读回 null（与导出「NULL→空串」互逆，空 = NULL 语义自洽）
    expect(sheet.rows[1]).toEqual(['上海', 2.5, true, null]);
  });

  it('重名/空表头归一（normalizeHeaders 经核心纯函数）', async () => {
    const target = path.join(tmpDir, 'hdr.xlsx');
    await writeXlsxFile(target, [{ name: 'a' }, { name: 'a' }], [[['x', 'y']]]);
    const sheet = await readXlsxSheet(target, 10);
    expect(sheet.headers).toEqual(['a', 'a']);
    // 归一发生在 importTasks.readRecords（headers 归一后映射键唯一）
  });
});
