import { DriverError } from '@db-explorer/core';

/**
 * 原生错误 → DriverError 映射（驱动开发规范 §6 Redis 行）：
 * - NOAUTH / WRONGPASS / AUTH 错误 → E_AUTH
 * - WRONGTYPE / unknown command → E_UNSUPPORTED
 * - cluster 副本读写拒绝（READONLY）→ E_READONLY
 * - 连接失败 / 中断 → E_CONN（可重试）
 * message 面向用户、不含原始报错（防泄漏 DSN/凭证）；原始摘要进 detail（已脱敏）。
 */

const CONN_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'ETIMEDOUT',
  'EPIPE',
  'EHOSTUNREACH',
  'EAI_AGAIN',
]);

interface RawError {
  code?: string;
  message?: string;
  name?: string;
}

export function toRedisError(err: unknown): DriverError {
  if (DriverError.is(err)) {
    return err;
  }
  // 重连耗尽包装（P-26 同族）：node-redis 重连次数用尽抛 ReconnectStrategyError，
  // message 是策略自撰文案，真实原因在 socketError——解包后按原生错误映射
  const socketErr = (err as { socketError?: unknown } | null)?.socketError;
  if (socketErr instanceof Error) {
    return toRedisError(socketErr);
  }
  const e = (err ?? {}) as RawError;
  const raw = e.message ?? String(err);
  const detail = [e.code, raw].filter(Boolean).join(' ');

  // 前缀类错误（Redis 错误回复以错误类别开头）
  if (/^NOAUTH\b/i.test(raw) || /^WRONGPASS\b/i.test(raw) || /^ERR Client sent AUTH/i.test(raw)) {
    return new DriverError('E_AUTH', '认证失败：请检查用户名/密码', { detail });
  }
  if (/^WRONGTYPE\b/i.test(raw)) {
    return new DriverError('E_UNSUPPORTED', '键类型与命令不匹配（WRONGTYPE）', { detail });
  }
  if (/^READONLY\b/i.test(raw)) {
    return new DriverError('E_READONLY', '副本节点拒绝读写，请连接主节点', { detail });
  }
  if (/^NOPERM\b/i.test(raw)) {
    return new DriverError('E_PERMISSION', '当前用户权限不足', { detail });
  }
  if (/^OOM\b/i.test(raw)) {
    return new DriverError('E_CAPACITY', '服务器内存已达上限，命令被拒绝', { detail });
  }
  if (/^BUSY\b/i.test(raw) || /^LOADING\b/i.test(raw)) {
    return new DriverError('E_TIMEOUT', '服务器繁忙（加载/脚本执行中），请稍后重试', { detail });
  }
  if (/^ERR unknown command/i.test(raw)) {
    return new DriverError('E_UNSUPPORTED', '服务器不识别该命令', { detail });
  }
  if (/^ERR wrong number of arguments/i.test(raw) || /^ERR syntax error/i.test(raw) || /^ERR (value|bit|offset|increment|timeout) is not/i.test(raw)) {
    return new DriverError('E_SYNTAX', '命令语法或参数错误', { detail });
  }

  // node-redis 客户端层错误
  if (e.code !== undefined && CONN_CODES.has(e.code)) {
    return new DriverError('E_CONN', '无法连接到 Redis 服务器（网络不可达或拒绝连接）', { detail });
  }
  // TLS 握手失败（OpenSSL 错误：证书校验不通过 / 明文连到 TLS 端口等）→ 建连类错误（E_CONN），
  // 文案给出可操作建议；detail 保留原始摘要（已不含凭证）
  if (e.code !== undefined && /^(ERR_SSL|ERR_TLS|ERR_OSSL|ERR_CERT|UNABLE_TO_VERIFY_LEAF_SIGNATURE|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|CERT_HAS_EXPIRED)/i.test(e.code)) {
    return new DriverError(
      'E_CONN',
      /insecure|self[- ]signed|unable to verify|certificate/i.test(raw)
        ? 'TLS 证书校验未通过：服务器使用了自签/私有 CA 证书。受信内网可在连接的高级选项开启「跳过证书校验」'
        : 'TLS 握手失败：请确认端口为 TLS 端口且已开启「SSL/TLS 加密连接」',
      { detail },
    );
  }
  if (/self signed certificate|unable to verify the first certificate|certificate verify failed|wrong version number/i.test(raw)) {
    return new DriverError('E_CONN', 'TLS 握手失败：证书校验未通过或端口非 TLS', { detail });
  }
  if (e.name === 'ClientClosedError' || e.name === 'SocketClosedUnexpectedlyError' || /client is closed|connection (is )?closed|socket closed/i.test(raw)) {
    return new DriverError('E_CONN', 'Redis 连接已关闭或中断', { detail });
  }
  if (e.name === 'TimeoutError' || e.name === 'SocketTimeoutError') {
    return new DriverError('E_TIMEOUT', '命令执行超时，可在设置中调整', { detail });
  }
  if (e.name === 'ConnectionTimeoutError') {
    return new DriverError('E_CONN', '连接超时：无法在限定时间内连上 Redis 服务器', { detail });
  }
  if (/auth/i.test(raw)) {
    return new DriverError('E_AUTH', '认证失败：请检查用户名/密码', { detail });
  }
  return new DriverError('E_INTERNAL', raw, { detail });
}
