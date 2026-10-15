import { describe, expect, it } from 'vitest';
import type { ErLayoutNodePayload, ErTableSummaryPayload } from '@db-explorer/protocol';
import {
  ER_COMPACT_TIER_MAX,
  ER_FIT_PADDING,
  ER_FULL_TIER_MAX,
  ER_MAX_SCALE,
  ER_MIN_SCALE,
  ER_NODE_MAX_ROWS,
  clampScale,
  crowFootPath,
  edgeGeometry,
  fitTransform,
  nodeHeight,
  nodeVisibleRows,
  oneTickPath,
  repackY,
  selfLoopGeometry,
  tableMatchesSearch,
  tierFor,
  zoomAtTransform,
  type ErLayoutConsts,
} from './erCanvas';

const consts: ErLayoutConsts = {
  nodes: [],
  width: 0,
  height: 0,
  nodeWidth: 232,
  headerHeight: 30,
  rowHeight: 22,
  padBottom: 8,
  layerGapX: 96,
  nodeGapY: 28,
};

function table(name: string, columns: number, columnsTruncated = 0): ErTableSummaryPayload {
  return {
    name,
    columns: Array.from({ length: columns }, (_, i) => ({ name: `c${i}`, dataType: 'bigint', isPrimaryKey: i === 0 })),
    columnsTruncated,
  };
}

function node(table: string, x: number, y: number, height = 100): ErLayoutNodePayload {
  return { table, x, y, width: 232, height };
}

describe('erCanvas 视口变换（M8-ER）', () => {
  it('clampScale 界定 10%~300%', () => {
    expect(clampScale(0.01)).toBe(ER_MIN_SCALE);
    expect(clampScale(5)).toBe(ER_MAX_SCALE);
    expect(clampScale(1)).toBe(1);
  });

  it('zoomAtTransform：指针下的内容点缩放前后位置不变', () => {
    const t = { tx: 20, ty: 30, scale: 1.2 };
    const cx = 400;
    const cy = 300;
    const contentX = (cx - t.tx) / t.scale;
    const next = zoomAtTransform(t, 2, cx, cy);
    expect((cx - next.tx) / next.scale).toBeCloseTo(contentX);
    expect(next.scale).toBe(2);
  });

  it('fitTransform：等比缩放并居中，留白计入', () => {
    const vp = { width: 1000, height: 800 };
    const t = fitTransform(vp, { width: 920, height: 300 });
    // 宽度方向贴留白：(1000-80)/920 = 1，高度居中
    expect(t.scale).toBeCloseTo((1000 - ER_FIT_PADDING * 2) / 920);
    expect(t.tx).toBeGreaterThanOrEqual(ER_FIT_PADDING - 0.01);
    expect(t.ty).toBeGreaterThan(ER_FIT_PADDING);
    // 空内容 → 100%
    expect(fitTransform(vp, { width: 0, height: 0 }).scale).toBe(1);
  });
});

describe('erCanvas 降级与节点尺寸', () => {
  it('tierFor 分档阈值', () => {
    expect(tierFor(ER_FULL_TIER_MAX)).toBe('full');
    expect(tierFor(ER_FULL_TIER_MAX + 1)).toBe('compact');
    expect(tierFor(ER_COMPACT_TIER_MAX)).toBe('compact');
  });

  it('nodeVisibleRows：紧凑 0 行；完整截断 + 尾行；展开全量', () => {
    const t = table('a', 15);
    expect(nodeVisibleRows(t, { compact: true, expanded: false })).toBe(0);
    expect(nodeVisibleRows(t, { compact: false, expanded: false })).toBe(ER_NODE_MAX_ROWS + 1);
    expect(nodeVisibleRows(t, { compact: false, expanded: true })).toBe(15);
    const trunc = table('b', 3, 10);
    // 3 列 + 10 截断 > 12 → 显示 3 行 + 尾行（共 4 行）；展开 = 全量 13
    expect(nodeVisibleRows(trunc, { compact: false, expanded: false })).toBe(4);
    expect(nodeVisibleRows(trunc, { compact: false, expanded: true })).toBe(13);
  });

  it('nodeHeight 与 core 公式一致', () => {
    expect(nodeHeight(5, consts)).toBe(30 + 5 * 22 + 8);
  });
});

describe('erCanvas 层内重排 repackY', () => {
  it('无重叠保持原位；重叠下推且不同层互不影响', () => {
    const nodes = [
      node('a1', 0, 0, 100),
      node('a2', 0, 90, 100), // 与 a1 重叠（层内）
      node('b1', 328, 5000, 100), // 另一层，远下方
    ];
    const next = repackY(nodes, (t) => (t === 'a1' ? 100 : 100), 28);
    expect(next.get('a1')).toBe(0);
    expect(next.get('a2')).toBe(0 + 100 + 28); // 被 a1 推下
    expect(next.get('b1')).toBe(5000); // 其他层不掺和
  });

  it('展开（变高）节点推动同层后续节点', () => {
    const nodes = [node('a1', 0, 0, 100), node('a2', 0, 128, 100)];
    const next = repackY(nodes, (t) => (t === 'a1' ? 300 : 100), 28);
    expect(next.get('a2')).toBe(300 + 28);
  });
});

describe('erCanvas 边几何与标记', () => {
  it('正向边：水平贝塞尔（子表右缘 → 父表左缘）', () => {
    const g = edgeGeometry({ x: 0, y: 0, width: 232, height: 100 }, { x: 328, y: 0, width: 232, height: 100 });
    expect(g.backward).toBe(false);
    expect(g.start).toEqual({ x: 232, y: 50 });
    expect(g.end).toEqual({ x: 328, y: 50 });
    expect(g.startDir).toEqual({ x: 1, y: 0 });
    expect(g.d.startsWith('M 232 50 C')).toBe(true);
  });

  it('同层/回边：垂直锚点兜底', () => {
    const g = edgeGeometry({ x: 0, y: 0, width: 232, height: 100 }, { x: 0, y: 200, width: 232, height: 100 });
    expect(g.backward).toBe(true);
    expect(g.start).toEqual({ x: 116, y: 100 });
    expect(g.end).toEqual({ x: 116, y: 200 });
    expect(g.endDir).toEqual({ x: 0, y: -1 });
  });

  it('鸦爪在 source 侧收拢、单端标记在 target 侧', () => {
    const g = edgeGeometry({ x: 0, y: 0, width: 232, height: 100 }, { x: 328, y: 0, width: 232, height: 100 });
    // 鸦爪：从 source 锚点两侧收拢到线上一点
    expect(crowFootPath(g)).toBe('M 232 56 L 238 50 L 232 44');
    // 单端：target 锚点前 7px 处垂直短线
    expect(oneTickPath(g)).toBe('M 321 55 L 321 45');
  });

  it('自引用环从右缘出、回到右缘', () => {
    const d = selfLoopGeometry({ x: 0, y: 0, width: 232, height: 100 });
    expect(d.startsWith('M 232 10')).toBe(true);
    expect(d.endsWith('232 92')).toBe(true);
  });
});

describe('erCanvas 搜索过滤', () => {
  it('表名/注释子串、大小写不敏感、空串全命中', () => {
    const t = { ...table('users', 1), comment: '用户表' };
    expect(tableMatchesSearch(t, '')).toBe(true);
    expect(tableMatchesSearch(t, '  ')).toBe(true);
    expect(tableMatchesSearch(t, 'USER')).toBe(true);
    expect(tableMatchesSearch(t, '用户')).toBe(true);
    expect(tableMatchesSearch(t, 'orders')).toBe(false);
  });
});
