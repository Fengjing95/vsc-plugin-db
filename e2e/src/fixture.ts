import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPO_ROOT } from './paths';

/** sql.js 引擎的最小类型面（仅 fixture 生成所需）。注意 initSqlJs() 解析为 { Database: class }，
 * Database 实例还要 new 出来——与 driver-sqlite engine.ts 同一口径 */
interface SqlJsDatabase {
  run(sql: string): void;
  export(): Uint8Array;
}

/**
 * sqlite fixture（旅程数据源）：经 driver-sqlite 的依赖图解析 sql.js——与扩展运行时的
 * 引擎版本/wasm 二进制同源（esbuild.mjs 同款 createRequire 手法），避免 e2e 侧再引一份产生漂移。
 */
async function loadSqlJs(): Promise<{ new (): SqlJsDatabase }> {
  const req = createRequire(join(REPO_ROOT, 'packages', 'driver-sqlite', 'package.json'));
  const initSqlJs = req('sql.js') as (cfg: { wasmBinary: Buffer }) => Promise<{ Database: { new (): SqlJsDatabase } }>;
  const wasmPath = req.resolve('sql.js/dist/sql-wasm.wasm');
  const sqljs = await initSqlJs({ wasmBinary: readFileSync(wasmPath) });
  return sqljs.Database;
}

export interface FixtureRow {
  id: number;
  name: string;
  city: string | null;
  payload: Record<string, unknown> | null;
  createdAt: string;
}

/** 行数据：覆盖 C-7 基础面——非空文本 / NULL / JSON；值含 e2e 前缀便于网格断言 */
export const FIXTURE_ROWS: FixtureRow[] = [
  { id: 1, name: 'e2e-alice', city: 'hangzhou', payload: { role: 'admin', level: 3 }, createdAt: '2026-01-01 00:00:00.000' },
  { id: 2, name: 'e2e-bob', city: 'shanghai', payload: { role: 'user' }, createdAt: '2026-01-02 00:00:00.000' },
  { id: 3, name: 'e2e-carol', city: null, payload: { role: 'user', tags: ['a', 'b'] }, createdAt: '2026-01-03 00:00:00.000' },
  { id: 4, name: 'e2e-dave', city: 'beijing', payload: null, createdAt: '2026-01-04 00:00:00.000' },
  { id: 5, name: 'e2e-eve', city: 'shenzhen', payload: { role: 'guest' }, createdAt: '2026-01-05 00:00:00.000' },
  { id: 6, name: 'e2e-frank', city: null, payload: null, createdAt: '2026-01-06 00:00:00.000' },
];

export interface Fixture {
  /** .db 文件绝对路径（连接表单 path 字段值） */
  dbPath: string;
  /** 作为 VSCode 打开的工作区目录（含 .db 文件） */
  workspaceDir: string;
  /** 旅程② SQL 文档（J2：SELECT 正常执行 / UPDATE 无 WHERE 触发危险横幅） */
  selectSqlUri: string;
  updateSqlUri: string;
}

const CREATE_TABLE =
  'CREATE TABLE dbkit_e2e (id INTEGER PRIMARY KEY, name TEXT NOT NULL, city TEXT, payload TEXT, created_at TEXT)';

const SELECT_SQL = 'SELECT id, name, city FROM dbkit_e2e ORDER BY id;\n';
/** 无 WHERE 的 UPDATE：sqlDanger 判定危险 → Console 横幅（J2 拦截语义） */
const UPDATE_NO_WHERE_SQL = "UPDATE dbkit_e2e SET city = 'e2e-banner-x';\n";

export async function createFixture(runDir: string): Promise<Fixture> {
  const workspaceDir = join(runDir, 'workspace');
  mkdirSync(workspaceDir, { recursive: true });
  const dbPath = join(workspaceDir, 'e2e.db');
  const selectSqlPath = join(workspaceDir, 'j2-select.sql');
  const updateSqlPath = join(workspaceDir, 'j2-update.sql');
  writeFileSync(selectSqlPath, SELECT_SQL);
  writeFileSync(updateSqlPath, UPDATE_NO_WHERE_SQL);

  const Database = await loadSqlJs();
  const db = new Database();
  db.run(CREATE_TABLE);
  for (const r of FIXTURE_ROWS) {
    const payload = r.payload === null ? 'NULL' : `'${JSON.stringify(r.payload).replace(/'/g, "''")}'`;
    const city = r.city === null ? 'NULL' : `'${r.city}'`;
    db.run(
      `INSERT INTO dbkit_e2e (id, name, city, payload, created_at) VALUES (${r.id}, '${r.name}', ${city}, ${payload}, '${r.createdAt}')`,
    );
  }
  writeFileSync(dbPath, Buffer.from(db.export()));
  return {
    dbPath,
    workspaceDir,
    selectSqlUri: pathToFileURL(selectSqlPath).toString(),
    updateSqlUri: pathToFileURL(updateSqlPath).toString(),
  };
}
