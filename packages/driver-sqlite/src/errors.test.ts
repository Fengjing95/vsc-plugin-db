import { describe, expect, it } from 'vitest';
import { DriverError } from '@db-explorer/core';
import { toDriverError } from './errors';

/** 错误映射单测（驱动规范 §6 基准表 SQLite 行）：UI 只认 code 不解析 message。 */

function msg(text: string, code?: string): Error {
  const e = new Error(text);
  if (code) {
    (e as Error & { code?: string }).code = code;
  }
  return e;
}

describe('toDriverError（SQLite → DriverErrorCode）', () => {
  const cases: Array<{ raw: Error; code: string }> = [
    { raw: msg('UNIQUE constraint failed: t.id'), code: 'E_CONSTRAINT' },
    { raw: msg('FOREIGN KEY constraint failed'), code: 'E_CONSTRAINT' },
    { raw: msg('NOT NULL constraint failed: t.name'), code: 'E_CONSTRAINT' },
    { raw: msg('some failure', 'SQLITE_CONSTRAINT_UNIQUE'), code: 'E_CONSTRAINT' },
    { raw: msg('no such table: cf_users'), code: 'E_NOT_FOUND' },
    { raw: msg('no such column: x'), code: 'E_NOT_FOUND' },
    { raw: msg('near "SELEC": syntax error'), code: 'E_SYNTAX' },
    { raw: msg('attempt to write a readonly database'), code: 'E_READONLY' },
    { raw: msg('database is locked'), code: 'E_TIMEOUT' },
    { raw: msg('unable to open database file'), code: 'E_CONN' },
    { raw: msg('file is not a database'), code: 'E_VALIDATION' },
    { raw: msg('out of memory'), code: 'E_CAPACITY' },
    { raw: msg('totally unknown failure'), code: 'E_INTERNAL' },
  ];

  it('逐条映射到 DriverErrorCode', () => {
    for (const { raw, code } of cases) {
      const mapped = toDriverError(raw);
      expect(DriverError.is(mapped), raw.message).toBe(true);
      expect(mapped.code, raw.message).toBe(code);
    }
  });

  it('DriverError 原样透传（不二次包装）', () => {
    const original = toDriverError(msg('database is locked'));
    expect(toDriverError(original)).toBe(original);
  });

  it('retryable 仅 E_TIMEOUT（SQLITE_BUSY 可重试）', () => {
    expect(toDriverError(msg('database is locked')).retryable).toBe(true);
    expect(toDriverError(msg('UNIQUE constraint failed: t.id')).retryable).toBe(false);
  });
});
