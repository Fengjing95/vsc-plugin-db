import { describe, expect, it } from 'vitest';
import type { CompletionSource } from '../model/rows';
import {
  BASE_FUNCTIONS,
  BASE_KEYWORDS,
  GENERIC_SNIPPETS,
  buildCompletionDescriptors,
  resolveCompletionContext,
} from './completionContext';

const source: CompletionSource = {
  keywords: ['SELECT', 'FROM', 'WHERE'],
  functions: ['COUNT', 'NOW'],
  databases: ['demo', 'analytics'],
  tables: [
    { name: 'users', comment: '用户表' },
    { name: 'orders' },
  ],
  columns: [
    { table: 'users', name: 'id' },
    { table: 'users', name: 'email' },
    { table: 'orders', name: 'id' },
    { table: 'orders', name: 'amount' },
  ],
};

describe('resolveCompletionContext（概要 5.5.3 上下文规则）', () => {
  it('FROM/JOIN 后 → 表名', () => {
    expect(resolveCompletionContext('SELECT * FROM ', 15)).toEqual({ kind: 'table' });
    expect(resolveCompletionContext('SELECT * FROM users u JOIN ', 27)).toEqual({ kind: 'table' });
  });

  it('SELECT/WHERE 后 → 列名，且定位当前语句的 FROM 表', () => {
    // FROM 在光标之后（SELECT 列表中间）
    expect(resolveCompletionContext('SELECT * FROM users', 8)).toEqual({ kind: 'column', table: 'users' });
    // WHERE 后
    expect(resolveCompletionContext('SELECT * FROM users WHERE ', 26)).toEqual({
      kind: 'column',
      table: 'users',
    });
  });

  it('别名. 后 → 该别名对应表的所有列；表名. 同理', () => {
    expect(resolveCompletionContext('SELECT u. FROM users u', 9)).toEqual({ kind: 'column', table: 'users' });
    expect(resolveCompletionContext('SELECT users. FROM users', 13)).toEqual({ kind: 'column', table: 'users' });
  });

  it('USE 后 → 库名', () => {
    expect(resolveCompletionContext('USE ', 4)).toEqual({ kind: 'database' });
  });

  it('解析不到所属表时退回 any', () => {
    expect(resolveCompletionContext('x.', 2)).toEqual({ kind: 'any' });
  });
});

describe('buildCompletionDescriptors', () => {
  it('table 上下文：表 + 库', () => {
    const items = buildCompletionDescriptors(source, { kind: 'table' });
    expect(items.map((i) => i.label)).toContain('users');
    expect(items.map((i) => i.label)).toContain('demo');
    expect(items.find((i) => i.label === 'users')?.detail).toBe('用户表');
  });

  it('column 上下文：限当前表的列 + 函数', () => {
    const items = buildCompletionDescriptors(source, { kind: 'column', table: 'users' });
    const labels = items.map((i) => i.label);
    expect(labels).toContain('email');
    expect(labels).not.toContain('amount');
    expect(labels).toContain('COUNT');
  });

  it('column 上下文含关键字殿后（FROM/WHERE 在列位可提示，M8 修复）', () => {
    const items = buildCompletionDescriptors(source, { kind: 'column', table: 'users' });
    const labels = items.map((i) => i.label);
    expect(labels).toContain('WHERE');
    expect(labels).toContain('FROM');
    // 顺序：列 → 函数 → 关键字（列不被关键字淹没）
    const kinds = items.map((i) => i.kind);
    expect(kinds.indexOf('column')).toBeLessThan(kinds.indexOf('keyword'));
    const firstKeyword = kinds.indexOf('keyword');
    expect(kinds.slice(firstKeyword).every((k) => k === 'keyword')).toBe(true);
  });

  it('any 上下文：关键字 + 函数 + 表 + 列 + 库', () => {
    const items = buildCompletionDescriptors(source, { kind: 'any' });
    const labels = items.map((i) => i.label);
    expect(labels).toContain('SELECT');
    expect(labels).toContain('NOW');
    expect(labels).toContain('orders');
    expect(labels).toContain('id');
    expect(labels).toContain('analytics');
  });

  it('any 上下文排序：表/列在前、关键字殿后（M8 优先级重排）', () => {
    const items = buildCompletionDescriptors(source, { kind: 'any' });
    const kinds = items.map((i) => i.kind);
    expect(kinds.indexOf('table')).toBeLessThan(kinds.indexOf('keyword'));
    expect(kinds.indexOf('column')).toBeLessThan(kinds.indexOf('keyword'));
    // 关键字为连续尾段：首个关键字之后不再混入表/列等高优先级条目
    const firstKeyword = kinds.indexOf('keyword');
    expect(kinds.slice(firstKeyword).every((k) => k === 'keyword')).toBe(true);
  });

  it('片段：label/detail 透传且携带插入体', () => {
    const withSnippets: CompletionSource = {
      ...source,
      snippets: [{ label: 'JOIN (模板)', body: 'SELECT t.* FROM ${1:a} t JOIN ${2:b} o;', description: '内连接' }],
    };
    const item = buildCompletionDescriptors(withSnippets, { kind: 'any' }).find((i) => i.kind === 'snippet');
    expect(item?.label).toBe('JOIN (模板)');
    expect(item?.insert).toBe('SELECT t.* FROM ${1:a} t JOIN ${2:b} o;');
    expect(item?.detail).toBe('内连接');
  });
});

describe('未绑定文档的关键字级补全（P1-1）', () => {
  it('BASE_KEYWORDS 覆盖常用关键字且不含库/表数据', () => {
    expect(BASE_KEYWORDS).toContain('SELECT');
    expect(BASE_KEYWORDS).toContain('DELETE FROM');
    expect(BASE_KEYWORDS.length).toBeGreaterThan(20);
  });

  it('M8 扩充：窗口/CTE/CASE 与数据类型入库', () => {
    expect(BASE_KEYWORDS).toContain('WITH');
    expect(BASE_KEYWORDS).toContain('OVER');
    expect(BASE_KEYWORDS).toContain('CASE');
    expect(BASE_KEYWORDS).toContain('VARCHAR');
  });

  it('BASE_FUNCTIONS / GENERIC_SNIPPETS 覆盖常用面', () => {
    expect(BASE_FUNCTIONS).toContain('COALESCE');
    expect(BASE_FUNCTIONS.length).toBeGreaterThan(10);
    expect(GENERIC_SNIPPETS.length).toBeGreaterThanOrEqual(8);
    expect(GENERIC_SNIPPETS.every((s) => s.body.includes('${1:'))).toBe(true);
  });
});
