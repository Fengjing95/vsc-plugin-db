/**
 * ER 图导出（交互稿 §13.9，P2 收口）：画布是「HTML 节点 + SVG 边」混合结构，
 * 无法直接序列化——独立 SVG 从图数据模型直接生成，几何/高度复用 erCanvas 纯函数
 * （与画布同源，防双源漂移）；色值由调用方从 CSS 变量解析后经 palette 注入
 * （token 单一来源不动）。PNG 在 webview 内光栅化（单张图内存有界，C-13 边界确认见
 * §13.9），落盘统一走 sys.saveFile（Host SaveDialog + 写文件）。
 */
import type { ErGraphResult, ErTableSummaryPayload } from '@db-explorer/protocol';
import {
  crowFootPath,
  edgeGeometry,
  nodeHeight,
  nodeVisibleRows,
  oneTickPath,
  selfLoopGeometry,
  type ErLayoutConsts,
  type ErRect,
} from './erCanvas';

/** 导出色板（调用方从 getComputedStyle 解析 --color-* 注入；hex/rgb 文本均可） */
export interface ErPalette {
  background: string;
  panel: string;
  border: string;
  mutedBg: string;
  foreground: string;
  mutedForeground: string;
  warning: string;
  link: string;
}

export interface ErExportInput {
  graph: ErGraphResult;
  positions: Record<string, { x: number; y: number }>;
  expanded: Record<string, boolean>;
  displayMode: 'full' | 'compact';
  palette: ErPalette;
}

function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const FULL_VIEW_ROWS = 12;

/** 生成独立 SVG 文本（40px 留白同「适应画布」口径；悬停/搜索等视图态不进导出） */
export function buildErSvg(input: ErExportInput): string {
  const { graph, positions, expanded, displayMode, palette } = input;
  const consts = graph.layout as ErLayoutConsts;
  const pad = 40;
  const width = Math.max(1, graph.layout.width + pad * 2);
  const height = Math.max(1, graph.layout.height + pad * 2);

  const rectOf = (table: string): ErRect | null => {
    const base = graph.layout.nodes.find((n) => n.table === table);
    const t = graph.tables.find((x) => x.name === table);
    if (!base || !t) {
      return null;
    }
    const rows = nodeVisibleRows(t, { compact: displayMode === 'compact', expanded: expanded[table] ?? false });
    return {
      x: positions[table]?.x ?? base.x,
      y: positions[table]?.y ?? base.y,
      width: consts.nodeWidth,
      height: nodeHeight(rows, consts),
    };
  };

  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${-pad} ${-pad} ${width} ${height}" font-family="'PingFang SC','Segoe UI',sans-serif">`,
  );
  parts.push(`<rect x="${-pad}" y="${-pad}" width="${width}" height="${height}" fill="${palette.background}"/>`);

  // 边层（自引用走自环弧；鸦爪/单端标记与画布同源）
  for (const edge of graph.edges) {
    const src = rectOf(edge.sourceTable);
    if (!src) {
      continue;
    }
    let d: string;
    let foot: string | null = null;
    let tick: string | null = null;
    if (edge.sourceTable === edge.targetTable) {
      d = selfLoopGeometry(src);
    } else {
      const dst = rectOf(edge.targetTable);
      if (!dst) {
        continue;
      }
      const geom = edgeGeometry(src, dst);
      d = geom.d;
      foot = crowFootPath(geom);
      tick = oneTickPath(geom);
    }
    parts.push(`<path d="${d}" fill="none" stroke="${palette.border}" stroke-width="1.5"/>`);
    if (foot) {
      parts.push(`<path d="${foot}" fill="none" stroke="${palette.border}" stroke-width="1.5"/>`);
    }
    if (tick) {
      parts.push(`<path d="${tick}" fill="none" stroke="${palette.border}" stroke-width="1.5"/>`);
    }
  }

  // 节点层（卡片 = 面板底 + 标题栏 + 列行；PK/FK 标记与图例同义：实心=主键、圆环=外键）
  for (const t of graph.tables) {
    const base = graph.layout.nodes.find((n) => n.table === t.name);
    if (!base) {
      continue;
    }
    const x = positions[t.name]?.x ?? base.x;
    const y = positions[t.name]?.y ?? base.y;
    const rows = nodeVisibleRows(t, { compact: displayMode === 'compact', expanded: expanded[t.name] ?? false });
    const h = nodeHeight(rows, consts);
    const visibleColumns =
      displayMode === 'compact' ? [] : (expanded[t.name] ?? false) ? t.columns : t.columns.slice(0, FULL_VIEW_ROWS);
    const tailCount = t.columns.length - visibleColumns.length + (t.columnsTruncated ?? 0);
    const edgeOf = (col: string): boolean =>
      graph.edges.some((e) => e.sourceTable === t.name && e.sourceColumns.includes(col));

    parts.push(`<g class="er-node" transform="translate(${x} ${y})">`);
    parts.push(
      `<rect width="${consts.nodeWidth}" height="${h}" rx="2" fill="${palette.panel}" stroke="${palette.border}"/>`,
    );
    parts.push(`<rect width="${consts.nodeWidth}" height="${consts.headerHeight}" rx="2" fill="${palette.mutedBg}"/>`);
    parts.push(
      `<text x="8" y="${consts.headerHeight / 2}" dominant-baseline="central" font-size="12" font-weight="600" fill="${palette.foreground}">${esc(t.name)}</text>`,
    );
    parts.push(
      `<text x="${consts.nodeWidth - 6}" y="${consts.headerHeight / 2}" text-anchor="end" dominant-baseline="central" font-size="10" fill="${palette.mutedForeground}">${t.columns.length} 列</text>`,
    );
    parts.push(`<line x1="0" y1="${consts.headerHeight}" x2="${consts.nodeWidth}" y2="${consts.headerHeight}" stroke="${palette.border}"/>`);

    visibleColumns.forEach((c: ErTableSummaryPayload['columns'][number], i: number) => {
      const cy = consts.headerHeight + i * consts.rowHeight + consts.rowHeight / 2;
      if (c.isPrimaryKey) {
        parts.push(`<circle class="er-pk" cx="12" cy="${cy}" r="3" fill="${palette.warning}"/>`);
      } else if (edgeOf(c.name)) {
        parts.push(`<circle class="er-fk" cx="12" cy="${cy}" r="3" fill="none" stroke="${palette.link}"/>`);
      }
      const tx = 20;
      parts.push(
        `<text x="${tx}" y="${cy}" dominant-baseline="central" font-size="11" ${c.isPrimaryKey ? 'font-weight="600"' : ''} fill="${palette.foreground}">${esc(c.name)}</text>`,
      );
      parts.push(
        `<text x="${consts.nodeWidth - 6}" y="${cy}" text-anchor="end" dominant-baseline="central" font-size="10" font-family="monospace" fill="${palette.mutedForeground}">${esc(c.dataType)}</text>`,
      );
    });
    if (tailCount > 0) {
      const ty = consts.headerHeight + visibleColumns.length * consts.rowHeight + consts.rowHeight / 2;
      parts.push(
        `<text class="er-tail" x="8" y="${ty}" dominant-baseline="central" font-size="11" fill="${palette.link}">+${tailCount} 列…</text>`,
      );
    }
    parts.push('</g>');
  }

  parts.push('</svg>');
  return parts.join('\n');
}

/** UTF-8 安全 base64（CJK 表名/列名；分块避免 String.fromCharCode 展开上限） */
export function utf8ToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

/** SVG → PNG 光栅化（2x 缩放；浏览器 canvas 路径，C-13 边界确认见交互稿 §13.9）。
 *  必须走 data: URL——VSCode webview CSP 的 img-src 只放行 cspSource 与 data:，
 *  blob: 会被拦截直接 onerror（P-67）；data: URL 的 SVG 无外部引用，canvas 不被污染 */
export function rasterizeSvgToPng(svg: string, width: number, height: number, scale = 2): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    const img = new Image();
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(width * scale);
        canvas.height = Math.round(height * scale);
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          throw new Error('canvas 2d 不可用');
        }
        ctx.scale(scale, scale);
        ctx.drawImage(img, 0, 0, width, height);
        const data = canvas.toDataURL('image/png');
        resolve(data.slice(data.indexOf(',') + 1));
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    };
    img.onerror = () => {
      reject(new Error('SVG 光栅化失败（图片被 CSP 拦截或解码错误）'));
    };
    img.src = url;
  });
}
