import { DriverError } from '@db-explorer/core';

/**
 * 原生错误 → DriverError 映射（驱动开发规范 §6，UI 只认 code 不解析 message）。
 * sql.js 抛普通 Error，消息即 SQLite 错误名（如 "UNIQUE constraint failed: t.id"）——
 * 按消息特征映射，最后 E_INTERNAL fail-closed（如上游出现 SQLITE_* 错误码则优先精确匹配）。
 */
export function toDriverError(err: unknown): DriverError {
  if (DriverError.is(err)) {
    return err;
  }
  const e = err as { code?: string; message?: string };
  const raw = e.message ?? String(err);
  const detail = [e.code, raw].filter(Boolean).join(' ');
  const nativeCode = e.code ?? '';

  if (nativeCode.startsWith('SQLITE_CONSTRAINT') || /constraint failed/i.test(raw)) {
    return new DriverError('E_CONSTRAINT', constraintMessage(raw), { detail });
  }
  if (/no such table/i.test(raw)) {
    return new DriverError('E_NOT_FOUND', '表不存在，可能已被删除', { detail });
  }
  if (/no such column/i.test(raw)) {
    return new DriverError('E_NOT_FOUND', '列不存在，请检查列名', { detail });
  }
  if (/no such function/i.test(raw)) {
    return new DriverError('E_NOT_FOUND', '函数不存在，请检查拼写', { detail });
  }
  if (/syntax error|incomplete input|one statement at a time|multiple statements/i.test(raw)) {
    return new DriverError('E_SYNTAX', 'SQL 语法错误（或一次执行了多条语句）', { detail });
  }
  if (/readonly database|attempt to write/i.test(raw)) {
    return new DriverError('E_READONLY', '数据库以只读方式打开，拒绝写入', { detail });
  }
  if (/database is locked|database table is locked/i.test(raw)) {
    return new DriverError('E_TIMEOUT', '数据库被其他进程锁定，请稍后重试', { detail });
  }
  if (/unable to open database file/i.test(raw)) {
    return new DriverError('E_CONN', '无法打开数据库文件（路径不可达或权限不足）', { detail });
  }
  if (/file is not a database|not a database/i.test(raw)) {
    return new DriverError('E_VALIDATION', '不是有效的 SQLite 数据库文件', { detail });
  }
  if (/disk i\/o error|disk full|out of memory/i.test(raw)) {
    return new DriverError('E_CAPACITY', '磁盘/内存资源不足，操作被拒绝', { detail });
  }
  return new DriverError('E_INTERNAL', raw, { detail });
}

function constraintMessage(raw: string): string {
  if (/unique constraint/i.test(raw)) return '唯一键冲突：数据重复或已被他人修改';
  if (/foreign key constraint/i.test(raw)) return '外键约束冲突：引用的数据不存在';
  if (/not null constraint/i.test(raw)) return '非空约束冲突：必填列不能为 NULL';
  if (/check constraint/i.test(raw)) return 'CHECK 约束冲突：数据不满足约束条件';
  return '约束冲突：数据不满足表的约束条件';
}
