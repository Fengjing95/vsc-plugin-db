import { describe, expect, it } from 'vitest';
import { COMPLETION_SNIPPETS, FUNCTIONS, KEYWORDS } from './completion';

/** C-14/驱动规范 §3.2：方言全量词表硬性项（关键字 > 50、函数 > 20 量级） */
describe('T-SQL 补全词表（M8-MSSQL）', () => {
  it('规模达标', () => {
    expect(KEYWORDS.length).toBeGreaterThan(50);
    expect(FUNCTIONS.length).toBeGreaterThan(20);
    expect(COMPLETION_SNIPPETS.length).toBeGreaterThan(0);
  });

  it('T-SQL 特有形状命中（区别于其他方言）', () => {
    for (const kw of ['SELECT', 'TOP', 'OFFSET', 'FETCH NEXT', 'MERGE', 'OUTPUT', 'IDENTITY(1,1)', 'PIVOT', 'TRY', 'CATCH', 'WAITFOR DELAY', 'NVARCHAR']) {
      expect(KEYWORDS).toContain(kw);
    }
    for (const fn of ['ISNULL', 'STRING_AGG', 'JSON_VALUE', 'IIF', 'DATEADD', 'ROW_NUMBER']) {
      expect(FUNCTIONS).toContain(fn);
    }
    // 非 T-SQL 形状不应混入（跨驱动复用词表 = 违反 C-14）
    expect(KEYWORDS).not.toContain('ON CONFLICT');
    expect(KEYWORDS).not.toContain('ON DUPLICATE KEY UPDATE');
    expect(KEYWORDS).not.toContain('INSERT IGNORE');
    expect(KEYWORDS).not.toContain('ILIKE');
    expect(KEYWORDS).not.toContain('AUTO_INCREMENT');
  });

  it('片段为 T-SQL 惯用模板（MERGE UPSERT 等）', () => {
    expect(COMPLETION_SNIPPETS.some((s) => /MERGE\s/.test(s.body))).toBe(true);
    expect(COMPLETION_SNIPPETS.every((s) => s.label && s.body)).toBe(true);
  });
});
