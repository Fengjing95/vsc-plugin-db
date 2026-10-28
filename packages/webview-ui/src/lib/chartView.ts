/**
 * 结果图表化纯函数层（ADR D-29，交互稿 §7.5）：可绘性判定 / 数值解析 / X 轴与系列选取 /
 * 等距抽稀 / SVG 图元几何。全部纯函数（有单测）；渲染由 ChartPanel 消费（零依赖手绘 SVG，
 * erExport 同源口径）。数据源 = 结果集（已在面板，零取数）；抽稀在 webview 内做属渲染延伸
 * （C-13 边界同 §13.9）。
 */

export const CHART_MAX_POINTS = 300;
export const CHART_MAX_SERIES = 6;

const NUMERIC_TYPES = new Set(['integer', 'decimal', 'float']);

export function isNumericType(type: string): boolean {
  return NUMERIC_TYPES.has(type);
}

/** 可绘判定：≥1 数值列 且 ≥2 行（§7.5；不可绘不显示图表 Tab） */
export function isChartable(columns: Array<{ type: string }>, rowCount: number): boolean {
  return rowCount >= 2 && columns.some((c) => isNumericType(c.type));
}

/** C-7 数值解析：number 直取；decimal/字符串形态 parseFloat；NULL/解析失败 → null（断点） */
export function parseChartValue(v: unknown): number | null {
  if (typeof v === 'number') {
    return Number.isFinite(v) ? v : null;
  }
  if (typeof v === 'string') {
    const t = v.trim();
    if (t === '') {
      return null;
    }
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** X 轴自动选取：第一个非数值列；全数值列则首列（§7.5） */
export function pickXColumn(columns: Array<{ type: string }>): number {
  for (let i = 0; i < columns.length; i++) {
    if (!isNumericType(columns[i].type)) {
      return i;
    }
  }
  return 0;
}

/** 系列选取：数值列下标（按列序），截断 CHART_MAX_SERIES */
export function pickSeries(columns: Array<{ type: string }>): number[] {
  const out: number[] = [];
  for (let i = 0; i < columns.length && out.length < CHART_MAX_SERIES; i++) {
    if (isNumericType(columns[i].type)) {
      out.push(i);
    }
  }
  return out;
}

/**
 * 等距抽稀（首尾保留）：rows.length ≤ max 原样返回；否则按下标等距取样。
 * 同一函数用于行抽稀与刻度标签抽稀（有单测锁定首尾保留语义）。
 */
export function downsampleIndices(n: number, max: number): number[] {
  if (n <= 0) {
    return [];
  }
  if (n <= max) {
    return Array.from({ length: n }, (_, i) => i);
  }
  const out: number[] = [];
  for (let i = 0; i < max; i++) {
    const idx = Math.round((i * (n - 1)) / (max - 1));
    if (out.length === 0 || out[out.length - 1] !== idx) {
      out.push(idx);
    }
  }
  return out;
}

export function downsampleRows<T>(rows: readonly T[], max = CHART_MAX_POINTS): T[] {
  return downsampleIndices(rows.length, max).map((i) => rows[i]);
}

/** 数值刻度步长（1/2/5 × 10^k nice number，覆盖数据范围成 4~6 档） */
export function niceStep(range: number): number {
  if (!(range > 0) || !Number.isFinite(range)) {
    return 1;
  }
  const target = range / 4;
  const mag = Math.pow(10, Math.floor(Math.log10(target)));
  const frac = target / mag;
  const step = frac >= 5 ? 5 : frac >= 2 ? 2 : 1;
  return step * mag;
}

function formatTick(v: number): string {
  if (v === 0) {
    return '0';
  }
  const abs = Math.abs(v);
  if (abs >= 1e9 || (abs < 1e-3 && abs > 0)) {
    return v.toExponential(1);
  }
  if (Number.isInteger(v)) {
    return String(v);
  }
  const s = String(Math.round(v * 100) / 100);
  return s;
}

export interface ChartPoint {
  x: number;
  y: number;
}

export interface ChartSeriesGeom {
  /** 折线断点用 null（§7.5：NULL/解析失败断开）；柱状缺柱不产出 */
  points: Array<ChartPoint | null>;
}

export interface ChartXTick {
  x: number;
  label: string;
}

export interface ChartYTick {
  y: number;
  label: string;
}

export interface ChartGeom {
  width: number;
  height: number;
  padLeft: number;
  padTop: number;
  plotWidth: number;
  plotHeight: number;
  /** 类目中心 x（按抽稀后行序），折线/柱状共用 */
  xCenters: number[];
  xTicks: ChartXTick[];
  yTicks: ChartYTick[];
  yMin: number;
  yMax: number;
  series: ChartSeriesGeom[];
  /** 柱状图元（series 序、组内并列）；折线模式为空 */
  bars: Array<ChartPoint & { width: number; series: number }>;
  /** 柱宽（柱状布局复用给悬停命中计算） */
  barGroupWidth: number;
}

export interface BuildChartArgs {
  columns: Array<{ name: string; type: string }>;
  /** 抽稀后的行（§7.5：抽稀在几何前完成） */
  rows: unknown[][];
  xColumn: number;
  seriesColumns: number[];
  chartType: 'line' | 'bar';
  width: number;
  height: number;
}

const PAD_LEFT = 56;
const PAD_RIGHT = 16;
const PAD_TOP = 12;
const PAD_BOTTOM = 34;

/** 图元几何（§7.5）：轴范围 / 类目轴中心 / 刻度（X 标签等距抽稀 ≤8、Y nice 步长）/ 折线点与柱图元 */
export function buildChartGeom(args: BuildChartArgs): ChartGeom {
  const { rows, xColumn, seriesColumns, chartType, width, height } = args;
  const plotWidth = Math.max(1, width - PAD_LEFT - PAD_RIGHT);
  const plotHeight = Math.max(1, height - PAD_TOP - PAD_BOTTOM);

  const xCenters = rows.map((_, i) => PAD_LEFT + (rows.length === 1 ? plotWidth / 2 : (i * plotWidth) / (rows.length - 1)));
  // 柱状类目轴：组中心均分（与折线共用 xCenters 会让首尾柱贴边）——按「每行一格」均分
  const barXCenters =
    chartType === 'bar'
      ? rows.map((_, i) => PAD_LEFT + ((i + 0.5) * plotWidth) / Math.max(1, rows.length))
      : xCenters;

  // Y 轴范围：数据 min/max，含 0 基线（全正从 0 起、全负到 0 止——分布可读性优先）
  let yMin = Number.POSITIVE_INFINITY;
  let yMax = Number.NEGATIVE_INFINITY;
  const seriesValues: Array<Array<number | null>> = seriesColumns.map((col) =>
    rows.map((row) => parseChartValue(row[col])),
  );
  for (const vals of seriesValues) {
    for (const v of vals) {
      if (v !== null) {
        yMin = Math.min(yMin, v);
        yMax = Math.max(yMax, v);
      }
    }
  }
  if (!Number.isFinite(yMin)) {
    yMin = 0;
    yMax = 1;
  }
  yMin = Math.min(0, yMin);
  yMax = Math.max(0, yMax, yMin + 1); // 退化：全同值时给 1 个单位高度
  if (yMax === yMin) {
    yMax = yMin + 1;
  }

  const yTicks: ChartYTick[] = [];
  const step = niceStep(yMax - yMin);
  const first = Math.ceil(yMin / step) * step;
  for (let v = first; v <= yMax + 1e-9; v += step) {
    yTicks.push({ y: PAD_TOP + plotHeight - ((v - yMin) / (yMax - yMin)) * plotHeight, label: formatTick(v) });
  }

  // X 刻度标签：等距抽稀 ≤8（标签防重叠）
  const labels = rows.map((row) => {
    const raw = row[xColumn];
    return raw === null || raw === undefined ? '' : String(raw);
  });
  const xTickIdx = downsampleIndices(rows.length, 8);
  const xTicks = xTickIdx.map((i) => ({
    x: chartType === 'bar' ? barXCenters[i] : xCenters[i],
    label: labels[i].length > 12 ? `${labels[i].slice(0, 11)}…` : labels[i],
  }));

  const toY = (v: number): number => PAD_TOP + plotHeight - ((v - yMin) / (yMax - yMin)) * plotHeight;

  const series: ChartSeriesGeom[] = seriesValues.map((vals) => ({
    points: vals.map((v, i) => (v === null ? null : { x: xCenters[i], y: toY(v) })),
  }));

  const bars: Array<ChartPoint & { width: number; series: number }> = [];
  let barGroupWidth = 0;
  if (chartType === 'bar') {
    const groupWidth = (plotWidth / Math.max(1, rows.length)) * 0.7;
    barGroupWidth = groupWidth;
    const barWidth = groupWidth / Math.max(1, seriesColumns.length);
    seriesValues.forEach((vals, si) => {
      vals.forEach((v, i) => {
        if (v === null) {
          return; // 缺柱
        }
        bars.push({
          x: barXCenters[i] - groupWidth / 2 + si * barWidth,
          y: toY(v),
          width: Math.max(1, barWidth - 1),
          series: si,
        });
      });
    });
  }

  return {
    width,
    height,
    padLeft: PAD_LEFT,
    padTop: PAD_TOP,
    plotWidth,
    plotHeight,
    xCenters: chartType === 'bar' ? barXCenters : xCenters,
    xTicks,
    yTicks,
    yMin,
    yMax,
    series,
    bars,
    barGroupWidth,
  };
}

/** 状态行文案数据（N 行 → M 点（抽稀）；不抽稀时 rows = drawn） */
export function chartSamplingSummary(rowCount: number, drawn: number): { sampled: boolean; rowCount: number; drawn: number } {
  return { sampled: rowCount > drawn, rowCount, drawn };
}
