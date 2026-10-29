import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ConsoleRunItem } from '@db-explorer/protocol';
import { RpcMethods } from '@db-explorer/protocol';
import { Button } from '../../components/ui/button';
import { buildChartSvg, type ChartPalette } from '../../lib/chartExport';
import {
  buildChartGeom,
  CHART_MAX_SERIES,
  chartSamplingSummary,
  downsampleRows,
  parseChartValue,
  pickSeries,
  pickXColumn,
} from '../../lib/chartView';
import { utf8ToBase64, rasterizeSvgToPng } from '../../lib/erExport';
import { t } from '../../lib/i18n';
import { request } from '../../rpc/client';

/**
 * 图表 Tab 内容（ADR D-29 / 交互稿 §7.5）：结果集的只读 SVG 视图——折线/柱状切换、
 * X 轴自动 + 可切换、数值列多选系列、300 点等距抽稀、悬停点值 tooltip、导出 SVG/PNG。
 * 零取数（结果集已在 item）；视图态（图型/轴/系列）为 Tab 局部状态（重开回落默认，v1 口径）。
 */
export function ChartPanel({ item }: { item: ConsoleRunItem }) {
  const rs = item.resultSet;
  if (!rs) {
    return null;
  }
  return <ChartBody key={item.seq} item={item} rs={rs} />;
}

function ChartBody({
  item,
  rs,
}: {
  item: ConsoleRunItem;
  rs: NonNullable<ConsoleRunItem['resultSet']>;
}) {
  const [chartType, setChartType] = useState<'line' | 'bar'>('line');
  const [xCol, setXCol] = useState<number>(() => pickXColumn(rs.columns));
  const [series, setSeries] = useState<number[]>(() => pickSeries(rs.columns));
  const [hint, setHint] = useState('');
  const [tip, setTip] = useState<{ x: number; y: number; rowIdx: number } | null>(null);

  // 容器尺寸（ResizeObserver，erDiagram 同款）
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (r) setSize({ width: r.width, height: r.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const drawn = useMemo(() => downsampleRows(rs.rows), [rs]);
  const geom = useMemo(
    () =>
      size.width > 0 && size.height > 0 && drawn.length > 0 && series.length > 0
        ? buildChartGeom({
            columns: rs.columns,
            rows: drawn,
            xColumn: xCol,
            seriesColumns: series,
            chartType,
            width: size.width,
            height: size.height,
          })
        : null,
    [rs.columns, drawn, xCol, series, chartType, size],
  );

  const toggleSeries = useCallback(
    (col: number) => {
      setSeries((prev) => {
        if (prev.includes(col)) {
          return prev.length > 1 ? prev.filter((c) => c !== col) : prev; // 至少保留 1 个
        }
        if (prev.length >= CHART_MAX_SERIES) {
          setHint(t('console.chartSeriesHint', [CHART_MAX_SERIES]));
          setTimeout(() => setHint(''), 3000);
          return prev;
        }
        return [...prev, col];
      });
    },
    [],
  );

  const resolvePalette = (): ChartPalette => {
    const cs = getComputedStyle(document.documentElement);
    const v = (name: string, fallback: string): string => cs.getPropertyValue(name).trim() || fallback;
    return {
      background: v('--color-background', '#1f1f1f'),
      foreground: v('--color-foreground', '#cccccc'),
      mutedForeground: v('--color-muted-foreground', '#9d9d9d'),
      border: v('--color-border-strong', '#454545'),
      series: [1, 2, 3, 4, 5, 6].map((i) => v(`--color-chart-${i}`, '#3794ff')),
    };
  };

  const doExport = async (kind: 'svg' | 'png'): Promise<void> => {
    if (!geom) return;
    try {
      const svg = buildChartSvg({
        geom,
        palette: resolvePalette(),
        seriesNames: series.map((c) => rs.columns[c].name),
      });
      const base64 =
        kind === 'svg'
          ? utf8ToBase64(svg)
          : await rasterizeSvgToPng(svg, geom.width, geom.height, 2);
      const { path } = await request<{ path: string | null }>(
        RpcMethods.sysSaveFile,
        { defaultName: `chart-${item.seq}.${kind}`, base64, title: kind === 'svg' ? t('console.chartExportSvg') : t('console.chartExportPng') },
      );
      setHint(path ? t('console.chartExportedTo', [path]) : t('console.chartCancelled'));
    } catch (err) {
      setHint(t('console.chartExportFailed', [err instanceof Error ? err.message : String(err)]));
    }
    setTimeout(() => setHint(''), 6000);
  };

  const sampling = chartSamplingSummary(rs.rowCount, drawn.length);
  const xLabelOf = (rowIdx: number): string => {
    const raw = drawn[rowIdx]?.[xCol];
    return raw === null || raw === undefined ? '' : String(raw);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 工具行：图型 / X 轴 / 系列 / 导出 */}
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-2 py-1.5 text-[12px]">
        <div className="flex overflow-hidden rounded-sm border border-border" role="group" aria-label={t('console.chartTab')}>
          {(['line', 'bar'] as const).map((k) => (
            <button
              key={k}
              type="button"
              className={`px-2 py-0.5 ${chartType === k ? 'bg-selected text-selected-foreground' : 'text-foreground hover:bg-accent'}`}
              onClick={() => setChartType(k)}
            >
              {k === 'line' ? t('console.chartLine') : t('console.chartBar')}
            </button>
          ))}
        </div>
        <label className="flex items-center gap-1 text-muted-foreground">
          {t('console.chartXAxis')}
          <select
            value={xCol}
            onChange={(e) => setXCol(Number(e.target.value))}
            className="h-6 rounded-sm border border-border bg-input px-1 text-[12px] text-foreground"
          >
            {rs.columns.map((c, i) => (
              <option key={c.name} value={i}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <div className="flex flex-wrap items-center gap-1" role="group" aria-label={t('console.chartSeries')}>
          <span className="text-muted-foreground">{t('console.chartSeries')}</span>
          {pickSeries(rs.columns).map((c) => (
            <button
              key={c}
              type="button"
              aria-pressed={series.includes(c)}
              className={`rounded-sm border px-1.5 py-0.5 text-[11px] ${
                series.includes(c) ? 'border-primary bg-selected text-selected-foreground' : 'border-border text-muted-foreground hover:bg-accent'
              }`}
              onClick={() => toggleSeries(c)}
            >
              {rs.columns[c].name}
            </button>
          ))}
        </div>
        <div className="flex-1" />
        <Button variant="secondary" size="sm" disabled={!geom} onClick={() => void doExport('svg')}>
          {t('console.chartExportSvg')}
        </Button>
        <Button variant="secondary" size="sm" disabled={!geom} onClick={() => void doExport('png')}>
          {t('console.chartExportPng')}
        </Button>
      </div>

      {/* 绘图区 */}
      <div ref={wrapRef} className="relative min-h-0 flex-1 overflow-hidden">
        {geom && (
          <svg
            width={geom.width}
            height={geom.height}
            className="absolute left-0 top-0"
            role="img"
            aria-label={t('console.chartTab')}
            onPointerLeave={() => setTip(null)}
          >
            {/* 网格 + Y 刻度 */}
            {geom.yTicks.map((tk, i) => (
              <g key={i}>
                <line
                  x1={geom.padLeft}
                  x2={geom.padLeft + geom.plotWidth}
                  y1={tk.y}
                  y2={tk.y}
                  style={{ stroke: 'var(--color-border)' }}
                  strokeWidth={1}
                  opacity={0.5}
                />
                <text x={geom.padLeft - 8} y={tk.y + 3.5} textAnchor="end" fontSize={10} style={{ fill: 'var(--color-muted-foreground)' }} fontFamily="monospace">
                  {tk.label}
                </text>
              </g>
            ))}
            {/* 轴基线 */}
            <line x1={geom.padLeft} x2={geom.padLeft} y1={geom.padTop} y2={geom.padTop + geom.plotHeight} style={{ stroke: 'var(--color-border-strong)' }} />
            <line
              x1={geom.padLeft}
              x2={geom.padLeft + geom.plotWidth}
              y1={geom.padTop + geom.plotHeight}
              y2={geom.padTop + geom.plotHeight}
              style={{ stroke: 'var(--color-border-strong)' }}
            />
            {/* X 刻度 */}
            {geom.xTicks.map((tk, i) => (
              <text key={i} x={tk.x} y={geom.padTop + geom.plotHeight + 16} textAnchor="middle" fontSize={10} style={{ fill: 'var(--color-muted-foreground)' }}>
                {tk.label}
              </text>
            ))}
            {/* 折线段（NULL 断点） */}
            {chartType === 'line' &&
              geom.series.map((s, si) => {
                const segs: string[] = [];
                let d = '';
                let pen = false;
                for (const p of s.points) {
                  if (!p) {
                    if (pen) segs.push(d);
                    d = '';
                    pen = false;
                    continue;
                  }
                  d += `${pen ? 'L' : 'M'} ${p.x.toFixed(1)} ${p.y.toFixed(1)} `;
                  pen = true;
                }
                if (pen) segs.push(d);
                return (
                  <g key={si}>
                    {segs.map((seg, gi) => (
                      <path key={gi} d={seg} fill="none" style={{ stroke: `var(--color-chart-${(si % 6) + 1})` }} strokeWidth={2} strokeLinejoin="round" />
                    ))}
                    {s.points.map((p, pi) =>
                      p ? <circle key={pi} cx={p.x} cy={p.y} r={2.5} style={{ fill: `var(--color-chart-${(si % 6) + 1})` }} /> : null,
                    )}
                    {/* 悬停命中区（透明宽描边；细线 bbox 零高——e2e 按坐标交互，P-82②） */}
                    {s.points.map((p, pi) =>
                      p ? (
                        <circle
                          key={`h${pi}`}
                          cx={p.x}
                          cy={p.y}
                          r={7}
                          fill="transparent"
                          style={{ pointerEvents: 'all' }}
                          onPointerEnter={() => setTip({ x: p.x, y: p.y, rowIdx: pi })}
                        />
                      ) : null,
                    )}
                  </g>
                );
              })}
            {/* 柱状图元 */}
            {chartType === 'bar' &&
              geom.bars.map((b, bi) => (
                <rect
                  key={bi}
                  x={b.x}
                  y={b.y}
                  width={b.width}
                  height={Math.max(1, geom.padTop + geom.plotHeight - b.y)}
                  style={{ fill: `var(--color-chart-${(b.series % 6) + 1})` }}
                  opacity={0.85}
                  onPointerEnter={() => {
                    // 组中心行序 = xCenters 的序（每行一格）
                    const rowIdx = geom.xCenters.findIndex((cx) => Math.abs(cx - (b.x + b.width / 2)) < 0.6);
                    if (rowIdx >= 0) setTip({ x: b.x + b.width / 2, y: b.y, rowIdx });
                  }}
                />
              ))}
            {/* 悬停 tooltip（点值摘要） */}
            {tip && (
              <g pointerEvents="none">
                <line
                  x1={geom.xCenters[tip.rowIdx] ?? tip.x}
                  x2={geom.xCenters[tip.rowIdx] ?? tip.x}
                  y1={geom.padTop}
                  y2={geom.padTop + geom.plotHeight}
                  style={{ stroke: 'var(--color-border-strong)' }}
                  strokeDasharray="3 3"
                />
                {(() => {
                  const lines = [
                    xLabelOf(tip.rowIdx).slice(0, 24) || '—',
                    ...series.map((c) => `${rs.columns[c].name}: ${fmtVal(drawn[tip.rowIdx]?.[c], rs.columns[c].type)}`),
                  ];
                  const w = Math.max(...lines.map((l) => l.length)) * 6.4 + 12;
                  const h = lines.length * 14 + 8;
                  const bx = Math.min(tip.x + 10, geom.width - w - 4);
                  const by = Math.max(tip.y - h - 6, 4);
                  return (
                    <>
                      <rect x={bx} y={by} width={w} height={h} rx={3} style={{ fill: 'var(--color-panel)', stroke: 'var(--color-border)' }} />
                      {lines.map((l, i) => (
                        <text key={i} x={bx + 6} y={by + 16 + i * 14} fontSize={10} style={{ fill: i === 0 ? 'var(--color-muted-foreground)' : 'var(--color-foreground)' }}>
                          {l}
                        </text>
                      ))}
                    </>
                  );
                })()}
              </g>
            )}
          </svg>
        )}
        {!geom && (
          <div className="flex h-full items-center justify-center text-[13px] text-muted-foreground">
            {drawn.length === 0 || rs.rowCount < 2 ? t('console.chartTab') : t('console.chartSeries')}
          </div>
        )}
      </div>

      {/* 状态行 */}
      <div className="flex items-center gap-2 border-t border-border px-2 py-1 text-[11px] text-muted-foreground">
        <span>
          {sampling.sampled ? t('console.chartSampled', [sampling.rowCount, sampling.drawn]) : t('console.chartPoints', [sampling.drawn])}
        </span>
        <span>·</span>
        <span>{t('console.chartSeries')} {series.length}</span>
        <div className="flex-1" />
        {hint && <span className="text-link">{hint}</span>}
      </div>
    </div>
  );
}

/** 悬停/tooltip 值格式（原始值直显 + decimal 字符串解析失败提示原样） */
function fmtVal(v: unknown, type: string): string {
  if (v === null || v === undefined) return '—';
  if (type === 'decimal' || type === 'float' || type === 'integer') {
    const n = parseChartValue(v);
    if (n !== null) return String(n);
  }
  return String(v);
}
