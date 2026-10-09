import { BSON } from 'mongodb';
import { DriverError } from '@db-explorer/core';

/**
 * cursor 分页游标（驱动规范 §5.5 / D-17）：opaque base64url(BSON)——自包含排序位点与
 * 批内位置（P-27：初始态≠取尽态；客户端不理解/伪造内部状态）。BSON 序列化保真
 * ObjectId/Date/Decimal128 等原生类型，解码后直接可用于 resume 查询文档。
 */

export interface MongoCursorState {
  v: 1;
  /** 最后一行 _id（BSON 原生值） */
  id: unknown;
  /** 排序键（用户 sorts 的列名；缺省 = 纯 _id 分页） */
  sk?: string[];
  /** 排序方向（1=asc / -1=desc，与 sk 对齐） */
  sd?: Array<1 | -1>;
  /** 最后一行排序值（BSON 原生值元组，与 sk 对齐） */
  sv?: unknown[];
}

export function encodeCursor(state: Omit<MongoCursorState, 'v'>): string {
  return Buffer.from(BSON.serialize({ v: 1, ...state })).toString('base64url');
}

export function decodeCursorOrThrow(cursor: string): MongoCursorState {
  let raw: Record<string, unknown>;
  try {
    raw = BSON.deserialize(Buffer.from(cursor, 'base64url')) as Record<string, unknown>;
  } catch {
    throw new DriverError('E_VALIDATION', '分页游标非法，请从首页重新翻页');
  }
  if (!raw || raw.v !== 1 || !('id' in raw)) {
    throw new DriverError('E_VALIDATION', '分页游标非法，请从首页重新翻页');
  }
  return raw as unknown as MongoCursorState;
}

/** 位点重建：无排序 → _id 严格递增；带排序 → 前缀相等 + 末位严格比较 + _id tiebreak（同值不跳行） */
export function resumeFilter(state: Omit<MongoCursorState, 'v'>): Record<string, unknown> {
  const idFilter = { $gt: state.id };
  if (!state.sk || state.sk.length === 0 || !state.sv) {
    return { _id: idFilter };
  }
  const sk = state.sk;
  const sd = state.sd;
  const sv = state.sv;
  const terms: Array<Record<string, unknown>> = [];
  for (let i = 0; i < sk.length; i++) {
    const term: Record<string, unknown> = {};
    for (let j = 0; j < i; j++) {
      term[sk[j]!] = sv[j];
    }
    term[sk[i]!] = { [sd?.[i] === -1 ? '$lt' : '$gt']: sv[i] };
    terms.push(term);
  }
  const tiebreak: Record<string, unknown> = {};
  sk.forEach((k, j) => {
    tiebreak[k] = sv[j];
  });
  tiebreak._id = idFilter;
  terms.push(tiebreak);
  return { $or: terms };
}
