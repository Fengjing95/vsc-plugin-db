/**
 * 单元格查看器纯函数（交互稿 §4.6）：大文本 / JSON / 二进制三种形态的
 * 分类、图片嗅探、hex 视图与 JSON 编辑校验。纯函数便于单测；
 * 保存写回 ChangeSet 复用 editValues.parseCellInput + tableStore.confirmParsed 管线。
 */
import { t } from './i18n';

/** 超长文本进入查看器的阈值（§4.2：截断 + ▤ 角标；与 cellDisplay 的 JS 截断上限独立） */
export const VIEWER_MIN_TEXT = 200;

/** 二进制 hex 视图转储上限（§4.6：前 64KB） */
export const HEX_VIEW_MAX_BYTES = 64 * 1024;

export type ViewerKind = 'text' | 'json' | 'binary';

/** 该单元格是否值得开查看器，以及开哪一种（NULL 不可开；新增行由调用方屏蔽） */
export function viewerKindFor(type: string, value: unknown): ViewerKind | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (type === 'binary') {
    return typeof value === 'string' ? 'binary' : null;
  }
  if (type === 'json') {
    return typeof value === 'object' ? 'json' : null;
  }
  if (typeof value === 'string' && value.length > VIEWER_MIN_TEXT) {
    return 'text';
  }
  return null;
}

/** 图片预嗅探（§4.6：PNG/JPEG/GIF 头直接预览；base64 前 16 字符对齐切片，避免整体解码） */
export function sniffImageKind(base64: string): 'png' | 'jpeg' | 'gif' | null {
  let bin: string;
  try {
    bin = atob(base64.slice(0, 16));
  } catch {
    return null;
  }
  const b = (i: number) => (i < bin.length ? bin.charCodeAt(i) : -1);
  if (
    b(0) === 0x89 &&
    b(1) === 0x50 &&
    b(2) === 0x4e &&
    b(3) === 0x47 &&
    b(4) === 0x0d &&
    b(5) === 0x0a &&
    b(6) === 0x1a &&
    b(7) === 0x0a
  ) {
    return 'png';
  }
  if (b(0) === 0xff && b(1) === 0xd8 && b(2) === 0xff) {
    return 'jpeg';
  }
  if (b(0) === 0x47 && b(1) === 0x49 && b(2) === 0x46 && b(3) === 0x38 && b(5) === 0x61) {
    return 'gif'; // GIF87a / GIF89a（6 字节头，跳过版本位 b(4)）
  }
  return null;
}

/**
 * hex 视图（§4.6 只读）：`偏移(8)  hex×16  ASCII` 三段式，每行 16 字节；
 * 只转储前 maxBytes 字节（64KB 口径），不可打印字节以 . 呈现。
 */
export function hexDump(base64: string, maxBytes: number = HEX_VIEW_MAX_BYTES): string {
  let bin: string;
  try {
    bin = atob(base64.slice(0, Math.ceil(maxBytes / 3) * 4));
  } catch {
    return '';
  }
  const total = Math.min(bin.length, maxBytes);
  const lines: string[] = [];
  for (let off = 0; off < total; off += 16) {
    const slice = bin.slice(off, Math.min(off + 16, total));
    const tokens: string[] = [];
    let ascii = '';
    for (let i = 0; i < slice.length; i++) {
      const code = slice.charCodeAt(i);
      tokens.push(code.toString(16).padStart(2, '0').toUpperCase());
      ascii += code >= 0x20 && code <= 0x7e ? String.fromCharCode(code) : '.';
    }
    lines.push(
      `${off.toString(16).padStart(8, '0').toUpperCase()}  ${tokens.join(' ').padEnd(47, ' ')}  ${ascii}`,
    );
  }
  return lines.join('\n');
}

/** JSON 原文编辑校验（保存按钮禁用 + 行内提示的依据；null 字面量 = C-7 的 NULL） */
export function parseJsonText(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  const trimmed = text.trim();
  if (trimmed === '') {
    return { ok: false, error: t('table.viewer.jsonEmpty') };
  }
  try {
    return { ok: true, value: JSON.parse(trimmed) as unknown };
  } catch {
    return { ok: false, error: t('table.viewer.jsonSyntax') };
  }
}

/** 对象格式化为缩进原文（JSON 原文编辑态与大文本「格式化」的初始文本） */
export function prettyJson(value: unknown): string {
  return JSON.stringify(value, null, 2) ?? '';
}
