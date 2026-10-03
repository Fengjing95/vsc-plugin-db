/**
 * 保存查询（概要设计 §5.5.2 P1）：Console SQL 保存到工作区 `.vscode/db-queries/*.sql`。
 * 纯函数层（文件名消毒 / 默认命名 / 摘要），VSCode 交互在 savedQueryActions.ts
 * （约定：含 vscode import 的模块不进单测，纯函数层保持可测）。
 */

/** 文件名非法字符（跨平台：Windows 保留字符 + 路径分隔符 + 控制字符——消毒正是其用途） */
// eslint-disable-next-line no-control-regex
const INVALID_FILE_CHARS = /[/\\:*?"<>|\u0000-\u001f]/g;

/** 用户输入的名称 → 安全的文件名（不含 .sql 后缀） */
export function sanitizeQueryFileName(input: string): string {
  const cleaned = input
    .replace(INVALID_FILE_CHARS, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '') // 防止 ".."/"." 等路径穿越形态
    .trim();
  return cleaned.slice(0, 80);
}

/** 文本首条非空行 → 默认查询名（截断 32 字符；无内容时退回时间戳名） */
export function defaultQueryName(text: string, now = new Date()): string {
  const firstLine = text
    .split('\n')
    .map((l) => l.replace(/--.*$/, '').trim()) // 去行注释后取首个非空行
    .find((l) => l.length > 0);
  if (!firstLine) {
    return timestampQueryName(now);
  }
  const base = sanitizeQueryFileName(firstLine);
  if (!base) {
    return timestampQueryName(now);
  }
  return base.length > 32 ? `${base.slice(0, 32)}…` : base;
}

/** 时间戳兜底名：query-20261003-173605 */
export function timestampQueryName(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `query-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
}

/** 查询文件摘要（打开选择器的 detail）：首个非空、非注释行，截断 60 字符 */
export function querySummary(text: string): string {
  const line = text
    .split('\n')
    .map((l) => l.replace(/--.*$/, '').trim())
    .find((l) => l.length > 0);
  if (!line) {
    return '(空)';
  }
  return line.length > 60 ? `${line.slice(0, 60)}…` : line;
}

