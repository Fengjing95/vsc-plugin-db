import { describe, expect, it } from 'vitest';
import { parseOracleErrorCode, toDriverError } from './errors';

describe('oracle errors：ORA/NJS → DriverError 映射（驱动规范 §6 / ADR D-23）', () => {
  it('ORA 错误号映射到既定 code', () => {
    expect(toDriverError(new Error('ORA-01017: invalid username/password; logon denied')).code).toBe('E_AUTH');
    expect(toDriverError(new Error('ORA-01013: user requested cancel of current operation')).code).toBe('E_CANCELED');
    expect(toDriverError(new Error('ORA-00001: unique constraint (DBKIT.CF_PK) violated')).code).toBe('E_CONSTRAINT');
    expect(toDriverError(new Error('ORA-02291: integrity constraint violated - parent key not found')).code).toBe('E_CONSTRAINT');
    expect(toDriverError(new Error('ORA-00942: table or view does not exist')).code).toBe('E_NOT_FOUND');
    expect(toDriverError(new Error('ORA-00911: invalid character')).code).toBe('E_SYNTAX');
    expect(toDriverError(new Error('ORA-01031: insufficient privileges')).code).toBe('E_PERMISSION');
    expect(toDriverError(new Error('ORA-00060: deadlock detected while waiting for resource')).code).toBe('E_CONFLICT');
    expect(toDriverError(new Error('ORA-12541: TNS:no listener')).code).toBe('E_CONN');
    expect(toDriverError(new Error('ORA-12154: TNS:could not resolve the connect identifier specified')).code).toBe('E_CONN');
  });

  it('NJS（thin 客户端）错误映射：callTimeout → E_TIMEOUT、建连失败 → E_CONN', () => {
    expect(toDriverError(new Error('NJS-123: call timeout of 800 ms exceeded')).code).toBe('E_TIMEOUT');
    expect(toDriverError(new Error('NJS-521: connect timeout exceeded')).code).toBe('E_CONN');
    expect(toDriverError(new Error('NJS-003: invalid value for parameter 3')).code).toBe('E_VALIDATION');
    expect(toDriverError(new Error('NJS-500: connection to the Oracle database is unavailable')).code).toBe('E_CONN');
  });

  it('message 为中文文案、detail 携带原文与 errorNum', () => {
    const err = toDriverError(Object.assign(new Error('ORA-00942: table or view does not exist\nhttps://docs.oracle.com/error-help/'), { errorNum: 942 }));
    expect(err.message).toBe('表或视图不存在');
    expect(err.detail).toContain('errorNum=942');
    expect(err.detail).toContain('docs.oracle.com');
  });

  it('未收录 ORA 系统类与宿主网络错误的兜底', () => {
    expect(toDriverError(new Error('ORA-04068: existing state of packages has been discarded')).code).toBe('E_INTERNAL');
    const refused = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1521'), { code: 'ECONNREFUSED' });
    expect(toDriverError(refused).code).toBe('E_CONN');
    expect(toDriverError(new Error('some unknown failure')).code).toBe('E_INTERNAL');
  });

  it('DriverError 原样透传；错误号解析器可独立使用', () => {
    const parsed = parseOracleErrorCode('ORA-28001: the password has expired');
    expect(parsed).toEqual({ family: 'ORA', num: 28001 });
    expect(parseOracleErrorCode('NJS-123: call timeout')?.family).toBe('NJS');
    expect(parseOracleErrorCode('nothing here')).toBeUndefined();
  });
});
