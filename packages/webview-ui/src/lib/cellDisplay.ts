/**
 * 单元格渲染规范（交互稿 §4.2 + 值编码契约 概要设计 §4.4）：
 * NULL 灰斜体、空串灰点、二进制 🔒、JSON 截断原文、超长文本省略。
 * 纯函数，便于单测；颜色只用语义 token（--vscode-* 映射）。
 */
import { t } from './i18n';

/** JSON / 超长文本的 JS 级截断上限（视觉省略另由 CSS ellipsis 处理） */
const MAX_TEXT = 2000;

export interface CellView {
  text: string;
  /** 追加的语义 class（颜色/斜体），基于 tokens.css token */
  className?: string;
  /** 原生 tooltip（超长文本/日期时间时区说明） */
  title?: string;
}

export function cellView(value: unknown, type: string, truncated = false): CellView {
  if (value === null || value === undefined) {
    return { text: 'NULL', className: 'text-muted-foreground italic' };
  }
  if (typeof value === 'string' && value === '') {
    return { text: '·', className: 'text-muted-foreground' };
  }
  if (type === 'binary' && typeof value === 'string') {
    // 值编码契约：binary 为 base64 字符串；截断单元格字节数为下界估计（ADR D-30）
    const bytes = Math.floor((value.length * 3) / 4);
    return {
      text: truncated ? `🔒 <binary, ${bytes}+ bytes>` : `🔒 <binary, ${bytes} bytes>`,
      className: 'text-muted-foreground',
    };
  }
  if (typeof value === 'object') {
    const raw = JSON.stringify(value) ?? '';
    return {
      text: raw.length > MAX_TEXT ? raw.slice(0, MAX_TEXT) + '…' : raw,
      className: 'font-mono text-link',
      title: raw,
    };
  }
  if (type === 'datetime' || type === 'timestamptz') {
    return { text: String(value), title: t('table.cell.timezoneNote') };
  }
  if (typeof value === 'boolean') {
    return { text: value ? 'true' : 'false' };
  }
  const text = String(value);
  // 截断前缀（cellMaxChars）对 DOM 文本/tooltip 设上限（防 256K 字符进 DOM，ADR D-30）；
  // 未截断单元格维持原行为（视觉省略另由 CSS ellipsis 处理）
  const capped = truncated && text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) + '…' : text;
  const title = truncated && text.length > MAX_TEXT ? capped : text;
  return { text: capped, title: title.length > 40 ? title : undefined };
}
