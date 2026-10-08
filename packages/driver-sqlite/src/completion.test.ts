import { describe, expect, it } from 'vitest';
import { COMPLETION_SNIPPETS, FUNCTIONS, KEYWORDS } from './completion';

/** 方言词表单测（驱动规范 §3.2 验收：规模达标 + 方言特有形状命中；C-14）。 */

describe('SQLite 补全词表', () => {
  it('规模达标：关键字 > 50、函数 > 20、片段非空', () => {
    expect(KEYWORDS.length).toBeGreaterThan(50);
    expect(FUNCTIONS.length).toBeGreaterThan(20);
    expect(COMPLETION_SNIPPETS.length).toBeGreaterThan(0);
  });

  it('词表无重复项', () => {
    expect(new Set(KEYWORDS).size).toBe(KEYWORDS.length);
    expect(new Set(FUNCTIONS).size).toBe(FUNCTIONS.length);
  });

  it('方言特有形状命中：PRAGMA/ATTACH/UPSERT/RETURNING/WITHOUT ROWID/窗口/JSON1', () => {
    for (const kw of [
      'PRAGMA', 'PRAGMA TABLE_INFO', 'ATTACH DATABASE', 'ON CONFLICT', 'DO UPDATE', 'RETURNING',
      'WITHOUT ROWID', 'STRICT', 'AUTOINCREMENT', 'VACUUM', 'SAVEPOINT', 'RECURSIVE',
      'IS NOT NULL', 'GLOB',
    ]) {
      expect(KEYWORDS, kw).toContain(kw);
    }
    for (const fn of ['JSON_EXTRACT', 'STRFTIME', 'GROUP_CONCAT', 'ROW_NUMBER', 'IIF', 'UNIXEPOCH', 'INSTR']) {
      expect(FUNCTIONS, fn).toContain(fn);
    }
  });

  it('片段含 SQLite 惯用模板（UPSERT/PRAGMA table_info）', () => {
    const labels = COMPLETION_SNIPPETS.map((s) => s.label).join('\n');
    expect(labels).toContain('ON CONFLICT');
    expect(labels).toContain('PRAGMA table_info');
  });
});
