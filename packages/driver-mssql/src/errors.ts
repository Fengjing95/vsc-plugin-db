import { DriverError, type DriverErrorCode } from '@db-explorer/core';

/**
 * 原生错误 → DriverError 映射（驱动开发规范 §6，UI 只认 code 不解析 message）。
 * mssql 的错误分层：连接/请求级错误带 code（ELOGIN/ECANCEL/ETIMEOUT/ESOCKET…）；
 * 服务端 SQL 错误经 EREQUEST 透出，真实错误在 number（T-SQL 错误号）——先按 code 精确表、
 * 再按 number 映射表、最后按消息特征（建连超时无码）。
 */
const CODE_MAP: Record<string, { code: DriverErrorCode; message?: string }> = {
  ELOGIN: { code: 'E_AUTH', message: '认证失败：请检查用户名/密码' },
  ECANCEL: { code: 'E_CANCELED', message: '查询已取消' },
  EPERM: { code: 'E_PERMISSION', message: '权限不足' },
  ECONNREFUSED: { code: 'E_CONN', message: '无法连接到数据库服务器（拒绝连接）' },
  ECONNRESET: { code: 'E_CONN', message: '连接被重置' },
  ENOTFOUND: { code: 'E_CONN', message: '无法解析数据库主机名' },
  EPIPE: { code: 'E_CONN', message: '连接已中断' },
  EHOSTUNREACH: { code: 'E_CONN', message: '数据库主机不可达' },
  ETIMEDOUT: { code: 'E_CONN', message: '连接超时：服务器不可达或拒绝连接' },
  ESOCKET: { code: 'E_CONN', message: '连接套接字错误（网络中断或服务不可达）' },
  ENOTOPEN: { code: 'E_CONN', message: '连接未建立或已关闭' },
  ECONNCLOSED: { code: 'E_CONN', message: '连接已关闭' },
  ENOCONN: { code: 'E_CONN', message: '无可用连接' },
  EALREADYCONNECTING: { code: 'E_CONN', message: '连接正在建立中' },
  EINSTLOOKUP: { code: 'E_CONN', message: 'SQL Server 实例解析失败（命名实例/Browser 服务不可达）' },
  EARGS: { code: 'E_VALIDATION', message: '请求参数非法' },
  EINJECT: { code: 'E_VALIDATION', message: '参数名非法' },
  ETIMEOUT: { code: 'E_TIMEOUT', message: '语句执行超时' },
  ENOBACKUP: { code: 'E_INTERNAL', message: '驱动内部错误' },
};

/** T-SQL 服务端错误号（EREQUEST 的 number）→ DriverErrorCode */
const NUMBER_MAP: Record<number, { code: DriverErrorCode; message?: string }> = {
  208: { code: 'E_NOT_FOUND', message: '表不存在，可能已被删除' },
  4060: { code: 'E_NOT_FOUND', message: '数据库不存在或不可访问' },
  102: { code: 'E_SYNTAX', message: 'SQL 语法错误' },
  105: { code: 'E_SYNTAX', message: 'SQL 语法错误（字符串未闭合）' },
  113: { code: 'E_SYNTAX', message: '缺少结束注释标记' },
  156: { code: 'E_SYNTAX', message: 'SQL 语法错误（关键字附近）' },
  207: { code: 'E_SYNTAX', message: '列名不存在，请检查拼写' },
  515: { code: 'E_CONSTRAINT', message: '非空约束冲突：必填列不能为 NULL' },
  2601: { code: 'E_CONSTRAINT', message: '唯一键冲突：数据已被他人修改或重复' },
  2627: { code: 'E_CONSTRAINT', message: '唯一键冲突：数据已被他人修改或重复' },
  547: { code: 'E_CONSTRAINT', message: '外键/CHECK 约束冲突：引用的数据不存在或不满足约束' },
  1205: { code: 'E_CONFLICT', message: '事务死锁，已被服务端回滚：请重试' },
  1222: { code: 'E_TIMEOUT', message: '锁等待超时，事务可能被其他会话占用' },
  229: { code: 'E_PERMISSION', message: '权限不足（对象访问被拒绝）' },
  230: { code: 'E_PERMISSION', message: '权限不足（列访问被拒绝）' },
  18456: { code: 'E_AUTH', message: '认证失败：请检查用户名/密码' },
  18452: { code: 'E_AUTH', message: '认证失败：登录凭据与服务器信任关系不符' },
};

export function toDriverError(err: unknown): DriverError {
  if (DriverError.is(err)) {
    return err;
  }
  const e = err as { code?: string; number?: number; message?: string };
  const raw = e.message ?? String(err);
  const detail = [e.code, e.number !== undefined ? `number=${e.number}` : '', raw].filter(Boolean).join(' ');

  // 服务端 SQL 错误：mssql 以 EREQUEST 包装，真实错误号在 number
  if (e.code === 'EREQUEST') {
    const mapped = e.number !== undefined ? NUMBER_MAP[e.number] : undefined;
    if (mapped) {
      return new DriverError(mapped.code, mapped.message ?? raw, { detail });
    }
    return new DriverError('E_INTERNAL', raw, { detail });
  }

  if (e.code !== undefined) {
    const mapped = CODE_MAP[e.code];
    if (mapped) {
      // ETIMEOUT 双义：建连阶段（Failed to connect …）→ E_CONN；请求阶段 → E_TIMEOUT
      if (e.code === 'ETIMEOUT' && /failed to connect/i.test(raw)) {
        return new DriverError('E_CONN', '连接超时：服务器不可达或拒绝连接', { detail });
      }
      return new DriverError(mapped.code, mapped.message ?? raw, { detail });
    }
  }
  return new DriverError('E_INTERNAL', raw, { detail });
}
