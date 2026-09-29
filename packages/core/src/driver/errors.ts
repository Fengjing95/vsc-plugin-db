/** 统一错误码（驱动开发规范 §6）——UI 只认 code，不解析 message */
export type DriverErrorCode =
  | 'E_CONN'
  | 'E_AUTH'
  | 'E_TIMEOUT'
  | 'E_CANCELED'
  | 'E_READONLY'
  | 'E_CONFLICT'
  | 'E_CONSTRAINT'
  | 'E_SYNTAX'
  | 'E_PERMISSION'
  | 'E_NOT_FOUND'
  | 'E_VALIDATION'
  | 'E_UNSUPPORTED'
  | 'E_CAPACITY'
  | 'E_INTERNAL';

const RETRYABLE_CODES = new Set<DriverErrorCode>(['E_CONN', 'E_TIMEOUT']);

/** 变更集失败定位（驱动规范 §8-1：抛出首个错误须含 kind/tempId/rowKey） */
export interface ChangeErrorMeta {
  kind?: 'insert' | 'update' | 'delete';
  tempId?: string;
  rowKey?: Record<string, unknown>;
}

export class DriverError extends Error {
  readonly code: DriverErrorCode;
  /** 原始错误摘要（已脱敏） */
  readonly detail?: string;
  readonly retryable: boolean;
  /** 变更集失败定位（Host 转 evt:row.error 高亮错误行） */
  readonly meta?: ChangeErrorMeta;

  constructor(
    code: DriverErrorCode,
    message: string,
    opts?: { detail?: string; cause?: unknown; meta?: ChangeErrorMeta },
  ) {
    super(message, opts?.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = 'DriverError';
    this.code = code;
    this.detail = opts?.detail;
    this.meta = opts?.meta;
    this.retryable = RETRYABLE_CODES.has(code);
  }

  static is(err: unknown): err is DriverError {
    return err instanceof DriverError;
  }
}
