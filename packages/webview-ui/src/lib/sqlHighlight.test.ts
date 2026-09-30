import { describe, expect, it } from 'vitest';
import { highlightSql, interpolateSqlParams } from './sqlHighlight';

describe('interpolateSqlParams（占位符回填实际值，预览语句可读性）', () => {
  it('按序回填：字符串加引号、NULL、数字、布尔', () => {
    const sql = 'UPDATE t SET a = ?, b = ?, c = ?, d = ? WHERE id = ?';
    const out = interpolateSqlParams(sql, ["O'Brien", null, 42, true, 7]);
    expect(out).toBe("UPDATE t SET a = 'O''Brien', b = NULL, c = 42, d = TRUE WHERE id = 7");
  });

  it('字符串中的反斜杠与单引号转义；undefined 视为 NULL', () => {
    // 实际值：a\b'c → 字面量 'a\\b''c'
    expect(interpolateSqlParams('INSERT INTO t VALUES (?)', ["a\\b'c"])).toBe("INSERT INTO t VALUES ('a\\\\b''c')");
    expect(interpolateSqlParams('INSERT INTO t VALUES (?)', [undefined])).toBe('INSERT INTO t VALUES (NULL)');
  });

  it('无参数原样返回；占位符多于参数时多余 ? 保留', () => {
    expect(interpolateSqlParams('SELECT 1')).toBe('SELECT 1');
    expect(interpolateSqlParams('SELECT ?, ?', [1])).toBe('SELECT 1, ?');
  });

  it('JSON 对象参数序列化为带引号字面量', () => {
    expect(interpolateSqlParams('UPDATE t SET j = ?', [{ a: 1 }])).toBe(`UPDATE t SET j = '{"a":1}'`);
  });
});

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
