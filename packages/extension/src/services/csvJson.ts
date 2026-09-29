/**
 * 导出序列化纯函数（概要设计 5.7）。零 vscode 依赖，便于单测。
 * CSV 遵循 RFC 4180：字段含逗号/引号/换行时加引号，内部引号翻倍。
 */

/** RFC 4180 字段转义；值编码契约（概要设计 4.4）：NULL → 空串，JSON → 原文，二进制 → base64 原样 */
export function csvEscapeField(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  let s: string;
  if (typeof value === 'object') {
    s = JSON.stringify(value);
  } else {
    s = String(value);
  }
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export function csvRow(fields: unknown[]): string {
  return fields.map(csvEscapeField).join(',') + '\r\n';
}

/** 行式数组 → 对象（JSON 导出格式：列名 → 值） */
export function toJsonObject(columns: string[], row: unknown[]): Record<string, unknown> {
  const obj: Record<string, unknown> = {};
  columns.forEach((name, i) => {
    obj[name] = row[i] ?? null;
  });
  return obj;
}

/** 导出文件名清理：非法字符替换为下划线 */
export function safeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '_');
}
