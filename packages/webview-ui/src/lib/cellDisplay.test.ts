import { describe, expect, it } from 'vitest';
import { cellView } from './cellDisplay';

describe('cellView（交互稿 §4.2 单元格视觉规范）', () => {
  it('NULL：灰斜体 NULL，与空串区分', () => {
    expect(cellView(null, 'string')).toEqual({
      text: 'NULL',
      className: 'text-muted-foreground italic',
    });
  });

  it('空串：灰色中点', () => {
    expect(cellView('', 'string')).toEqual({ text: '·', className: 'text-muted-foreground' });
  });

  it('二进制：🔒 + 字节数（base64 → 字节换算）', () => {
    const view = cellView('aGVsbG8=', 'binary'); // 8 base64 chars → 6 bytes
    expect(view.text).toBe('🔒 <binary, 6 bytes>');
  });

  it('JSON 对象：原文截断 + tooltip', () => {
    const view = cellView({ a: 1 }, 'json');
    expect(view.text).toBe('{"a":1}');
    expect(view.title).toBe('{"a":1}');
  });

  it('超长 JSON：截断加省略号', () => {
    const big = { s: 'x'.repeat(3000) };
    const view = cellView(big, 'json');
    expect(view.text).toContain('…');
    expect(view.text.length).toBeLessThan(2100);
  });

  it('DATETIME：tooltip 标注按连接时区解释', () => {
    expect(cellView('2024-01-01 08:00:00', 'datetime').title).toBe('按连接会话时区解释');
  });

  it('普通文本：原样', () => {
    expect(cellView('张三', 'string').text).toBe('张三');
  });
});
