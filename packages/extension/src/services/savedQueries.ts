/**
 * 保存查询（概要设计 §5.5.2 P1）：Console SQL 保存到查询目录（默认扩展全局存储，可配置，不与工作区绑定）。
 * 纯函数层（文件名消毒 / 默认命名 / 摘要 / 目录设置展开），VSCode 交互在 savedQueryActions.ts
 * （约定：含 vscode import 的模块不进单测，纯函数层保持可测）。
 */
import { isAbsolute } from 'node:path';
import { t } from './i18n';

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

/** 树「查询」目录的默认名：query_<13 位毫秒时间戳>（Date.now() 口径） */
export function newQueryDefaultName(now = Date.now()): string {
  return `query_${now}`;
}

/** 剥离 .sql 后缀（用户输入与树显示共用；大小写不敏感） */
export function stripSqlSuffix(input: string): string {
  return input.replace(/\.sql$/i, '');
}

/** 查询文件名 → 树显示名（不含 .sql 后缀） */
export function queryLabel(fileName: string): string {
  return stripSqlSuffix(fileName);
}

/** 连接 id / 数据库名 → 目录路径段（消毒防路径穿越与非法字符；清空后兜底 '_' 保证段非空） */
export function queryPathSegment(input: string): string {
  return sanitizeQueryFileName(input).trim() || '_';
}

/**
 * 查询目录配置值展开：`~/` 前缀替换为用户主目录（如 ~/Documents/db-queries）；
 * 空值或非绝对路径返回空串（调用方回退扩展全局存储默认目录）。
 */
export function expandQueryDirectory(input: string, home: string): string {
  const t = input.trim();
  if (!t) {
    return '';
  }
  const expanded = t === '~' || t.startsWith('~/') ? home + t.slice(1) : t;
  return isAbsolute(expanded) ? expanded : '';
}

/** 查询文件摘要（打开选择器的 detail）：首个非空、非注释行，截断 60 字符 */
export function querySummary(text: string): string {
  const line = text
    .split('\n')
    .map((l) => l.replace(/--.*$/, '').trim())
    .find((l) => l.length > 0);
  if (!line) {
    return t('(空)');
  }
  return line.length > 60 ? `${line.slice(0, 60)}…` : line;
}

