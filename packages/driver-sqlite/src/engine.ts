import { openSync, readSync, closeSync, statSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { DriverError } from '@db-explorer/core';
import { toDriverError } from './errors';

/**
 * sql.js 引擎层（D-16 单引擎）：连接 = 整库字节映像载入内存的 sql.js Database。
 * 同步执行；持久化由连接层在每个写批次后经 exportBytes() 原子落盘（temp + rename）。
 * 本模块只管：路径展开/文件校验（防「<100 字节当空库」语义误覆写）+ wasm 初始化 + 语句执行封装。
 */

export type SqliteEngineKind = 'sqljs';

export interface EngineQueryResult {
  /** 结果列名（SELECT/RETURNING 语句；写语句为空数组） */
  columns: string[];
  /** 行式结果（INTEGER 经 BigInt 通道：值按 C-7 整形；BLOB → Uint8Array） */
  rows: unknown[][];
  /** 最近一条写语句影响的行数（SELECT 恒 0） */
  changes: number;
}

export interface SqliteEngine {
  readonly kind: SqliteEngineKind;
  /** 单语句执行（? 匿名参数）；SELECT/PRAGMA 返回行集，写语句返回 changes */
  query(sql: string, params?: unknown[]): EngineQueryResult;
  /** 多语句脚本（DDL/PRAGMA 脚本，无参数） */
  exec(sql: string): void;
  /** 整库字节映像（落盘用） */
  exportBytes(): Uint8Array;
  close(): void;
}

export interface EngineOpenOptions {
  readOnly?: boolean;
  /** sql-wasm.wasm 路径（extension 从 media/ 传入；缺省经 require.resolve 解析——仅测试/脚本场景可达） */
  wasmPath?: string;
}

const SQLITE_MAGIC = 'SQLite format 3\0';

/** 路径展开：~/ → 主目录；相对路径按调用方注入的 resolver（extension 注入工作区根；缺省按 cwd） */
export function resolveDbPath(raw: string, resolver?: (p: string) => string): string {
  const trimmed = raw.trim();
  const expanded = expandTilde(trimmed);
  const resolved = resolver ? resolver(expanded) : (isAbsolute(expanded) ? expanded : resolve(expanded));
  return resolved;
}

function expandTilde(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return join(homedir(), p.slice(2));
  return p;
}

/**
 * 打开前文件校验（§5.4）：必须已存在（E_NOT_FOUND，不自动创建）；非空文件必须带 SQLite 魔数
 * （E_VALIDATION）——SQLite 引擎会把 <100 字节的任意文件当空库，校验防误覆写用户文件；0 字节 = 合法新库。
 */
export function validateSqliteFile(path: string): void {
  let stat;
  try {
    stat = statSync(path);
  } catch {
    throw new DriverError('E_NOT_FOUND', `数据库文件不存在（不自动创建）：${path}`);
  }
  if (!stat.isFile()) {
    throw new DriverError('E_VALIDATION', `路径不是文件：${path}`);
  }
  if (stat.size === 0) {
    return; // 空文件 = SQLite 合法新库
  }
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const head = Buffer.alloc(16);
    const read = readSync(fd, head, 0, 16, 0);
    if (read < 16 || head.toString('binary') !== SQLITE_MAGIC) {
      throw new DriverError('E_VALIDATION', '不是有效的 SQLite 数据库文件');
    }
  } finally {
    if (fd !== undefined) {
      closeSync(fd);
    }
  }
}

// ── sql.js 加载（wasm 一次性初始化；进程内缓存） ─────────────────────────────

type SqlJsDatabase = {
  run(sql: string, params?: unknown[]): void;
  exec(sql: string): unknown;
  prepare(sql: string): SqlJsStatement;
  export(): Uint8Array;
  close(): void;
  getRowsModified(): number;
};

type SqlJsStatement = {
  bind(params: unknown[]): void;
  step(): boolean;
  /** 注意 sql.js 双参签名：get(params, config)——首参为绑定值（已 bind 过传 undefined），次参才是读取配置 */
  get(params?: unknown, config?: { useBigInt?: boolean }): unknown[];
  getColumnNames(): string[];
  free(): void;
};

type SqlJsFactory = (config?: { locateFile?: (file: string) => string }) => Promise<{
  Database: { new (data?: Uint8Array): SqlJsDatabase };
}>;

let sqlJsPromise: Promise<{ Database: { new (data?: Uint8Array): SqlJsDatabase } }> | undefined;

function loadSqlJs(wasmPath?: string): Promise<{ Database: { new (data?: Uint8Array): SqlJsDatabase } }> {
  sqlJsPromise ??= (async () => {
    // ESM-CJS 互操作：vite/vitest 命名空间下工厂在 default 上，CJS/打包产物下模块本体即函数
    const mod = (await import('sql.js')) as unknown as { default?: SqlJsFactory } | SqlJsFactory;
    const initSqlJs = typeof mod === 'function' ? mod : mod.default;
    if (typeof initSqlJs !== 'function') {
      throw new DriverError('E_INTERNAL', 'sql.js 加载失败：模块不含可调用的 initSqlJs 工厂');
    }
    try {
      return await initSqlJs(wasmPath ? { locateFile: () => wasmPath } : undefined);
    } catch (err) {
      throw toDriverError(err);
    }
  })();
  return sqlJsPromise;
}

/** 缺省 wasm 定位（extension 恒显式传入 media 路径；此兜底供测试/脚本场景） */
export function defaultWasmPath(): string | undefined {
  try {
    const base = join(process.cwd(), 'index.js');
    return createRequire(base).resolve('sql.js/dist/sql-wasm.wasm');
  } catch {
    return undefined;
  }
}

export async function openEngine(dbPath: string, opts: EngineOpenOptions): Promise<SqliteEngine> {
  validateSqliteFile(dbPath);
  const wasmPath = opts.wasmPath ?? defaultWasmPath();
  if (!wasmPath) {
    // 打包产物内 require.resolve 不可用且未显式传入路径——明确报错而非让 emscripten 去 CWD 找（错误信息迷惑）
    throw new DriverError('E_INTERNAL', 'sql.js wasm 资产缺失：未传入 wasmPath 且默认解析失败（应为 media/sql-wasm.wasm）');
  }
  const sqljs = await loadSqlJs(wasmPath);
  let db: SqlJsDatabase;
  try {
    db = new sqljs.Database(readFileSyncOrNull(dbPath));
  } catch (err) {
    throw toDriverError(err);
  }
  return new SqljsEngine(db);
}

function readFileSyncOrNull(path: string): Uint8Array | undefined {
  // 0 字节文件 → undefined（sql.js 视为全新空库；非空文件已经过魔数校验）
  return statSync(path).size === 0 ? undefined : readFileSync(path);
}

class SqljsEngine implements SqliteEngine {
  readonly kind: SqliteEngineKind = 'sqljs' as const;

  constructor(private readonly db: SqlJsDatabase) {}

  query(sql: string, params?: unknown[]): EngineQueryResult {
    const stmt = this.db.prepare(sql);
    try {
      if (params && params.length > 0) {
        stmt.bind(params.map(normalizeBindParam));
      }
      const rows: unknown[][] = [];
      while (stmt.step()) {
        // useBigInt：INTEGER 列走 BigInt 通道（64bit 精确），由 encodeCell 按 C-7 整形
        rows.push(stmt.get(undefined, { useBigInt: true }));
      }
      const columns = stmt.getColumnNames();
      const changes = rows.length === 0 ? this.db.getRowsModified() : 0;
      return { columns, rows, changes };
    } finally {
      stmt.free();
    }
  }

  exec(sql: string): void {
    try {
      this.db.exec(sql);
    } catch (err) {
      throw toDriverError(err);
    }
  }

  exportBytes(): Uint8Array {
    return this.db.export();
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      // 幂等 close（sql.js 对已关闭库再 close 会抛错，吞掉）
    }
  }
}

/** sql.js 绑定值归一：BigInt → 字符串（列 affinity 转换）；其余（null/number/string/Uint8Array）透传 */
function normalizeBindParam(v: unknown): unknown {
  if (typeof v === 'bigint') {
    return v.toString();
  }
  return v;
}
