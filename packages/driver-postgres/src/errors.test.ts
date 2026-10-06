import { describe, expect, it } from 'vitest';
import { toDriverError } from './errors';

describe('toDriverError（驱动规范 §6 PG SQLSTATE 映射）', () => {
  const cases: Array<[Record<string, unknown>, string, boolean]> = [
    [{ code: '28P01', message: 'password authentication failed' }, 'E_AUTH', false],
    [{ code: '42P01', message: 'relation "x" does not exist' }, 'E_NOT_FOUND', false],
    [{ code: '3D000', message: 'database "x" does not exist' }, 'E_NOT_FOUND', false],
    [{ code: '42601', message: 'syntax error at or near' }, 'E_SYNTAX', false],
    [{ code: '42883', message: 'function x() does not exist' }, 'E_SYNTAX', false],
    [{ code: '23505', message: 'duplicate key value violates unique constraint' }, 'E_CONSTRAINT', false],
    [{ code: '23503', message: 'insert or update on table violates foreign key constraint' }, 'E_CONSTRAINT', false],
    [{ code: '23502', message: 'null value in column violates not-null constraint' }, 'E_CONSTRAINT', false],
    [{ code: '23514', message: 'new row for relation violates check constraint' }, 'E_CONSTRAINT', false],
    [{ code: '42501', message: 'permission denied for table' }, 'E_PERMISSION', false],
    [{ code: '57014', message: 'canceling statement due to user request' }, 'E_CANCELED', false],
    // retryable 是码级属性（core 仅 E_CONN/E_TIMEOUT）；E_CONFLICT 走「刷新后重试」用户动作而非自动重试
    [{ code: '40001', message: 'could not serialize access due to concurrent update' }, 'E_CONFLICT', false],
    [{ code: '40P01', message: 'deadlock detected' }, 'E_CONFLICT', false],
    [{ code: '53300', message: 'sorry, too many clients already' }, 'E_CAPACITY', false],
    [{ code: '57P01', message: 'terminating connection due to administrator command' }, 'E_CONN', true],
    [{ code: 'ECONNREFUSED', message: 'connect ECONNREFUSED 127.0.0.1:5432' }, 'E_CONN', true],
    [{ code: 'ENOTFOUND', message: 'getaddrinfo ENOTFOUND db.host' }, 'E_CONN', true],
    [{ message: 'timeout exceeded when trying to connect' }, 'E_CONN', true],
  ];

  for (const [raw, code, retryable] of cases) {
    it(`${String(raw.code ?? '(无码)')} → ${code}`, () => {
      const err = toDriverError(raw);
      expect(err.code).toBe(code);
      expect(err.retryable).toBe(retryable);
      // detail 携带原始信息（供「查看详情」，UI 不解析）
      expect(err.detail).toContain(String(raw.message));
    });
  }

  it('未识别错误 → E_INTERNAL', () => {
    expect(toDriverError(new Error('something odd')).code).toBe('E_INTERNAL');
  });
});
