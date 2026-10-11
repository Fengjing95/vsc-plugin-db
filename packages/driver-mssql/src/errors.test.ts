import { describe, expect, it } from 'vitest';
import { DriverError } from '@db-explorer/core';
import { toDriverError } from './errors';

/** 错误映射表（驱动规范 §6：UI 只认 code 不解析 message） */
describe('toDriverError（M8-MSSQL）', () => {
  const withCode = (code: string, message = 'boom', extra: Record<string, unknown> = {}): unknown =>
    Object.assign(new Error(message), { code, ...extra });

  it('DriverError 实例原样透传；普通 Error 带 code 字段不做透传', () => {
    const de = new DriverError('E_CONFLICT', '冲突');
    expect(toDriverError(de)).toBe(de);
    // 普通 Error 带 code 字段不会被误透传（非 DriverError 实例）
    const plain = toDriverError(Object.assign(new Error('x'), { code: 'E_CONFLICT' }));
    expect(plain.code).not.toBe('E_CONFLICT');
  });

  it('认证/连接/超时/取消（mssql 错误码）', () => {
    expect(toDriverError(withCode('ELOGIN', 'Login failed for user')).code).toBe('E_AUTH');
    expect(toDriverError(withCode('ECANCEL', 'Canceled.')).code).toBe('E_CANCELED');
    expect(toDriverError(withCode('ECONNREFUSED')).code).toBe('E_CONN');
    expect(toDriverError(withCode('ECONNRESET')).code).toBe('E_CONN');
    expect(toDriverError(withCode('ENOTFOUND')).code).toBe('E_CONN');
    expect(toDriverError(withCode('ESOCKET', 'socket hang up')).code).toBe('E_CONN');
    expect(toDriverError(withCode('ENOTOPEN')).code).toBe('E_CONN');
    expect(toDriverError(withCode('ECONNCLOSED')).code).toBe('E_CONN');
    // 建连超时（Failed to connect …）→ E_CONN；请求超时 → E_TIMEOUT
    expect(toDriverError(withCode('ETIMEOUT', 'Failed to connect to 127.0.0.1:1433 in 2000ms')).code).toBe('E_CONN');
    expect(toDriverError(withCode('ETIMEOUT', 'Request timeout')).code).toBe('E_TIMEOUT');
  });

  it('服务端 SQL 错误（EREQUEST + number）映射', () => {
    expect(toDriverError(withCode('EREQUEST', 'Invalid object name', { number: 208 })).code).toBe('E_NOT_FOUND');
    expect(toDriverError(withCode('EREQUEST', 'Cannot open database', { number: 4060 })).code).toBe('E_NOT_FOUND');
    expect(toDriverError(withCode('EREQUEST', 'Incorrect syntax near', { number: 102 })).code).toBe('E_SYNTAX');
    expect(toDriverError(withCode('EREQUEST', 'Invalid column name', { number: 207 })).code).toBe('E_SYNTAX');
    expect(toDriverError(withCode('EREQUEST', 'Violation of PRIMARY KEY', { number: 2627 })).code).toBe('E_CONSTRAINT');
    expect(toDriverError(withCode('EREQUEST', 'The INSERT statement conflicted with the FOREIGN KEY', { number: 547 })).code).toBe('E_CONSTRAINT');
    expect(toDriverError(withCode('EREQUEST', 'Cannot insert the value NULL', { number: 515 })).code).toBe('E_CONSTRAINT');
    expect(toDriverError(withCode('EREQUEST', 'Transaction was deadlocked', { number: 1205 })).code).toBe('E_CONFLICT');
    expect(toDriverError(withCode('EREQUEST', 'Lock request time out', { number: 1222 })).code).toBe('E_TIMEOUT');
    expect(toDriverError(withCode('EREQUEST', 'The SELECT permission was denied', { number: 229 })).code).toBe('E_PERMISSION');
    expect(toDriverError(withCode('EREQUEST', 'Login failed', { number: 18456 })).code).toBe('E_AUTH');
    expect(toDriverError(withCode('EREQUEST', '未知服务端错误', { number: 99999 })).code).toBe('E_INTERNAL');
  });

  it('无码错误 → E_INTERNAL；retryable 标注：连接类 true、其余 false', () => {
    const conn = toDriverError(withCode('ECONNREFUSED'));
    expect(conn.retryable).toBe(true);
    const auth = toDriverError(withCode('ELOGIN'));
    expect(auth.retryable).toBe(false);
    expect(toDriverError(new Error('plain failure')).code).toBe('E_INTERNAL');
  });
});
