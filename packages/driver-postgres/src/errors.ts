import { DriverError, type DriverErrorCode } from '@db-explorer/core';

/**
 * 原生错误 → DriverError 映射（驱动开发规范 §6，UI 只认 code 不解析 message）。
 * PG 的 SQLSTATE 五位码经 pg 的 error.code 透出；系统调用错误（ECONNREFUSED 等）同名字段——
 * 先按 SQLSTATE 精确表匹配（五位码），再按系统错误码集合兜底，最后按消息特征（pg 建连超时无码）。
 */
const SQLSTATE_MAP: Record<string, { code: DriverErrorCode; message?: string }> = {
  '28P01': { code: 'E_AUTH', message: '认证失败：请检查用户名/密码' },
  '3D000': { code: 'E_NOT_FOUND', message: '数据库不存在' },
  '42P01': { code: 'E_NOT_FOUND', message: '表不存在，可能已被删除' },
  '42883': { code: 'E_SYNTAX', message: '函数/操作符不存在，请检查拼写与参数类型' },
  '42601': { code: 'E_SYNTAX', message: 'SQL 语法错误' },
  '23505': { code: 'E_CONSTRAINT', message: '唯一键冲突：数据已被他人修改或重复' },
  '23503': { code: 'E_CONSTRAINT', message: '外键约束冲突：引用的数据不存在' },
  '23502': { code: 'E_CONSTRAINT', message: '非空约束冲突：必填列不能为 NULL' },
  '23514': { code: 'E_CONSTRAINT', message: 'CHECK 约束冲突：数据不满足约束条件' },
  '42501': { code: 'E_PERMISSION', message: '权限不足' },
  '57014': { code: 'E_CANCELED', message: '查询已取消' },
  '40001': { code: 'E_CONFLICT', message: '序列化冲突：事务需重试' },
  '40P01': { code: 'E_CONFLICT', message: '检测到死锁，事务已回滚' },
  '53300': { code: 'E_CAPACITY', message: '连接数超限：服务器负载已满' },
  '57P01': { code: 'E_CONN', message: '数据库服务已关闭' },
  '57P03': { code: 'E_CONN', message: '数据库暂不接受连接' },
};

const CONN_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'ETIMEDOUT',
  'EPIPE',
  'EHOSTUNREACH',
  'EAI_AGAIN',
]);

export function toDriverError(err: unknown): DriverError {
  if (DriverError.is(err)) {
    return err;
  }
  const e = err as { code?: string; message?: string; detail?: string };
  const raw = e.message ?? String(err);
  const detail = [e.code, raw].filter(Boolean).join(' ');

  if (e.code !== undefined && SQLSTATE_MAP[e.code]) {
    const mapped = SQLSTATE_MAP[e.code];
    return new DriverError(mapped.code, mapped.message ?? raw, { detail });
  }
  if (e.code !== undefined && CONN_CODES.has(e.code)) {
    return new DriverError('E_CONN', '无法连接到数据库服务器（网络不可达或拒绝连接）', { detail });
  }
  // pg 建连超时（connectionTimeoutMillis）抛普通 Error，无 code
  if (/timeout exceeded when trying to connect/i.test(raw)) {
    return new DriverError('E_CONN', '连接超时：服务器不可达或拒绝连接', { detail });
  }
  return new DriverError('E_INTERNAL', raw, { detail });
}
