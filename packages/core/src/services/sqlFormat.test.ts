import { describe, expect, it } from 'vitest';
import { formatSql } from './sqlFormat';

describe('formatSql', () => {
  it('按 mysql 方言格式化（关键字大写、换行缩进、反引号保留）', () => {
    const out = formatSql("select `name`,count(*) from `users` where `id` = 1", 'mysql');
    expect(out).toMatch(/^SELECT\n/);
    expect(out).toContain('`users`');
    expect(out).toContain('WHERE');
  });

  it('postgresql 方言映射', () => {
    const out = formatSql('select a from t', 'postgresql');
    expect(out).toContain('SELECT');
    expect(out).toContain('FROM');
  });

  it('未知方言退回标准 SQL', () => {
    const out = formatSql('select 1', 'unknown-dialect');
    expect(out).toContain('SELECT');
  });

  it('未提供方言 → 标准 SQL', () => {
    const out = formatSql('  select 1  ');
    expect(out).toContain('SELECT');
    expect(out).not.toContain('  select');
  });

  it('空/纯空白文本原样返回', () => {
    expect(formatSql('')).toBe('');
    expect(formatSql('   ')).toBe('   ');
  });

  it('解析失败（未闭合字符串）原样返回，不抛错', () => {
    const bad = "select 'unclosed from t";
    expect(formatSql(bad, 'mysql')).toBe(bad);
  });
});
