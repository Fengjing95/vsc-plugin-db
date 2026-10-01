import { useEffect, useMemo, useRef, useState } from 'react';
import { highlightSql } from '../../lib/sqlHighlight';

/** WHERE / ORDER BY 上下文的补全关键字 */
const WHERE_KEYWORDS = [
  'AND', 'OR', 'NOT', 'LIKE', 'NOT LIKE', 'IN', 'NOT IN', 'IS NULL', 'IS NOT NULL',
  'BETWEEN', 'TRUE', 'FALSE', 'NULL', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END',
];
const ORDER_KEYWORDS = ['ASC', 'DESC'];

interface Candidate {
  label: string;
  detail?: string;
  insert: string;
}

/**
 * SQL 片段输入框（交互稿 §4.4 v0.1.3）：
 * textarea 文本透明 + 底层 pre 语法高亮（prism），同字体同内边距对位；
 * 输入词前缀触发补全（列名 + 上下文关键字），↑↓ 选择、Enter/Tab 采纳、Esc 关闭；
 * Enter 在补全关闭时触发 onApply。
 */
export function SqlInput({
  value,
  onChange,
  onApply,
  columns,
  context,
  ariaLabel,
  placeholder,
  widthClass,
}: {
  value: string;
  onChange: (v: string) => void;
  /** Enter（非补全态）触发应用 */
  onApply: () => void;
  columns: Array<{ name: string; type: string }>;
  context: 'where' | 'order';
  ariaLabel: string;
  placeholder?: string;
  widthClass?: string;
}) {
  const taRef = useRef<HTMLTextAreaElement>(null);
  const preRef = useRef<HTMLPreElement>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [caretWord, setCaretWord] = useState('');

  const keywords = context === 'where' ? WHERE_KEYWORDS : ORDER_KEYWORDS;

  /** 光标前的词（字母/数字/_/$/中文） */
  const wordBeforeCaret = (text: string, caret: number): string => {
    const m = /[A-Za-z0-9_$\u4e00-\u9fa5]*$/.exec(text.slice(0, caret));
    return m ? m[0] : '';
  };

  const candidates = useMemo<Candidate[]>(() => {
    if (caretWord === '') return [];
    const upper = caretWord.toUpperCase();
    const cols: Candidate[] = columns
      .filter((c) => c.name.toLowerCase().startsWith(caretWord.toLowerCase()))
      .map((c) => ({ label: c.name, detail: c.type, insert: c.name }));
    const kws: Candidate[] = keywords
      .filter((k) => k.toUpperCase().startsWith(upper) && k.toUpperCase() !== upper)
      .map((k) => ({ label: k, insert: k }));
    return [...cols, ...kws].slice(0, 8);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [caretWord, columns, context]);

  const syncScroll = (): void => {
    if (taRef.current && preRef.current) {
      preRef.current.scrollLeft = taRef.current.scrollLeft;
      preRef.current.scrollTop = taRef.current.scrollTop;
    }
  };

  useEffect(() => {
    syncScroll();
  }, [value]);

  const refreshCaret = (): void => {
    const ta = taRef.current;
    if (!ta) return;
    const word = wordBeforeCaret(ta.value, ta.selectionStart ?? 0);
    setCaretWord(word);
    if (word === '') {
      setOpen(false);
      return;
    }
    // 有词前缀且能命中候选才触发补全（空格后不弹全量列表，避免干扰）
    const upper = word.toUpperCase();
    const hasMatch =
      columns.some((c) => c.name.toLowerCase().startsWith(word.toLowerCase())) ||
      keywords.some((k) => k.toUpperCase().startsWith(upper));
    setOpen(hasMatch);
    if (hasMatch) {
      setActive(0);
    }
  };

  const accept = (c: Candidate): void => {
    const ta = taRef.current;
    if (!ta) return;
    const caret = ta.selectionStart ?? value.length;
    const start = caret - caretWord.length;
    const next = value.slice(0, start) + c.insert + ' ' + value.slice(caret);
    onChange(next);
    setOpen(false);
    setCaretWord('');
    // 光标落到插入文本之后
    requestAnimationFrame(() => {
      const pos = start + c.insert.length + 1;
      ta.focus();
      ta.setSelectionRange(pos, pos);
    });
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (open && candidates.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActive((a) => (a + 1) % candidates.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActive((a) => (a - 1 + candidates.length) % candidates.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        accept(candidates[active]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setOpen(false);
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      onApply();
    }
  };

  const lines = Math.min(4, Math.max(1, value.split('\n').length));

  return (
    <div className={`relative min-w-0 ${widthClass ?? 'flex-1'}`}>
      <pre
        ref={preRef}
        aria-hidden
        className="sql-hl pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-all rounded-sm border border-transparent bg-input-bg px-2 py-1 font-mono text-[12px] leading-[1.6]"
      >
        <span dangerouslySetInnerHTML={{ __html: highlightSql(value || ' ') }} />
      </pre>
      <textarea
        ref={taRef}
        rows={lines}
        spellCheck={false}
        wrap="soft"
        aria-label={ariaLabel}
        placeholder={placeholder}
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          // 同帧刷新补全（受控值更新后 caret 不变）
          requestAnimationFrame(refreshCaret);
        }}
        onKeyDown={onKeyDown}
        onKeyUp={refreshCaret}
        onClick={refreshCaret}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        className="relative h-auto w-full resize-none overflow-x-auto whitespace-pre-wrap break-all rounded-sm border border-border bg-transparent px-2 py-1 font-mono text-[12px] leading-[1.6] text-transparent caret-ring outline-none placeholder:text-muted-foreground focus:border-ring"
      />
      {open && candidates.length > 0 && (
        <ul
          role="listbox"
          aria-label={`${ariaLabel}补全`}
          className="absolute left-0 top-full z-30 mt-0.5 max-h-56 w-full min-w-48 overflow-y-auto rounded-sm border border-border bg-panel py-1 shadow-lg"
        >
          {candidates.map((c, i) => (
            <li key={`${c.label}:${i}`}>
              <button
                type="button"
                role="option"
                aria-selected={i === active}
                className={`flex w-full items-center justify-between gap-2 px-2 py-1 text-left text-[12px] ${
                  i === active ? 'bg-selected text-selected-foreground font-medium' : 'hover:bg-accent'
                }`}
                onMouseDown={(e) => {
                  e.preventDefault(); // 防止 textarea 先失焦
                  accept(c);
                }}
                onMouseEnter={() => setActive(i)}
              >
                <span className="truncate font-mono">{c.label}</span>
                {c.detail && <span className="shrink-0 text-[11px] text-muted-foreground">{c.detail}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
