import type { DatabaseMeta } from '@db-explorer/core';

/**
 * 数据库列表筛选显示（ADR D-33）纯函数层。
 *
 * 口径：ConnectionConfig.visibleDatabases = undefined 显示全部（默认）；生效层 = 树展示层
 * 过滤（getChildren(connection) 在 listDatabases 之后），core/driver 零改动——被隐藏库的
 * Console 绑定/执行/护栏不受影响（隐藏 ≠ 禁用）。筛选集合里库被删除后：渲染时忽略失效项，
 * 收敛（交集，按服务端序）由调用方异步落存；交集为空 = 筛选全失效即清除回 undefined。
 */

export interface DbFilterResult {
  /** 过滤后待渲染的库（保持服务端返回序） */
  rows: DatabaseMeta[];
  /** 筛选集合里已不存在于服务端的项（失效条目，仅提示用） */
  stale: string[];
  /** 收敛后应回存的筛选集合（按服务端序）；undefined = 筛选已全失效/应清除 */
  converged: string[] | undefined;
}

/** 树渲染期显示层过滤：visible 为 undefined/空 = 显示全部 */
export function applyDbFilter(dbs: DatabaseMeta[], visible: string[] | undefined): DbFilterResult {
  if (!visible || visible.length === 0) {
    return { rows: dbs, stale: [], converged: undefined };
  }
  const wanted = new Set(visible);
  const rows = dbs.filter((d) => wanted.has(d.name));
  const actual = new Set(dbs.map((d) => d.name));
  const stale = visible.filter((name) => !actual.has(name));
  return { rows, stale, converged: rows.length > 0 ? rows.map((d) => d.name) : undefined };
}

/**
 * QuickPick 应用结果 → 存储值（连接态、有候选列表时）：picked 为空 = 清除；勾选了全部库 =
 * 等价无筛选也清除（避免「已筛选 m/m」假计数）；部分勾选按服务端序收口。
 * 未连接（无候选列表）不走本函数——命令层对既有项 picked 原样落存（全选语义不成立）。
 */
export function visibleDatabasesFromSelection(
  picked: readonly string[] | undefined,
  allNames: readonly string[],
): string[] | undefined {
  if (!picked || picked.length === 0) {
    return undefined;
  }
  const set = new Set(picked);
  const chosen = allNames.filter((n) => set.has(n));
  if (chosen.length === 0) {
    return undefined;
  }
  return chosen.length >= allNames.length ? undefined : chosen;
}
