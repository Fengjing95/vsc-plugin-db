/**
 * AI 解释 Tab 的最小 Markdown 渲染（交互稿 §15.3）：AI 输出为受限子集
 * （标题 / 无序列表 / 有序列表 / 围栏代码 / 段落 + **粗体** 与 `行内代码`），
 * 自研解析成 React 可渲染结构——不引 markdown 依赖（webview bundle 体积敏感）。
 * 流式友好：未闭合围栏按代码块继续累积；纯函数，有单测。
 */

export type AiInline = { text: string; bold?: boolean; code?: boolean };

export type AiMarkdownBlock =
  | { type: 'heading'; level: 1 | 2 | 3; inlines: AiInline[] }
  | { type: 'code'; lang: string; text: string }
  | { type: 'list'; ordered: boolean; items: AiInline[][] }
  | { type: 'para'; inlines: AiInline[] };

const LIST_RE = /^(\s*)([-*]|\d+\.)\s+(.*)$/;

/** 行内解析：**粗体** 与 `行内代码`（不嵌套） */
export function parseAiInline(text: string): AiInline[] {
  const out: AiInline[] = [];
  const re = /(\*\*([^*]+)\*\*)|(`([^`]+)`)/g;
  let last = 0;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    if (m.index > last) {
      out.push({ text: text.slice(last, m.index) });
    }
    if (m[2] !== undefined) {
      out.push({ text: m[2], bold: true });
    } else if (m[4] !== undefined) {
      out.push({ text: m[4], code: true });
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) {
    out.push({ text: text.slice(last) });
  }
  return out.length > 0 ? out : [{ text: '' }];
}

export function parseAiMarkdown(src: string): AiMarkdownBlock[] {
  const lines = src.split('\n');
  const blocks: AiMarkdownBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    // 围栏代码块（未闭合 = 流式中，读到结尾）
    const fence = /^\s*```(\w*)/.exec(line);
    if (fence) {
      const lang = fence[1] ?? '';
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !/^\s*```/.test(lines[i] ?? '')) {
        body.push(lines[i] ?? '');
        i += 1;
      }
      i += 1; // 跳过闭合围栏（无则已到结尾）
      blocks.push({ type: 'code', lang, text: body.join('\n') });
      continue;
    }
    if (line.trim() === '') {
      i += 1;
      continue;
    }
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push({
        type: 'heading',
        level: heading[1].length as 1 | 2 | 3,
        inlines: parseAiInline(heading[2]),
      });
      i += 1;
      continue;
    }
    const list = LIST_RE.exec(line);
    if (list) {
      const ordered = /\d+\./.test(list[2] ?? '');
      const items: AiInline[][] = [parseAiInline(list[3] ?? '')];
      i += 1;
      while (i < lines.length) {
        const next = LIST_RE.exec(lines[i] ?? '');
        if (!next || /\d+\./.test(next[2] ?? '') !== ordered) {
          break;
        }
        items.push(parseAiInline(next[3] ?? ''));
        i += 1;
      }
      blocks.push({ type: 'list', ordered, items });
      continue;
    }
    blocks.push({ type: 'para', inlines: parseAiInline(line) });
    i += 1;
  }
  return blocks;
}
