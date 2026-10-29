import { describe, expect, it } from 'vitest';
import {
  buildChartGeom,
  chartSamplingSummary,
  downsampleIndices,
  downsampleRows,
  isChartable,
  isNumericType,
  niceStep,
  parseChartValue,
  pickSeries,
  pickXColumn,
} from './chartView';

describe('可绘性判定', () => {
  it('≥1 数值列且 ≥2 行才可绘', () => {
    expect(isChartable([{ type: 'integer' }, { type: 'string' }], 5)).toBe(true);
    expect(isChartable([{ type: 'integer' }, { type: 'string' }], 1)).toBe(false);
    expect(isChartable([{ type: 'string' }, { type: 'date' }], 5)).toBe(false);
    expect(isChartable([], 5)).toBe(false);
  });

  it('isNumericType 覆盖 integer/decimal/float 三族', () => {
    expect(isNumericType('integer')).toBe(true);
    expect(isNumericType('decimal')).toBe(true);
    expect(isNumericType('float')).toBe(true);
    expect(isNumericType('string')).toBe(false);
    expect(isNumericType('datetime')).toBe(false);
  });
});

describe('C-7 数值解析', () => {
  it('number 直取；decimal 字符串 parseFloat；NULL/空串/非法 = 断点', () => {
    expect(parseChartValue(42)).toBe(42);
    expect(parseChartValue('42.5')).toBe(42.5);
    expect(parseChartValue(' 7 ')).toBe(7);
    expect(parseChartValue(null)).toBeNull();
    expect(parseChartValue('')).toBeNull();
    expect(parseChartValue('abc')).toBeNull();
    expect(parseChartValue({ a: 1 })).toBeNull();
    expect(parseChartValue(Number.NaN)).toBeNull();
  });
});

describe('X 轴与系列选取', () => {
  it('X 轴自动 = 第一个非数值列；全数值则首列', () => {
    const cols = [{ type: 'integer' }, { type: 'string' }, { type: 'integer' }];
    expect(pickXColumn(cols)).toBe(1);
    expect(pickXColumn([{ type: 'float' }, { type: 'decimal' }])).toBe(0);
  });

  it('系列 = 数值列下标（列序），截断上限 6', () => {
    const cols = [
      { type: 'string' },
      { type: 'integer' },
      { type: 'decimal' },
      { type: 'string' },
      { type: 'float' },
      { type: 'integer' },
      { type: 'float' },
      { type: 'integer' },
    ];
    expect(pickSeries(cols)).toEqual([1, 2, 4, 5, 6, 7]);
  });
});

describe('等距抽稀', () => {
  it('不超上限原样返回', () => {
    expect(downsampleIndices(3, 300)).toEqual([0, 1, 2]);
    expect(downsampleRows([1, 2, 3], 300)).toEqual([1, 2, 3]);
  });

  it('超限等距取样且首尾保留', () => {
    const idx = downsampleIndices(1000, 300);
    expect(idx[0]).toBe(0);
    expect(idx[idx.length - 1]).toBe(999);
    expect(new Set(idx).size).toBe(idx.length); // 无重复
    expect(idx.length).toBeLessThanOrEqual(300);
    // 等距性：间隔近似恒定（round 取整有 ±1 抖动——基准间隔 3.33 时 3/4 交替属正确形态）
    for (let i = 2; i < idx.length; i++) {
      const d1 = idx[i] - idx[i - 1];
      const d0 = idx[i - 1] - idx[i - 2];
      expect(Math.abs(d1 - d0)).toBeLessThanOrEqual(1);
    }
  });

  it('n=1 与 n=0 退化安全', () => {
    expect(downsampleIndices(1, 300)).toEqual([0]);
    expect(downsampleIndices(0, 300)).toEqual([]);
  });
});

describe('nice 步长', () => {
  it('落在 1/2/5 × 10^k', () => {
    expect(niceStep(4)).toBe(1);
    expect(niceStep(8)).toBe(2);
    expect(niceStep(20)).toBe(5);
    expect(niceStep(4000)).toBe(1000);
    expect(niceStep(0)).toBe(1);
    expect(niceStep(Number.NaN)).toBe(1);
  });
});

describe('图元几何', () => {
  const cols = [
    { name: 'region', type: 'string' },
    { name: 'sales', type: 'integer' },
    { name: 'cost', type: 'decimal' },
  ];
  const rows = [
    ['east', 100, '80.5'],
    ['west', null, '60'],
    ['north', 150, null],
  ];

  it('折线：数值解析 + NULL 断点 + Y 轴含 0 基线', () => {
    const g = buildChartGeom({ columns: cols, rows, xColumn: 0, seriesColumns: [1, 2], chartType: 'line', width: 600, height: 300 });
    expect(g.series).toHaveLength(2);
    expect(g.series[0].points).toHaveLength(3);
    expect(g.series[0].points[1]).toBeNull(); // sales NULL 断点
    expect(g.series[1].points[2]).toBeNull(); // cost NULL 断点
    expect(g.yMin).toBe(0);
    expect(g.yMax).toBeGreaterThanOrEqual(150);
    // 折线 x 用类目轴首尾贴边
    expect(g.xCenters[0]).toBe(g.padLeft);
    expect(g.bars).toHaveLength(0);
    // Y 刻度在绘图区内
    for (const t of g.yTicks) {
      expect(t.y).toBeGreaterThanOrEqual(g.padTop);
      expect(t.y).toBeLessThanOrEqual(g.padTop + g.plotHeight);
    }
  });

  it('柱状：组中心均分（首尾柱不贴边）、缺柱跳过、组内并列', () => {
    const g = buildChartGeom({ columns: cols, rows, xColumn: 0, seriesColumns: [1, 2], chartType: 'bar', width: 600, height: 300 });
    // east sales 100 + cost 80.5（2）；west sales null（缺）+ cost 60（1）；north sales 150 + cost null（缺）（1）→ 4 柱
    expect(g.bars.length).toBe(4);
    expect(g.xCenters[0]).toBeGreaterThan(g.padLeft); // 组中心不贴左缘
    for (const b of g.bars) {
      expect(b.width).toBeGreaterThan(0);
      expect(b.y).toBeLessThanOrEqual(g.padTop + g.plotHeight);
    }
  });

  it('全同值退化：给 1 个单位高度不除零', () => {
    const g = buildChartGeom({
      columns: cols,
      rows: [['a', 5, '5'], ['b', 5, '5']],
      xColumn: 0,
      seriesColumns: [1, 2],
      chartType: 'line',
      width: 400,
      height: 200,
    });
    expect(g.yMax).toBeGreaterThan(g.yMin);
  });

  it('X 刻度标签等距抽稀 ≤8 且超长截断', () => {
    const many = Array.from({ length: 100 }, (_, i) => [`region-${i}-abcdefghijk`, i]);
    const g = buildChartGeom({
      columns: [{ name: 'r', type: 'string' }, { name: 'v', type: 'integer' }],
      rows: many,
      xColumn: 0,
      seriesColumns: [1],
      chartType: 'line',
      width: 600,
      height: 300,
    });
    expect(g.xTicks.length).toBeLessThanOrEqual(8);
    expect(g.xTicks[0].label).toBe('region-0-ab…');
  });
});

describe('抽稀状态摘要', () => {
  it('标注是否发生抽稀', () => {
    expect(chartSamplingSummary(300, 300)).toEqual({ sampled: false, rowCount: 300, drawn: 300 });
    expect(chartSamplingSummary(2000, 300)).toEqual({ sampled: true, rowCount: 2000, drawn: 300 });
  });
});
