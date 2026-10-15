import type { ErGraphResult, ErGraphScopePayload } from '@db-explorer/protocol';
import { create } from 'zustand';
import {
  clampScale,
  fitTransform,
  nodeHeight,
  nodeVisibleRows,
  repackY,
  tierFor,
  zoomAtTransform,
  type ErTransform,
} from '../lib/erCanvas';
import { request, RpcError } from '../rpc/client';
import { errorCodeToMessage } from '../lib/errors';
import { RpcMethods } from '@db-explorer/protocol';

/**
 * ER 图状态（M8-ER，交互稿 §13）：图数据/视口变换/降级档位/搜索/节点展开与拖拽。
 * 竞态防护同 tableStore.refresh（P-6）：reqSeq 自增，旧响应丢弃。
 * P-17 口径：组件渲染聚合量时订阅底层切片，不经 action 间接读。
 */

export interface ErErrorState {
  code: string;
  message: string;
}

interface ErState {
  status: 'loading' | 'ready' | 'error';
  error: ErErrorState | null;
  graph: ErGraphResult | null;
  scope: ErGraphScopePayload | null;
  /** 渲染降级档位（默认按表数自动，工具栏可手动切换） */
  displayMode: 'full' | 'compact';
  search: string;
  /** 展开覆盖（键 = 表名；仅完整档「+N 列」尾行 / 标题双击切换） */
  expanded: Record<string, boolean>;
  /** 拖拽位置覆盖（键 = 表名；「重新布局」清空） */
  positions: Record<string, { x: number; y: number }>;
  /** 悬停对象（节点 hover 高亮邻接 / 边 hover tooltip） */
  hoverTable: string | null;
  hoverEdge: number | null;
  transform: ErTransform;
  reqSeq: number;

  load(params: { connId: string; db: string; scope: ErGraphScopePayload; refresh?: boolean }): Promise<void>;
  setDisplayMode(mode: 'full' | 'compact'): void;
  setSearch(search: string): void;
  toggleExpanded(table: string): void;
  setHoverTable(table: string | null): void;
  setHoverEdge(index: number | null): void;
  moveNode(table: string, x: number, y: number): void;
  /** 节点高度变化（展开/折叠/切档）后层内重排，返回各表新 y（调用方回写 positions） */
  repackAfterHeightChange(): void;
  resetLayout(): void;
  setTransform(t: ErTransform): void;
  zoomBy(factor: number, cx: number, cy: number): void;
  resetZoom(): void;
}

export const useErStore = create<ErState>((set, get) => ({
  status: 'loading',
  error: null,
  graph: null,
  scope: null,
  displayMode: 'full',
  search: '',
  expanded: {},
  positions: {},
  hoverTable: null,
  hoverEdge: null,
  transform: { tx: 0, ty: 0, scale: 1 },
  reqSeq: 0,

  async load(params) {
    const seq = get().reqSeq + 1;
    set({ reqSeq: seq, status: 'loading', error: null, scope: params.scope });
    try {
      const graph = await request<ErGraphResult>(RpcMethods.erGraph, params);
      if (get().reqSeq !== seq) {
        return; // 旧响应丢弃（P-6）
      }
      const mode = tierFor(graph.tableCount);
      set({ status: 'ready', graph, displayMode: mode, expanded: {}, positions: {} });
    } catch (err) {
      if (get().reqSeq !== seq) {
        return;
      }
      const code = err instanceof RpcError ? err.code : 'E_INTERNAL';
      set({
        status: 'error',
        error: { code, message: err instanceof Error ? errorCodeToMessage(code, err.message) : String(err) },
      });
    }
  },

  setDisplayMode(mode) {
    set({ displayMode: mode });
    get().repackAfterHeightChange();
  },

  setSearch(search) {
    set({ search });
  },

  toggleExpanded(table) {
    set((s) => ({ expanded: { ...s.expanded, [table]: !s.expanded[table] } }));
    get().repackAfterHeightChange();
  },

  setHoverTable(hoverTable) {
    set({ hoverTable });
  },

  setHoverEdge(hoverEdge) {
    set({ hoverEdge });
  },

  moveNode(table, x, y) {
    set((s) => ({ positions: { ...s.positions, [table]: { x, y } } }));
  },

  repackAfterHeightChange() {
    const { graph, positions, expanded, displayMode } = get();
    if (!graph) {
      return;
    }
    const consts = graph.layout;
    const heightOf = (table: string): number => {
      const t = graph.tables.find((x) => x.name === table);
      const rows = t ? nodeVisibleRows(t, { compact: displayMode === 'compact', expanded: expanded[table] ?? false }) : 0;
      return nodeHeight(rows, consts);
    };
    const nodes = graph.layout.nodes.map((n) => ({
      ...n,
      x: positions[n.table]?.x ?? n.x,
      y: positions[n.table]?.y ?? n.y,
    }));
    const nextY = repackY(nodes, heightOf, consts.nodeGapY);
    const next = { ...positions };
    for (const [table, y] of nextY) {
      const base = nodes.find((n) => n.table === table)!;
      next[table] = { x: base.x, y };
    }
    set({ positions: next });
  },

  resetLayout() {
    set({ positions: {}, expanded: {} });
    get().repackAfterHeightChange();
  },

  setTransform(transform) {
    set({ transform });
  },

  zoomBy(factor, cx, cy) {
    const t = get().transform;
    set({ transform: zoomAtTransform(t, t.scale * factor, cx, cy) });
  },

  resetZoom() {
    const t = get().transform;
    set({ transform: { ...t, scale: clampScale(1) } });
  },
}));

/** 适应画布（需要视口尺寸，放组件侧调用） */
export function fitToViewport(viewport: { width: number; height: number }, graph: ErGraphResult | null): void {
  if (!graph) {
    return;
  }
  useErStore.setState({
    transform: fitTransform(viewport, { width: graph.layout.width, height: graph.layout.height }),
  });
}
