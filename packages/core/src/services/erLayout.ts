/**
 * ER 分层布局（M8-ER，概要 §5.11 / ADR D-22）：简化 Sugiyama——最长路径分层 + 层内重心排序
 * + DFS 确定性打环（自引用边不入分层约束）。纯函数、零 IO、零随机：同输入同输出（快照可测）。
 * 坐标常量由 core 导出、webview 同源消费（防双源漂移）；节点高度按可见行数公式估算，
 * 渲染端使用同一 computeNodeHeight。
 *
 * 方向口径：边 source = FK 子表（多端）→ target = 被引用父表（一端），层号沿该方向递增
 * （父表在右）。打环剔除的回边不参与分层，绘制时由 webview 以垂直锚点兜底（交互稿 §13.5）。
 */

export const ER_NODE_WIDTH = 232;
export const ER_NODE_HEADER_HEIGHT = 30;
export const ER_NODE_ROW_HEIGHT = 22;
export const ER_NODE_PAD_BOTTOM = 8;
export const ER_LAYER_GAP_X = 96;
export const ER_NODE_GAP_Y = 28;

export interface ErLayoutNode {
  table: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ErLayoutResult {
  nodes: ErLayoutNode[];
  /** 画布总尺寸（fit 与导出使用；空图 = 0） */
  width: number;
  height: number;
}

export function computeNodeHeight(visibleRows: number): number {
  return ER_NODE_HEADER_HEIGHT + visibleRows * ER_NODE_ROW_HEIGHT + ER_NODE_PAD_BOTTOM;
}

/** 布局常量集（er.getGraph 载荷下发：Webview 无 core 依赖，按同源常量重算节点高度，防双源漂移） */
export const ER_LAYOUT_CONSTS = {
  nodeWidth: ER_NODE_WIDTH,
  headerHeight: ER_NODE_HEADER_HEIGHT,
  rowHeight: ER_NODE_ROW_HEIGHT,
  padBottom: ER_NODE_PAD_BOTTOM,
  layerGapX: ER_LAYER_GAP_X,
  nodeGapY: ER_NODE_GAP_Y,
} as const;

interface LayoutInputTable {
  name: string;
  rows: number;
}

interface LayoutInputEdge {
  source: string;
  target: string;
}

/**
 * 计算分层布局。tables 顺序即输入序（决定初始与平局序，确定性来源）；
 * 端点缺失或自引用的边自动忽略（不参与分层）。
 */
export function layoutErGraph(tables: LayoutInputTable[], edges: LayoutInputEdge[]): ErLayoutResult {
  const indexByName = new Map(tables.map((t, i) => [t.name, i]));
  const heights = tables.map((t) => computeNodeHeight(t.rows));

  // 邻接（排除自引用与端点缺失；同表对可能多条边——以邻接去重，层约束相同）
  const outgoing: number[][] = tables.map(() => []);
  const incoming: number[][] = tables.map(() => []);
  const seenPair = new Set<string>();
  for (const e of edges) {
    const s = indexByName.get(e.source);
    const t = indexByName.get(e.target);
    if (s === undefined || t === undefined || s === t) {
      continue;
    }
    const key = `${s}->${t}`;
    if (seenPair.has(key)) {
      continue;
    }
    seenPair.add(key);
    outgoing[s].push(t);
    incoming[t].push(s);
  }

  // DFS 打环：回边（指向栈中节点）从层约束图中剔除（确定性：节点序 = 输入序、邻接序 = 建图序）
  const state = new Array<number>(tables.length).fill(0); // 0 未访问 1 栈中 2 完成
  const layerEdges: Array<[number, number]> = [];
  const visit = (u: number): void => {
    state[u] = 1;
    for (const v of outgoing[u]) {
      if (state[v] === 0) {
        visit(v);
        layerEdges.push([u, v]);
      } else if (state[v] === 2) {
        layerEdges.push([u, v]);
      }
      // state[v] === 1：回边，剔除
    }
    state[u] = 2;
  };
  for (let i = 0; i < tables.length; i++) {
    if (state[i] === 0) {
      visit(i);
    }
  }

  // 最长路径分层：layer(u) = 0 无入边；否则 max(layer(入边源点)) + 1——层号沿 source→target
  // 递增（FK 子表在左、被引用父表在右，与「子表右缘出、父表左缘入」的边锚点口径一致）。
  // layerEdges 已是 DAG（回边剔除），递归必然终止
  const layerOf = new Array<number>(tables.length).fill(0);
  const layerMemo = new Map<number, number>();
  const layerOfNode = (u: number): number => {
    const memoed = layerMemo.get(u);
    if (memoed !== undefined) {
      return memoed;
    }
    let layer = 0;
    for (const [from, to] of layerEdges) {
      if (to === u) {
        layer = Math.max(layer, layerOfNode(from) + 1);
      }
    }
    layerMemo.set(u, layer);
    layerOf[u] = layer;
    return layer;
  };
  for (let i = 0; i < tables.length; i++) {
    layerOfNode(i);
  }

  // 层内初始序 = 输入序；重心排序：4 轮交替扫（下→上→下→上），平局保持现序（稳定排序）
  const layers: number[][] = [];
  tables.forEach((_, i) => {
    (layers[layerOf[i]] ??= []).push(i);
  });
  const positionIn = new Map<number, number>();
  const syncPositions = (): void => {
    for (const arr of layers) {
      arr.forEach((node, idx) => positionIn.set(node, idx));
    }
  };
  syncPositions();
  const neighborPositions = (u: number, adj: number[][]): number[] => {
    const pos: number[] = [];
    for (const v of adj[u]) {
      const p = positionIn.get(v);
      if (p !== undefined) {
        pos.push(p);
      }
    }
    return pos;
  };
  for (let round = 0; round < 2; round++) {
    for (let l = 1; l < layers.length; l++) {
      layers[l].sort(
        (a, b) => avg(neighborPositions(a, incoming)) - avg(neighborPositions(b, incoming)),
      );
      syncPositions();
    }
    for (let l = layers.length - 2; l >= 0; l--) {
      layers[l].sort(
        (a, b) => avg(neighborPositions(a, outgoing)) - avg(neighborPositions(b, outgoing)),
      );
      syncPositions();
    }
  }

  // 坐标分配：x = 层号 × (宽 + 层距)；层内 y 累加并在画布内垂直居中
  const layerHeights = layers.map((arr) =>
    arr.reduce((sum, node) => sum + heights[node], 0) + Math.max(0, arr.length - 1) * ER_NODE_GAP_Y,
  );
  const totalHeight = Math.max(0, ...layerHeights);
  const maxLayer = layers.length - 1;
  const width = maxLayer < 0 ? 0 : maxLayer * (ER_NODE_WIDTH + ER_LAYER_GAP_X) + ER_NODE_WIDTH;

  const nodes: ErLayoutNode[] = new Array(tables.length);
  layers.forEach((arr, l) => {
    const layerHeight = layerHeights[l];
    let y = Math.round((totalHeight - layerHeight) / 2);
    for (const node of arr) {
      nodes[node] = {
        table: tables[node].name,
        x: l * (ER_NODE_WIDTH + ER_LAYER_GAP_X),
        y,
        width: ER_NODE_WIDTH,
        height: heights[node],
      };
      y += heights[node] + ER_NODE_GAP_Y;
    }
  });
  return { nodes, width, height: totalHeight };
}

function avg(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((s, v) => s + v, 0) / values.length;
}
