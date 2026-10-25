import { describe, expect, it } from 'vitest';
import {
  HEX_VIEW_MAX_BYTES,
  hexDump,
  parseJsonText,
  prettyJson,
  sniffImageKind,
  viewerKindFor,
} from './cellViewer';

const b64 = (bytes: number[]) => Buffer.from(bytes).toString('base64');

describe('cellViewer（交互稿 §4.6 查看器弹层）', () => {
  it('viewerKindFor：binary/json 类型直开；超长文本开、短文本不开；NULL 不可开', () => {
    expect(viewerKindFor('binary', 'aGVsbG8=')).toBe('binary');
    expect(viewerKindFor('json', { a: 1 })).toBe('json');
    expect(viewerKindFor('string', 'x'.repeat(201))).toBe('text');
    expect(viewerKindFor('string', '短文本')).toBeNull();
    expect(viewerKindFor('integer', 42)).toBeNull();
    expect(viewerKindFor('string', null)).toBeNull();
    expect(viewerKindFor('binary', null)).toBeNull();
  });

  it('sniffImageKind：PNG/JPEG/GIF 头嗅探，其余 null', () => {
    expect(sniffImageKind(b64([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]))).toBe('png');
    expect(sniffImageKind(b64([0xff, 0xd8, 0xff, 0xe0, 0, 0]))).toBe('jpeg');
    expect(sniffImageKind(b64([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]))).toBe('gif'); // GIF89a
    expect(sniffImageKind(b64([0x25, 0x50, 0x44, 0x46]))).toBeNull(); // %PDF
    expect(sniffImageKind('aGVsbG8=')).toBeNull();
  });

  it('hexDump：offset + hex + ASCII 三段式，短行右侧补齐', () => {
    const line = hexDump(b64([0x68, 0x65, 0x6c, 0x6c, 0x6f]), HEX_VIEW_MAX_BYTES);
    expect(line.split('\n')).toHaveLength(1);
    // offset(8) + 双空格 + 16 字节位（每字节 2 hex + 1 空格，共 47）+ 双空格 + ASCII
    expect(line.startsWith('00000000  68 65 6C 6C 6F')).toBe(true);
    expect(line.endsWith('hello')).toBe(true);
    expect(line.length).toBe(8 + 2 + 47 + 2 + 5);
  });

  it('hexDump：超过 maxBytes 只转储前 N 字节（前 64KB 口径）', () => {
    const bytes = Array.from({ length: 40 }, (_, i) => i);
    const text = hexDump(b64(bytes), 16);
    expect(text.split('\n')).toHaveLength(1);
    expect(text).not.toContain('00000010');
    expect(text).toContain('00000000  00 01 02 03 04 05 06 07 08 09 0A 0B 0C 0D 0E 0F');
  });

  it('hexDump：不可打印字节以 . 呈现', () => {
    const line = hexDump(b64([0x00, 0x41, 0x7f]), HEX_VIEW_MAX_BYTES);
    expect(line.endsWith('.A.')).toBe(true);
  });

  it('parseJsonText：合法解析；非法报错；null 字面量按 C-7 语义解析为 NULL', () => {
    expect(parseJsonText('{"a": 1}')).toEqual({ ok: true, value: { a: 1 } });
    expect(parseJsonText('[1, 2]')).toEqual({ ok: true, value: [1, 2] });
    expect(parseJsonText('null')).toEqual({ ok: true, value: null });
    expect(parseJsonText('{bad').ok).toBe(false);
    expect(parseJsonText('').ok).toBe(false);
  });

  it('prettyJson：对象格式化为缩进原文（原文编辑态初始文本）', () => {
    expect(prettyJson({ a: 1 })).toBe('{\n  "a": 1\n}');
  });
});
