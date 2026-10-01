import { describe, expect, it } from 'vitest';
import { assessStatementDanger, isReadStatement } from './sqlDanger';

describe('assessStatementDanger（概要 §5.8：无 WHERE 的 UPDATE/DELETE、DROP、TRUNCATE、ALTER…DROP）', () => {
  it('无 WHERE 的 UPDATE/DELETE 判危险（AST 路径）', () => {
    const upd = assessStatementDanger('UPDATE users SET name = 1');
    expect(upd.dangerous).toBe(true);
    expect(upd.parseFailed).toBe(false);
    expect(upd.reasons[0]).toContain('UPDATE');

    const del = assessStatementDanger('DELETE FROM users');
    expect(del.dangerous).toBe(true);
    expect(del.reasons[0]).toContain('DELETE');
  });

  it('带 WHERE 的 UPDATE/DELETE 不判危险', () => {
    expect(assessStatementDanger('UPDATE users SET name = 1 WHERE id = 1').dangerous).toBe(false);
    expect(assessStatementDanger("DELETE FROM users WHERE id = 'a;b'").dangerous).toBe(false);
  });

  it('DROP / TRUNCATE / ALTER…DROP 判危险；普通 ALTER 不判', () => {
    expect(assessStatementDanger('DROP TABLE users').dangerous).toBe(true);
    expect(assessStatementDanger('TRUNCATE TABLE users').dangerous).toBe(true);
    expect(assessStatementDanger('ALTER TABLE users DROP COLUMN email').dangerous).toBe(true);
    expect(assessStatementDanger('ALTER TABLE users ADD COLUMN c int').dangerous).toBe(false);
    expect(assessStatementDanger('SELECT * FROM users').dangerous).toBe(false);
  });

  it('解析失败降级为正则（宁可误报不漏报）', () => {
    // 语法残缺（未闭合反引号）且无 WHERE → AST 失败 → 正则兜底判危险
    const broken = assessStatementDanger('UPDATE `users SET a = 1');
    expect(broken.parseFailed).toBe(true);
    expect(broken.dangerous).toBe(true);

    // 不可解析但不含危险关键字 → 降级后不误报
    const flush = assessStatementDanger('FLUSH PRIVILEGES');
    expect(flush.parseFailed).toBe(true);
    expect(flush.dangerous).toBe(false);

    // 注释里藏 DROP → AST 正确忽略（不误报）
    expect(assessStatementDanger('SELECT 1 /* DROP TABLE users */').dangerous).toBe(false);
  });

  it('字符串里的关键字不误判', () => {
    expect(assessStatementDanger("SELECT 'DROP TABLE' AS x").dangerous).toBe(false);
    expect(assessStatementDanger("SELECT * FROM t WHERE note = 'truncate'").dangerous).toBe(false);
  });
});

describe('isReadStatement（只读连接 fail-closed，概要 §5.8）', () => {
  it('SELECT/SHOW/DESC/EXPLAIN 证明为读', () => {
    expect(isReadStatement('SELECT * FROM users')).toBe(true);
    expect(isReadStatement('EXPLAIN SELECT 1')).toBe(true);
    expect(isReadStatement('DESCRIBE users')).toBe(true);
  });

  it('写语句 / 不可判定语句一律非读（fail-closed）', () => {
    expect(isReadStatement('UPDATE users SET a = 1 WHERE id = 1')).toBe(false);
    expect(isReadStatement('INSERT INTO t VALUES (1)')).toBe(false);
    // 多语句文本不可证明为读（即使首条是 SELECT）——调用方必须先切分
    expect(isReadStatement('SELECT 1; DELETE FROM t')).toBe(false);
  });
});
