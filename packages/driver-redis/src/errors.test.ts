import { describe, expect, it } from 'vitest';
import { DriverError } from '@db-explorer/core';
import { toRedisError } from './errors';

/** 驱动开发规范 §6 错误映射表（Redis 行）：UI 只认 code，不解析 message */
describe('toRedisError 错误映射', () => {
  it('DriverError 原样透传', () => {
    const orig = new DriverError('E_NOT_FOUND', '键不存在');
    expect(toRedisError(orig)).toBe(orig);
  });

  it.each([
    ['NOAUTH Authentication required.', 'E_AUTH'],
    ['WRONGPASS invalid username-password pair or user is disabled.', 'E_AUTH'],
    ['ERR Client sent AUTH, but no password is set. Did you mean AUTH <username>?', 'E_AUTH'],
  ])('认证错误 %j → E_AUTH', (message, code) => {
    const err = toRedisError(new Error(message));
    expect(err).toBeInstanceOf(DriverError);
    expect(err.code).toBe(code);
    expect(err.retryable).toBe(false);
  });

  it.each([
    ['WRONGTYPE Operation against a key holding the wrong kind of value', 'E_UNSUPPORTED'],
    ["ERR unknown command 'NOSUCHCMD', with args beginning with: 'x'", 'E_UNSUPPORTED'],
  ])('类型/未知命令 %j → E_UNSUPPORTED', (message, code) => {
    expect(toRedisError(new Error(message)).code).toBe(code);
  });

  it.each([
    ['ERR wrong number of arguments for \'get\' command', 'E_SYNTAX'],
    ['ERR syntax error', 'E_SYNTAX'],
    ["ERR value is not an integer or out of range", 'E_SYNTAX'],
  ])('命令语法错误 %j → E_SYNTAX', (message, code) => {
    expect(toRedisError(new Error(message)).code).toBe(code);
  });

  it('cluster 副本读写拒绝 → E_READONLY', () => {
    expect(toRedisError(new Error('READONLY You can\'t write against a read only replica.')).code).toBe(
      'E_READONLY',
    );
  });

  it('权限不足（NOPERM）→ E_PERMISSION', () => {
    expect(
      toRedisError(new Error('NOPERM this user has no permissions to run the \'set\' command')).code,
    ).toBe('E_PERMISSION');
  });

  it('OOM command not allowed → E_CAPACITY', () => {
    expect(
      toRedisError(
        new Error('OOM command not allowed when used memory > \'maxmemory\'.'),
      ).code,
    ).toBe('E_CAPACITY');
  });

  it('BUSYGRID/BUSY 系统忙 → E_TIMEOUT', () => {
    expect(toRedisError(new Error('BUSY Redis is busy running a script.')).code).toBe('E_TIMEOUT');
  });

  it.each([
    ['ECONNREFUSED'],
    ['ECONNRESET'],
    ['ENOTFOUND'],
    ['ETIMEDOUT'],
    ['EPIPE'],
    ['EHOSTUNREACH'],
  ])('网络错误 %s → E_CONN（可重试）', (code) => {
    const err = new Error('connect failed') as Error & { code?: string };
    err.code = code;
    const mapped = toRedisError(err);
    expect(mapped.code).toBe('E_CONN');
    expect(mapped.retryable).toBe(true);
    expect(mapped.detail).toContain(code);
  });

  it('node-redis 连接关闭（ClientClosedError 文案）→ E_CONN', () => {
    expect(toRedisError(new Error('The client is closed')).code).toBe('E_CONN');
  });

  it('原始信息进 detail，message 为面向用户的一句话（不含密码）', () => {
    const err = toRedisError(new Error('WRONGPASS invalid username-password pair'));
    expect(err.message).not.toContain('WRONGPASS');
    expect(err.detail).toContain('WRONGPASS');
  });

  it('未识别错误 → E_INTERNAL', () => {
    expect(toRedisError(new Error('mystery failure')).code).toBe('E_INTERNAL');
  });
});
