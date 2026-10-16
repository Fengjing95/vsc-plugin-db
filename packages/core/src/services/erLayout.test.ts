import { describe, expect, it } from 'vitest';
import {
  ER_LAYER_GAP_X,
  ER_NODE_GAP_Y,
  ER_NODE_WIDTH,
  computeNodeHeight,
  layoutErGraph,
  type ErLayoutNode,
} from './erLayout';

function byName(nodes: ErLayoutNode[]): Map<string, ErLayoutNode> {
  return new Map(nodes.map((n) => [n.table, n]));
}

describe('erLayout（M8-ER 分层布局，D-22）', () => {
  it('链式 FK 沿 source→target 分层（父表在右）', () => {
    const tables = [
      { name: 'child', rows: 3 },
      { name: 'parent', rows: 2 },
      { name: 'grand', rows: 1 },
    ];
    const edges = [
      { source: 'child', target: 'parent' },
      { source: 'parent', target: 'grand' },
    ];
    const r = layoutErGraph(tables, edges);
    const m = byName(r.nodes);
    expect(m.get('child')!.x).toBe(0);
    expect(m.get('parent')!.x).toBe(ER_NODE_WIDTH + ER_LAYER_GAP_X);
    expect(m.get('grand')!.x).toBe(2 * (ER_NODE_WIDTH + ER_LAYER_GAP_X));
    // 同层节点 y 不重叠、画布尺寸容纳全部节点
    for (const n of r.nodes) {
      expect(n.y).toBeGreaterThanOrEqual(0);
      expect(n.y + n.height).toBeLessThanOrEqual(r.height);
    }
  });

  it('同输入同输出（确定性，可快照）', () => {
    const tables = Array.from({ length: 12 }, (_, i) => ({ name: `t${String(i).padStart(2, '0')}`, rows: (i % 4) + 1 }));
    const edges = tables.slice(1).map((t, i) => ({ source: t.name, target: tables[i].name }));
    edges.push({ source: 't00', target: 't11' });
    const a = layoutErGraph(tables, edges);
    const b = layoutErGraph(tables, edges);
    expect(a).toEqual(b);
  });

  it('环形 FK：DFS 打环后仍终止且输出确定（回边不入层约束）', () => {
    const tables = [
      { name: 'a', rows: 1 },
      { name: 'b', rows: 1 },
      { name: 'c', rows: 1 },
    ];
    const edges = [
      { source: 'a', target: 'b' },
      { source: 'b', target: 'c' },
      { source: 'c', target: 'a' }, // 回环
    ];
    const r = layoutErGraph(tables, edges);
    const m = byName(r.nodes);
    expect(m.size).toBe(3);
    // 层号严格随可达方向递增（a→b→c 链不被回环破坏）
    expect(m.get('a')!.x).toBeLessThan(m.get('b')!.x);
    expect(m.get('b')!.x).toBeLessThan(m.get('c')!.x);
  });

  it('自引用边被忽略（不入分层约束），无关系表落第 0 层', () => {
    const tables = [
      { name: 'selfish', rows: 2 },
      { name: 'loose', rows: 1 },
    ];
    const r = layoutErGraph(tables, [
      { source: 'selfish', target: 'selfish' },
      { source: 'loose', target: 'missing' },
    ]);
    const m = byName(r.nodes);
    expect(m.get('selfish')!.x).toBe(0);
    expect(m.get('loose')!.x).toBe(0);
    expect(r.width).toBe(ER_NODE_WIDTH);
  });

  it('层内垂直居中 + 高度按行数公式（常量 core 同源导出）', () => {
    const tables = [
      { name: 'wide', rows: 10 },
      { name: 'narrow', rows: 1 },
    ];
    const r = layoutErGraph(tables, []);
    const m = byName(r.nodes);
    expect(m.get('wide')!.height).toBe(computeNodeHeight(10));
    expect(m.get('narrow')!.height).toBe(computeNodeHeight(1));
    // 同层两节点纵向堆叠：画布高 = 两者高之和 + 层内间距
    expect(r.height).toBe(computeNodeHeight(10) + computeNodeHeight(1) + ER_NODE_GAP_Y);
    // 层高恰为画布高（占满）→ 自 0 起排，narrow 紧随 wide
    expect(m.get('wide')!.y).toBe(0);
    expect(m.get('narrow')!.y).toBe(computeNodeHeight(10) + ER_NODE_GAP_Y);
  });

  it('空图返回零尺寸', () => {
    expect(layoutErGraph([], [])).toEqual({ nodes: [], width: 0, height: 0 });
  });
});
