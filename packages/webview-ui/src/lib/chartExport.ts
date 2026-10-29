/**
 * 图表 SVG 导出（ADR D-29 / 交互稿 §7.5）：从几何模型直接生成 SVG 字符串（erExport 同构口径——
 * 画布是实时组件不可序列化，导出独立生成；悬停态不进导出）。PNG 光栅化复用 erExport 的
 * data: URL 手法（P-67：webview 内喂 `<img>` 禁 blob:）。
 */
import type { ChartGeom } from './chartView';

export interface ChartPalette {
  background: string;
  foreground: string;
  mutedForeground: string;
  border: string;
  /** 系列色（--color-chart-1..6 解析值，C-12 全 token） */
  series: string[];
}

export interface ChartExportInput {
  geom: ChartGeom;
  palette: ChartPalette;
  seriesNames: string[];
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** 连续非空段折线（NULL 断点拆段，§7.5） */
function polylinePath(points: Array<{ x: number; y: number } | null>): string {
  let d = '';
  let pen = false;
  for (const p of points) {
    if (!p) {
      pen = false;
      continue;
    }
    d += `${pen ? 'L' : 'M'} ${p.x.toFixed(1)} ${p.y.toFixed(1)} `;
    pen = true;
  }
  return d.trim();
}

export function buildChartSvg(input: ChartExportInput): string {
  const { geom: g, palette, seriesNames } = input;
  const plotBottom = g.padTop + g.plotHeight;
  const parts: string[] = [];

  // 背景与网格
  parts.push(`<rect width="${g.width}" height="${g.height}" fill="${palette.background}"/>`);
  for (const t of g.yTicks) {
    parts.push(
      `<line x1="${g.padLeft}" y1="${t.y.toFixed(1)}" x2="${g.padLeft + g.plotWidth}" y2="${t.y.toFixed(1)}" stroke="${palette.border}" stroke-width="1" opacity="0.5"/>`,
      `<text x="${g.padLeft - 8}" y="${(t.y + 3.5).toFixed(1)}" text-anchor="end" font-size="10" fill="${palette.mutedForeground}" font-family="monospace">${esc(t.label)}</text>`,
    );
  }
  // Y 轴 / X 轴基线
  parts.push(
    `<line x1="${g.padLeft}" y1="${g.padTop}" x2="${g.padLeft}" y2="${plotBottom}" stroke="${palette.border}"/>`,
    `<line x1="${g.padLeft}" y1="${plotBottom}" x2="${g.padLeft + g.plotWidth}" y2="${plotBottom}" stroke="${palette.border}"/>`,
  );
  // X 刻度
  for (const t of g.xTicks) {
    parts.push(
      `<text x="${t.x.toFixed(1)}" y="${(plotBottom + 16).toFixed(1)}" text-anchor="middle" font-size="10" fill="${palette.mutedForeground}">${esc(t.label)}</text>`,
    );
  }

  // 图元
  g.series.forEach((s, si) => {
    const color = palette.series[si % palette.series.length];
    const d = polylinePath(s.points);
    if (d) {
      parts.push(`<path d="${d}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round"/>`);
      for (const p of s.points) {
        if (p) {
          parts.push(`<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="2.5" fill="${color}"/>`);
        }
      }
    }
  });
  for (const b of g.bars) {
    const color = palette.series[b.series % palette.series.length];
    const h = Math.max(1, plotBottom - b.y);
    parts.push(`<rect x="${b.x.toFixed(1)}" y="${b.y.toFixed(1)}" width="${b.width.toFixed(1)}" height="${h.toFixed(1)}" fill="${color}" opacity="0.85"/>`);
  }

  // 图例（顶部左起，横排；超出截断计数）
  let lx = g.padLeft;
  const ly = g.padTop > 12 ? 10 : 10;
  const legendLimit = Math.min(seriesNames.length, palette.series.length, 6);
  for (let si = 0; si < legendLimit; si++) {
    const name = seriesNames[si];
    const label = name.length > 14 ? `${name.slice(0, 13)}…` : name;
    parts.push(
      `<rect x="${lx}" y="${ly - 7}" width="9" height="9" fill="${palette.series[si % palette.series.length]}"/>`,
      `<text x="${lx + 13}" y="${ly}" font-size="10" fill="${palette.foreground}">${esc(label)}</text>`,
    );
    lx += 13 + label.length * 6.2 + 14;
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${g.width}" height="${g.height}" viewBox="0 0 ${g.width} ${g.height}">${parts.join('')}</svg>`;
}
