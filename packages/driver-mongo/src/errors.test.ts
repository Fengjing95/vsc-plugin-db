import { describe, expect, it } from 'vitest';
import { DriverError } from '@db-explorer/core';
import { toMongoError } from './errors';

/** 原生错误 → DriverError 映射（驱动规范 §6 MongoDB 行，UI 只认 code） */

function native(props: { name?: string; code?: number | string; message?: string }): Error {
  return Object.assign(new Error(props.message ?? 'boom'), props);
}

describe('toMongoError（§6 映射基准）', () => {
  it('DriverError 原样透传', () => {
    const e = new DriverError('E_VALIDATION', 'x');
    expect(toMongoError(e)).toBe(e);
  });

  it('连接族：ServerSelection / 网络系统错误 → E_CONN（retryable）', () => {
    for (const e of [
      native({ name: 'MongoServerSelectionError', message: 'connection timed out' }),
      native({ code: 'ECONNREFUSED' }),
      native({ code: 'ENOTFOUND' }),
      native({ name: 'MongoNotConnectedError' }),
    ]) {
      const m = toMongoError(e);
      expect(m.code, String(e)).toBe('E_CONN');
      expect(m.retryable).toBe(true);
    }
  });

  it('ServerSelectionError 携带认证失败 → E_AUTH', () => {
    const m = toMongoError(
      native({ name: 'MongoServerSelectionError', message: 'Authentication failed.' }),
    );
    expect(m.code).toBe('E_AUTH');
  });

  it('MongoServerError 按 code：11000→E_CONSTRAINT、13→E_PERMISSION、18→E_AUTH、26/73→E_NOT_FOUND、50→E_TIMEOUT', () => {
    expect(toMongoError(native({ name: 'MongoServerError', code: 11000 })).code).toBe('E_CONSTRAINT');
    expect(toMongoError(native({ name: 'MongoServerError', code: 13 })).code).toBe('E_PERMISSION');
    expect(toMongoError(native({ name: 'MongoServerError', code: 18 })).code).toBe('E_AUTH');
    expect(toMongoError(native({ name: 'MongoServerError', code: 26 })).code).toBe('E_NOT_FOUND');
    expect(toMongoError(native({ name: 'MongoServerError', code: 73 })).code).toBe('E_NOT_FOUND');
    expect(toMongoError(native({ name: 'MongoServerError', code: 50 })).code).toBe('E_TIMEOUT');
  });

  it('客户端族：Parse→E_VALIDATION、Abort→E_CANCELED、OperationTimeout→E_TIMEOUT、InvalidArgument→E_VALIDATION', () => {
    expect(toMongoError(native({ name: 'MongoParseError' })).code).toBe('E_VALIDATION');
    expect(toMongoError(native({ name: 'MongoAbortError' })).code).toBe('E_CANCELED');
    expect(toMongoError(native({ name: 'MongoOperationTimeoutError' })).code).toBe('E_TIMEOUT');
    expect(toMongoError(native({ name: 'MongoInvalidArgumentError' })).code).toBe('E_VALIDATION');
  });

  it('未识别 → E_INTERNAL；detail 脱敏连接串凭据（C-10）', () => {
    const m = toMongoError(native({ message: 'mongodb://user:secret@host:27017 failed' }));
    expect(m.code).toBe('E_INTERNAL');
    expect(m.detail).not.toContain('secret');
    expect(m.detail).toContain('***');
  });
});
