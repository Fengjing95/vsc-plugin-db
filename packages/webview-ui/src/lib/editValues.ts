/**
 * 单元格输入 → 值编码契约（概要设计 §4.4）的传输值。
 * NULL/空串不在此处理（右键切换，交互稿 §4.5）；解析失败返回 error，
 * UI 阻止确认而非静默降级。
 */
export interface ParsedCell {
  ok: boolean;
  value?: unknown;
  error?: string;
}

export function parseCellInput(text: string, type: string): ParsedCell {
  const trimmed = text.trim();
  switch (type) {
    case 'integer': {
      if (!/^-?\d+$/.test(trimmed)) {
        return { ok: false, error: '需要整数' };
      }
      const n = Number(trimmed);
      if (!Number.isSafeInteger(n)) {
        return { ok: false, error: '超出安全整数范围，请使用文本列暂存' };
      }
      return { ok: true, value: n };
    }
    case 'float': {
      if (trimmed === '' || Number.isNaN(Number(trimmed))) {
        return { ok: false, error: '需要数字' };
      }
      return { ok: true, value: Number(trimmed) };
    }
    case 'decimal':
      // 精度保留：字符串原样传输（C-7）
      if (trimmed === '' || Number.isNaN(Number(trimmed))) {
        return { ok: false, error: '需要数字' };
      }
      return { ok: true, value: trimmed };
    case 'boolean': {
      const lower = trimmed.toLowerCase();
      if (lower === 'true' || lower === '1') return { ok: true, value: true };
      if (lower === 'false' || lower === '0') return { ok: true, value: false };
      return { ok: false, error: '需要 true / false' };
    }
    case 'json': {
      if (trimmed === '') {
        return { ok: false, error: 'JSON 不能为空（置 NULL 请用右键菜单）' };
      }
      try {
        return { ok: true, value: JSON.parse(trimmed) as unknown };
      } catch {
        return { ok: false, error: 'JSON 语法错误' };
      }
    }
    case 'binary':
      // 二进制列本就不可编辑（D-03 兜底）
      return { ok: false, error: '二进制列不可编辑' };
    default:
      // string / date / time / datetime / uuid / unknown：字符串原样传输
      return { ok: true, value: text };
  }
}

/** 编辑初始文本：按展示语义还原（NULL 之外的值原样，对象 JSON 化） */
export function cellInputText(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'object') {
    return JSON.stringify(value, null, 2);
  }
  return String(value);
}
