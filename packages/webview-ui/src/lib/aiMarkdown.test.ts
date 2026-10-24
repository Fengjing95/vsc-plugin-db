import { describe, expect, it } from 'vitest';
import { lineDiff } from './aiDiff';
import { parseAiInline, parseAiMarkdown } from './aiMarkdown';

describe('parseAiMarkdown', () => {
  it('标题 / 段落 / 列表 / 代码块', () => {
    const blocks = parseAiMarkdown(
      ['## 语句意图', '查询活跃用户。', '- 先过滤状态', '- 再按时间倒序', '', '```sql', 'SELECT 1;', '```'].join('\n'),
    );
    expect(blocks).toHaveLength(4);
    expect(blocks[0]).toEqual({ type: 'heading', level: 2, inlines: [{ text: '语句意图' }] });
    expect(blocks[1]).toEqual({ type: 'para', inlines: [{ text: '查询活跃用户。' }] });
    expect(blocks[2]).toEqual({
      type: 'list',
      ordered: false,
      items: [[{ text: '先过滤状态' }], [{ text: '再按时间倒序' }]],
    });
    expect(blocks[3]).toEqual({ type: 'code', lang: 'sql', text: 'SELECT 1;' });
  });

  it('流式未闭合围栏按代码块累积', () => {
    const blocks = parseAiMarkdown('```sql\nSELECT\n  1');
    expect(blocks).toEqual([{ type: 'code', lang: 'sql', text: 'SELECT\n  1' }]);
  });

  it('行内粗体与行内代码', () => {
    expect(parseAiInline('前 **加粗** 与 `col` 后')).toEqual([
      { text: '前 ' },
      { text: '加粗', bold: true },
      { text: ' 与 ' },
      { text: 'col', code: true },
      { text: ' 后' },
    ]);
  });

  it('有序列表', () => {
    const blocks = parseAiMarkdown('1. 第一步\n2. 第二步');
    expect(blocks).toEqual([
      { type: 'list', ordered: true, items: [[{ text: '第一步' }], [{ text: '第二步' }]] },
    ]);
  });

  it('空输入返回空', () => {
    expect(parseAiMarkdown('')).toEqual([]);
  });
});

describe('lineDiff', () => {
  it('相同行 same，独有行 del/add', () => {
    const diff = lineDiff('SELECT a\nFROM u', 'SELECT a\nFROM users');
    expect(diff).toEqual([
      { type: 'same', text: 'SELECT a' },
      { type: 'del', text: 'FROM u' },
      { type: 'add', text: 'FROM users' },
    ]);
  });

  it('完全一致全 same', () => {
    expect(lineDiff('A\nB', 'A\nB')).toEqual([
      { type: 'same', text: 'A' },
      { type: 'same', text: 'B' },
    ]);
  });

  it('纯新增 / 纯删除（行尾追加 / 移除）', () => {
    expect(lineDiff('A', 'A\nX')).toEqual([
      { type: 'same', text: 'A' },
      { type: 'add', text: 'X' },
    ]);
    expect(lineDiff('A\nX', 'A')).toEqual([
      { type: 'same', text: 'A' },
      { type: 'del', text: 'X' },
    ]);
  });

  it('多行重排保持稳定（先 del 后 add 混排不丢行）', () => {
    const diff = lineDiff('A\nB\nC', 'A\nX\nC');
    const dels = diff.filter((d) => d.type === 'del').map((d) => d.text);
    const adds = diff.filter((d) => d.type === 'add').map((d) => d.text);
    expect(dels).toEqual(['B']);
    expect(adds).toEqual(['X']);
  });
});
