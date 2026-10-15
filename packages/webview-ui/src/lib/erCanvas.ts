import type { ErGraphResult, ErLayoutNodePayload, ErTableSummaryPayload } from '@db-explorer/protocol';

/**
 * ER 画布纯函数（M8-ER，交互稿 §13.5/§13.6）：视口变换、降级档位、节点高度、
 * 边几何（鸦爪/单端标记）、层内重排、搜索过滤。零 React/零 DOM——vitest 单测覆盖。
 * 布局常量来自 er.getGraph 载荷（core erLayout 单一来源随包下发，防双源漂移）。
 */

export type ErLayoutConsts = ErGraphResult['layout'];

export interface ErTransform {
  tx: number;
  ty: number;
  scale: number;
}

export interface ErRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const ER_MIN_SCALE = 0.1;
export const ER_MAX_SCALE = 3;
export const ER_FIT_PADDING = 40;
/** 完整档节点最多显示的列行数（超出以「+N 列」尾行收口，点击展开） */
export const ER_NODE_MAX_ROWS = 12;
/** 渲染降级分档阈值（交互稿 §13.2）：≤60 完整 / 61–150 紧凑 / >150 打开引导已拦 */
export const ER_FULL_TIER_MAX = 60;
export const ER_COMPACT_TIER_MAX = 150;

export function clampScale(scale: number): number {
  return Math.min(ER_MAX_SCALE, Math.max(ER_MIN_SCALE, scale));
}

/** 以指针为中心缩放：保持 (cx,cy) 下的内容点在缩放前后位置不变 */
export function zoomAtTransform(t: ErTransform, nextScale: number, cx: number, cy: number): ErTransform {
  const scale = clampScale(nextScale);
  const contentX = (cx - t.tx) / t.scale;
  const contentY = (cy - t.ty) / t.scale;
  return { scale, tx: cx - contentX * scale, ty: cy - contentY * scale };
}

/** 适应画布：内容等比缩放居中（空内容 → 100% 居中） */
export function fitTransform(
  viewport: { width: number; height: number },
  content: { width: number; height: number },
  padding = ER_FIT_PADDING,
): ErTransform {
  if (content.width <= 0 || content.height <= 0 || viewport.width <= 0 || viewport.height <= 0) {
    return { tx: Math.max(0, (viewport.width - content.width) / 2), ty: Math.max(0, (viewport.height - content.height) / 2), scale: 1 };
  }
  const scale = clampScale(
    Math.min((viewport.width - padding * 2) / content.width, (viewport.height - padding * 2) / content.height),
  );
  return {
    scale,
    tx: (viewport.width - content.width * scale) / 2,
    ty: (viewport.height - content.height * scale) / 2,
  };
}

/** 渲染降级档位（>150 在打开引导已转选择模式，此处兜底紧凑） */
export function tierFor(tableCount: number): 'full' | 'compact' {
  return tableCount <= ER_FULL_TIER_MAX ? 'full' : 'compact';
}

/** 节点可见列行数：紧凑 = 0（仅标题）；完整 = 全部或截断 + 尾行 */
export function nodeVisibleRows(
  table: ErTableSummaryPayload,
  opts: { compact: boolean; expanded: boolean },
): number {
  if (opts.compact) {
    return 0;
  }
  const total = table.columns.length + (table.columnsTruncated ?? 0);
  if (opts.expanded) {
    return total;
  }
  return Math.min(table.columns.length, ER_NODE_MAX_ROWS) + (total > ER_NODE_MAX_ROWS ? 1 : 0);
}

/** 节点高度（与 core erLayout 同一公式，常量随载荷下发） */
export function nodeHeight(rows: number, consts: ErLayoutConsts): number {
  return consts.headerHeight + rows * consts.rowHeight + consts.padBottom;
}

/**
 * 层内重排（交互稿 §13.6「展开列后不重叠」）：按 x 分层，层内按当前 y 排序、
 * 自顶向下「原位优先、重叠才下推」。返回各表新 y（未变化的原样返回）。
 */
export function repackY(
  nodes: ErLayoutNodePayload[],
  heightOf: (table: string) => number,
  gapY: number,
): Map<string, number> {
  const byLayer = new Map<number, ErLayoutNodePayload[]>();
  for (const n of nodes) {
    const arr = byLayer.get(n.x) ?? [];
    arr.push(n);
    byLayer.set(n.x, arr);
  }
  const next = new Map<string, number>();
  for (const arr of byLayer.values()) {
    const sorted = [...arr].sort((a, b) => a.y - b.y);
    let cursor = -Infinity;
    for (const n of sorted) {
      const y = Math.max(n.y, cursor);
      next.set(n.table, y);
      cursor = y + heightOf(n.table) + gapY;
    }
  }
  return next;
}

export interface ErEdgeGeom {
  /** SVG path d（三次贝塞尔：正向水平锚点 / 同层与回边垂直锚点） */
  d: string;
  start: { x: number; y: number };
  /** 单位方向：锚点出发沿边前进的方向（标记绘制用） */
  startDir: { x: number; y: number };
  end: { x: number; y: number };
  endDir: { x: number; y: number };
  /** true = 回边/同层（垂直锚点形态，交互稿 §13.5 兜底口径） */
  backward: boolean;
}

/** 边几何：正向（子表右缘中点 → 父表左缘中点）；父表不在右侧（回边/同层）改垂直锚点 */
export function edgeGeometry(src: ErRect, dst: ErRect): ErEdgeGeom {
  const forward = dst.x >= src.x + src.width;
  if (forward) {
    const sx = src.x + src.width;
    const sy = src.y + src.height / 2;
    const ex = dst.x;
    const ey = dst.y + dst.height / 2;
    const mx = (sx + ex) / 2;
    return {
      d: `M ${sx} ${sy} C ${mx} ${sy}, ${mx} ${ey}, ${ex} ${ey}`,
      start: { x: sx, y: sy },
      startDir: { x: 1, y: 0 },
      end: { x: ex, y: ey },
      endDir: { x: 1, y: 0 },
      backward: false,
    };
  }
  const sx = src.x + src.width / 2;
  const sy = src.y + src.height;
  const ex = dst.x + dst.width / 2;
  const ey = dst.y;
  const my = (sy + ey) / 2;
  return {
    d: `M ${sx} ${sy} C ${sx} ${my}, ${ex} ${my}, ${ex} ${ey}`,
    start: { x: sx, y: sy },
    startDir: { x: 0, y: 1 },
    end: { x: ex, y: ey },
    endDir: { x: 0, y: -1 },
    backward: true,
  };
}

/** 自引用环（右缘出、环绕回右缘下部；不绘制基数标记） */
export function selfLoopGeometry(rect: ErRect): string {
  const sx = rect.x + rect.width;
  const y1 = rect.y + 10;
  const y2 = rect.y + rect.height - 8;
  const ym = (y1 + y2) / 2;
  const bulge = 40;
  return `M ${sx} ${y1} C ${sx + bulge} ${y1}, ${sx + bulge} ${ym}, ${sx} ${ym} C ${sx + bulge} ${ym}, ${sx + bulge} ${y2}, ${sx} ${y2}`;
}

/** 鸦爪（多端，source 侧）：实体边缘两点收拢到线上一点 */
export function crowFootPath(geom: ErEdgeGeom, size = 6): string {
  const { start, startDir } = geom;
  const px = -startDir.y;
  const py = startDir.x;
  const j = { x: start.x + startDir.x * size, y: start.y + startDir.y * size };
  const p1 = { x: start.x + px * size, y: start.y + py * size };
  const p2 = { x: start.x - px * size, y: start.y - py * size };
  return `M ${p1.x} ${p1.y} L ${j.x} ${j.y} L ${p2.x} ${p2.y}`;
}

/** 单端标记（一端，target 侧）：线上双竖线（锚点的线一侧，endDir 为入表方向故取负偏移） */
export function oneTickPath(geom: ErEdgeGeom, size = 5, offset = 7): string {
  const { end, endDir } = geom;
  const px = -endDir.y;
  const py = endDir.x;
  const c = { x: end.x - endDir.x * offset, y: end.y - endDir.y * offset };
  return `M ${c.x + px * size} ${c.y + py * size} L ${c.x - px * size} ${c.y - py * size}`;
}

/** 搜索过滤（表名/注释子串，大小写不敏感；空串 = 全命中） */
export function tableMatchesSearch(table: ErTableSummaryPayload, search: string): boolean {
  const q = search.trim().toLowerCase();
  if (!q) {
    return true;
  }
  return table.name.toLowerCase().includes(q) || (table.comment ?? '').toLowerCase().includes(q);
}
