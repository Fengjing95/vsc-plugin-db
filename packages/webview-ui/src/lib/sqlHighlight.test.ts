import { describe, expect, it } from 'vitest';
import { highlightSql } from './sqlHighlight';

describe('highlightSql（SQL 语法高亮，预览语句/DDL 统一入口）', () => {
  it('关键字/字符串/注释分别产出 token span', () => {
    const html = highlightSql("UPDATE `t` SET `a` = 'x' -- 备注");
    expect(html).toContain('token keyword');
    expect(html).toContain('token string');
    expect(html).toContain('token comment');
  });

  it('HTML 特殊字符被转义，不产生裸标签', () => {
    const html = highlightSql("INSERT INTO t VALUES ('<script>&b');");
    // Prism 转义 < 与 &（> 保留原文，文本上下文无害）
    expect(html).toContain('&lt;script');
    expect(html).toContain('&amp;');
    expect(html).not.toContain('<script>');
  });

  it('参数化占位符 ? 与多行 DDL 均可高亮，空串安全', () => {
    const ddl = highlightSql('CREATE TABLE `users` (\n  `id` int NOT NULL,\n  PRIMARY KEY (`id`)\n);');
    expect(ddl).toContain('token');
    expect(highlightSql('SELECT * FROM t WHERE a = ?')).toContain('token');
    expect(highlightSql('')).toBe('');
  });
});
