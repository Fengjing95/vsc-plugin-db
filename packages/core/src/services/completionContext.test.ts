import { describe, expect, it } from 'vitest';
import type { CompletionSource } from '../model/rows';
import { BASE_KEYWORDS, buildCompletionDescriptors, resolveCompletionContext } from './completionContext';

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

  it('any 上下文：关键字 + 函数 + 表 + 列 + 库', () => {
    const items = buildCompletionDescriptors(source, { kind: 'any' });
    const labels = items.map((i) => i.label);
    expect(labels).toContain('SELECT');
    expect(labels).toContain('NOW');
    expect(labels).toContain('orders');
    expect(labels).toContain('id');
    expect(labels).toContain('analytics');
  });
});

describe('未绑定文档的关键字级补全（P1-1）', () => {
  it('BASE_KEYWORDS 覆盖常用关键字且不含库/表数据', () => {
    expect(BASE_KEYWORDS).toContain('SELECT');
    expect(BASE_KEYWORDS).toContain('DELETE FROM');
    expect(BASE_KEYWORDS.length).toBeGreaterThan(20);
  });
});
