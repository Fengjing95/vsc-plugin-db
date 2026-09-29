import { z } from 'zod';
import type { DriverErrorCode } from '@db-explorer/core';

export const RPC_PROTOCOL_VERSION = 1;

/** 方法名注册表（概要设计 7.4.2），M0 仅开放 handshake + fetchRows */
export const RpcMethods = {
  handshake: 'sys.handshake',
  fetchRows: 'table.fetchRows',
} as const;

/** RPC 层错误码：复用 DriverErrorCode，仅另加 E_UNKNOWN_METHOD / E_STATE_LOST */
export type RpcErrorCode = DriverErrorCode | 'E_UNKNOWN_METHOD' | 'E_STATE_LOST';

// ── sys.handshake ──────────────────────────────────────────────
export const HandshakeParamsSchema = z.object({
  stateId: z.string().nullable().optional(),
});
export type HandshakeParams = z.infer<typeof HandshakeParamsSchema>;

export const ChangeSetSnapshotSchema = z.object({
  inserts: z.array(z.unknown()),
  updates: z.array(z.unknown()),
  deletes: z.array(z.unknown()),
});

export const HandshakeResultSchema = z.object({
  protocolVersion: z.number(),
  viewId: z.string(),
  params: z.record(z.string(), z.string()),
  changeSet: ChangeSetSnapshotSchema,
});
export type HandshakeResult = z.infer<typeof HandshakeResultSchema>;

// ── table.fetchRows ────────────────────────────────────────────
export const FetchRowsParamsSchema = z.object({
  connId: z.string().min(1),
  db: z.string().min(1),
  obj: z.string().min(1),
  limit: z.number().int().positive().max(5000),
  offset: z.number().int().min(0).optional(),
});
export type FetchRowsParams = z.infer<typeof FetchRowsParamsSchema>;

export const ResultSetSchema = z.object({
  columns: z.array(z.object({ name: z.string(), type: z.string() })),
  rows: z.array(z.array(z.unknown())),
  rowCount: z.number().int(),
  totalCount: z.number().int().optional(),
  primaryKey: z.array(z.string()).optional(),
  executionMs: z.number(),
  truncated: z.boolean().optional(),
});
export type ResultSetPayload = z.infer<typeof ResultSetSchema>;
