import { describe, expect, it } from 'vitest';
import {
  isDdlStatement,
  isSessionStateStatement,
  splitSqlStatements,
  statementAtOffset,
} from './sqlScript';

describe('splitSqlStatements（概要 5.5.2 语句切分）', () => {
  it('按分号切分多条语句', () => {
    const stmts = splitSqlStatements('SELECT 1; SELECT 2 ;\nSELECT 3;');
    expect(stmts.map((s) => s.text)).toEqual(['SELECT 1', 'SELECT 2', 'SELECT 3']);
  });

  it('字符串与反引号标识符内的分号不切分', () => {
    const stmts = splitSqlStatements("SELECT 'a;b' AS x FROM `t;1`; SELECT 'it''s;ok';");
    expect(stmts.map((s) => s.text)).toEqual(["SELECT 'a;b' AS x FROM `t;1`", "SELECT 'it''s;ok'"]);
  });

  it('注释内的分号不切分（行注释 / # 注释 / 块注释）', () => {
    const sql = [
      'SELECT 1 -- 注释;不切',
      ';',
      'SELECT 2 # 也;不切',
      ';',
      '/* 块注释;同样 */ SELECT 3;',
    ].join('\n');
    const texts = splitSqlStatements(sql).map((s) => s.text);
    expect(texts).toEqual([
      'SELECT 1 -- 注释;不切',
      'SELECT 2 # 也;不切',
      '/* 块注释;同样 */ SELECT 3',
    ]);
  });

  it('反斜杠转义的引号不终止字符串', () => {
    const stmts = splitSqlStatements("SELECT 'a\\';b' AS x;");
    expect(stmts).toHaveLength(1);
    expect(stmts[0].text).toBe("SELECT 'a\\';b' AS x");
  });

  it('未闭合字符串保持整段不切', () => {
    const stmts = splitSqlStatements("SELECT 'a;b");
    expect(stmts).toHaveLength(1);
  });

  it('空白与纯分号片段被跳过；start 对齐首个非空白字符', () => {
    const sql = '  SELECT 1 ;\n\n   SELECT 2;';
    const stmts = splitSqlStatements(sql);
    expect(stmts).toHaveLength(2);
    expect(sql.slice(stmts[1].start, stmts[1].start + 7)).toBe('SELECT ');
  });

  it('无结尾分号的最后一条语句也返回', () => {
    expect(splitSqlStatements('SELECT 1').map((s) => s.text)).toEqual(['SELECT 1']);
    expect(splitSqlStatements('')).toEqual([]);
  });
});

describe('statementAtOffset（Ctrl+Enter 定位当前语句）', () => {
  const sql = 'SELECT 1;\nSELECT 2;\nSELECT 3;';
  const stmts = splitSqlStatements(sql);

  it('光标在语句内 → 命中该语句', () => {
    expect(statementAtOffset(stmts, 2)?.text).toBe('SELECT 1');
    expect(statementAtOffset(stmts, 11)?.text).toBe('SELECT 2');
  });

  it('光标停在分号/空白处 → 取前一条（刚写完的语句）', () => {
    expect(statementAtOffset(stmts, 9)?.text).toBe('SELECT 1');
    expect(statementAtOffset(stmts, sql.length)?.text).toBe('SELECT 3');
  });
});

describe('会话状态与 DDL 识别（P1-5 / 概要 7.5）', () => {
  it('SET @x / USE / 临时表视为会话状态语句', () => {
    expect(isSessionStateStatement('SET @x = 1')).toBe(true);
    expect(isSessionStateStatement('set names utf8mb4')).toBe(true);
    expect(isSessionStateStatement('USE mydb;')).toBe(true);
    expect(isSessionStateStatement('CREATE TEMPORARY TABLE t AS SELECT 1')).toBe(true);
    expect(isSessionStateStatement('SET a = 1')).toBe(true); // 保守：SET 一律按会话状态
  });

  it('普通语句不是会话状态语句', () => {
    expect(isSessionStateStatement('SELECT * FROM users')).toBe(false);
    expect(isSessionStateStatement('UPDATE t SET a = 1 WHERE id = 1')).toBe(false);
  });

  it('DDL 识别：CREATE/ALTER/DROP/TRUNCATE', () => {
    expect(isDdlStatement('CREATE TABLE t (id int)')).toBe(true);
    expect(isDdlStatement('alter table t drop column a')).toBe(true);
    expect(isDdlStatement('TRUNCATE TABLE t')).toBe(true);
    expect(isDdlStatement('DROP TABLE t')).toBe(true);
    expect(isDdlStatement('SELECT 1')).toBe(false);
    expect(isDdlStatement('DELETE FROM t')).toBe(false);
  });

  it('注释不干扰关键字识别', () => {
    expect(isDdlStatement('-- drop 什么\nSELECT 1')).toBe(false);
    expect(isSessionStateStatement('/* set */ SELECT 1')).toBe(false);
  });
});
