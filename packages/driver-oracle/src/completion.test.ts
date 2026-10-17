import { describe, expect, it } from 'vitest';
import { COMPLETION_SNIPPETS, DATA_TYPES, FUNCTIONS, KEYWORDS } from './completion';

/** 方言词表硬性要求（驱动规范 §3.2 / C-14：规模达标 + 表设计器类型词表） */
describe('completion 词表（C-14）', () => {
  it('关键字 > 50、函数 > 20、片段非空', () => {
    expect(KEYWORDS.length).toBeGreaterThan(50);
    expect(FUNCTIONS.length).toBeGreaterThan(20);
    expect(COMPLETION_SNIPPETS.length).toBeGreaterThan(3);
  });

  it('Oracle 方言特有形状命中（UPSERT=MERGE / 分层查询 / IDENTITY）', () => {
    const all = [...KEYWORDS, ...FUNCTIONS].map((s) => s.toUpperCase());
    expect(all).toContain('MERGE');
    expect(all).toContain('CONNECT BY');
    expect(all).toContain('NVL');
    expect(KEYWORDS.some((k) => k.includes('IDENTITY'))).toBe(true);
    expect(COMPLETION_SNIPPETS.some((s) => s.body.includes('MERGE INTO'))).toBe(true);
    expect(COMPLETION_SNIPPETS.some((s) => s.body.includes('OFFSET'))).toBe(true);
  });

  it('词表无重复项', () => {
    expect(new Set(KEYWORDS.map((k) => k.toUpperCase())).size).toBe(KEYWORDS.length);
    expect(new Set(FUNCTIONS.map((k) => k.toUpperCase())).size).toBe(FUNCTIONS.length);
  });

  it('DATA_TYPES（表设计器类型建议）：Oracle 原生类型、value/template 形状', () => {
    expect(DATA_TYPES.length).toBeGreaterThanOrEqual(15);
    const values = DATA_TYPES.map((t) => t.value);
    expect(values).toContain('VARCHAR2');
    expect(values).toContain('NUMBER');
    expect(values).toContain('CLOB');
    values.forEach((v) => expect(v).not.toMatch(/[";]/));
    for (const t of DATA_TYPES) {
      if (t.template) {
        expect(t.template.startsWith(t.value)).toBe(true);
      }
    }
  });
});
