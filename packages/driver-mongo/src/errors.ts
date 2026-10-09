import { DriverError, type DriverErrorCode } from '@db-explorer/core';

/** 原生错误 → DriverError 映射（驱动规范 §6 MongoDB 行；UI 只认 code 不解析 message） */

type MongoLike = { name?: string; code?: number | string; message?: string };

/** 连接串凭据打码（C-10：detail 不携带密码） */
function sanitize(message: string): string {
  return message.replace(/\/\/([^@/\s]+)@/g, '//***@');
}

function wrap(code: DriverErrorCode, message: string, err: unknown): DriverError {
  return new DriverError(code, message, {
    detail: sanitize(String((err as MongoLike)?.message ?? err)),
    cause: err,
  });
}

function serverError(e: MongoLike, err: unknown): DriverError {
  switch (e.code) {
    case 11000:
    case 11001:
    case 12582:
      return wrap('E_CONSTRAINT', '唯一键冲突（重复键）', err);
    case 116:
    case 121:
      return wrap('E_CONSTRAINT', '文档校验失败（document validation）', err);
    case 13:
      return wrap('E_PERMISSION', '权限不足：当前用户无权执行该操作', err);
    case 18:
      return wrap('E_AUTH', '认证失败：请检查用户名/密码/认证库', err);
    case 26:
    case 73:
      return wrap('E_NOT_FOUND', '命名空间（库/collection）不存在', err);
    case 50:
      return wrap('E_TIMEOUT', '操作超时（MaxTimeMS）', err);
    default:
      return wrap('E_INTERNAL', 'MongoDB 服务端错误', err);
  }
}

export function toMongoError(err: unknown): DriverError {
  if (DriverError.is(err)) {
    return err;
  }
  const e = (err ?? {}) as MongoLike;
  const message = e.message ?? String(err);
  switch (e.name) {
    case 'MongoServerSelectionError':
      return /authentication failed/i.test(message)
        ? wrap('E_AUTH', '认证失败：请检查用户名/密码/认证库', err)
        : wrap('E_CONN', '无法连接到 MongoDB 服务器（无可达节点）', err);
    case 'MongoParseError':
      return wrap('E_VALIDATION', '连接串解析失败', err);
    case 'MongoNetworkError':
      return wrap('E_CONN', '网络错误：连接中断或不可达', err);
    case 'MongoNetworkTimeoutError':
      return wrap('E_TIMEOUT', '网络超时', err);
    case 'MongoOperationTimeoutError':
      return wrap('E_TIMEOUT', '操作超时', err);
    case 'MongoAbortError':
      return wrap('E_CANCELED', '已取消', err);
    case 'MongoInvalidArgumentError':
      return wrap('E_VALIDATION', '参数非法', err);
    case 'MongoNotConnectedError':
    case 'MongoTopologyClosedError':
      return wrap('E_CONN', '连接已断开', err);
    case 'MongoServerError':
      return serverError(e, err);
    default:
      break;
  }
  switch (e.code) {
    case 'ECONNREFUSED':
    case 'ECONNRESET':
    case 'ENOTFOUND':
    case 'EHOSTUNREACH':
    case 'EPIPE':
      return wrap('E_CONN', '无法连接到 MongoDB 服务器', err);
    case 'ETIMEDOUT':
      return wrap('E_TIMEOUT', '连接超时', err);
    default:
      return wrap('E_INTERNAL', 'MongoDB 驱动内部错误', err);
  }
}
