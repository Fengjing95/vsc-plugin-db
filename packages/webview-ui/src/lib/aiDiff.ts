/**
 * 行级 LCS diff（交互稿 §15.4 修复 Modal：原 SQL vs 建议 SQL 增删行着色）。
 * SQL 语句行数小，O(n·m) DP 足够；超上限退化为逐行配对（防病态输入卡 UI）。纯函数，有单测。
 */

export type DiffLineType = 'same' | 'del' | 'add';

export interface DiffLine {
  type: DiffLineType;
  text: string;
}

const MAX_DIFF_LINES = 800;

export function lineDiff(a: string, b: string): DiffLine[] {
  const aLines = a.split('\n');
  const bLines = b.split('\n');
  if (aLines.length > MAX_DIFF_LINES || bLines.length > MAX_DIFF_LINES) {
    return [
      ...aLines.map((text) => ({ type: 'del' as const, text })),
      ...bLines.map((text) => ({ type: 'add' as const, text })),
    ];
  }
  // LCS 长度表（(n+1)×(m+1)）
  const n = aLines.length;
  const m = bLines.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] =
        aLines[i] === bLines[j] ? (dp[i + 1]?.[j + 1] ?? 0) + 1 : Math.max(dp[i + 1]?.[j] ?? 0, dp[i]?.[j + 1] ?? 0);
    }
  }
  // 回溯产出 diff
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (aLines[i] === bLines[j]) {
      out.push({ type: 'same', text: aLines[i] ?? '' });
      i += 1;
      j += 1;
    } else if ((dp[i + 1]?.[j] ?? 0) >= (dp[i]?.[j + 1] ?? 0)) {
      out.push({ type: 'del', text: aLines[i] ?? '' });
      i += 1;
    } else {
      out.push({ type: 'add', text: bLines[j] ?? '' });
      j += 1;
    }
  }
  while (i < n) {
    out.push({ type: 'del', text: aLines[i] ?? '' });
    i += 1;
  }
  while (j < m) {
    out.push({ type: 'add', text: bLines[j] ?? '' });
    j += 1;
  }
  return out;
}
