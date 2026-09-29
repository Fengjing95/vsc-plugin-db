import { z } from 'zod';

/**
 * RPC 帧格式（概要设计 7.4.1）：单一 postMessage 通道，三类帧。
 * 双端运行时校验（ADR D-06）：Host 校验请求，Webview 校验响应。
 */
export const RpcRequestSchema = z.object({
  kind: z.literal('req'),
  id: z.string().min(1),
  method: z.string().min(1),
  params: z.unknown().optional(),
});
export type RpcRequest = z.infer<typeof RpcRequestSchema>;

export const RpcErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  detail: z.string().optional(),
});
export type RpcError = z.infer<typeof RpcErrorSchema>;

export const RpcResponseSchema = z.object({
  kind: z.literal('res'),
  id: z.string(),
  ok: z.boolean(),
  result: z.unknown().optional(),
  error: RpcErrorSchema.optional(),
});
export type RpcResponse = z.infer<typeof RpcResponseSchema>;

export const RpcEventSchema = z.object({
  kind: z.literal('evt'),
  event: z.string(),
  payload: z.unknown().optional(),
});
export type RpcEvent = z.infer<typeof RpcEventSchema>;

export type RpcFrame = RpcRequest | RpcResponse | RpcEvent;

export function isRpcFrame(data: unknown): data is RpcFrame {
  if (typeof data !== 'object' || data === null) {
    return false;
  }
  const kind = (data as { kind?: unknown }).kind;
  return kind === 'req' || kind === 'res' || kind === 'evt';
}
