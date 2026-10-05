import type { IConnection } from '@db-explorer/core';

/**
 * 表结构编辑纯函数层（M8-B2，零 vscode 依赖，可单测）：
 * vscode 胶水在 ddlService.ts，此处只放可独立测试的判定/格式化。
 */

/** §6 确认规则（纯函数）：输入与名称完全匹配（trim 后）才放行；undefined = 用户取消 */
export function confirmNameMatch(name: string, input: string | undefined): boolean {
  if (input === undefined) {
    return false;
  }
  return input.trim() === name;
}

/** 标识符引用：驱动 quoteIdentifier 优先，dialect.quote 兜底（驱动规范 §3） */
export function quoteWith(conn: IConnection, name: string): string {
  if (conn.quoteIdentifier) {
    return conn.quoteIdentifier(name);
  }
  const [open, close] = conn.dialect?.quote ?? ['"', '"'];
  return `${open}${name}${close}`;
}
