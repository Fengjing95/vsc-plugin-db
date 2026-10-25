import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ErEdgeSummaryPayload, ErGraphScopePayload } from '@db-explorer/protocol';
import { RpcMethods } from '@db-explorer/protocol';
import { Button } from '../components/ui/button';
import { IconCopy, IconInfo, IconMinus, IconPlus, IconRefresh } from '../components/ui/icons';
import { Popover } from '../components/ui/popover';
import {
  crowFootPath,
  edgeGeometry,
  nodeHeight,
  nodeVisibleRows,
  oneTickPath,
  selfLoopGeometry,
  tableMatchesSearch,
  type ErRect,
} from '../lib/erCanvas';
import { buildErSvg, rasterizeSvgToPng, utf8ToBase64, type ErPalette } from '../lib/erExport';
import { t } from '../lib/i18n';
import { request } from '../rpc/client';
import { fitToViewport, useErStore } from '../store/erStore';

/**
 * ER 图页（M8-ER，概要 §5.11 / 交互稿 §13）：库级关系图查看——表节点卡片（列清单 +
 * PK/FK 标识）+ FK 边（鸦爪/单端基数标记）+ 分层布局（Host 计算）。Webview 只做视口
 * 变换（滚轮缩放/平移）、节点拖拽（层内重排防重叠）、悬停高亮与搜索。双击节点打开表格。
 */

/** PK 钥匙图标（内联 SVG，token 色） */
function IconKey({ className }: { className?: string }) {
  return (
    <svg className={className} width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M10.5 1a4.5 4.5 0 0 0-4.36 5.61L1 11.75V15h3.25l1-1v-1.5h1.5l1.25-1.25v-1.5h1.5l1.1-1.1A4.5 4.5 0 1 0 10.5 1Zm1.25 4.5a1.25 1.25 0 1 1 0-2.5 1.25 1.25 0 0 1 0 2.5Z"
        fill="currentColor"
      />
    </svg>
  );
}

/** FK 引用图标 */
function IconLink({ className }: { className?: string }) {
  return (
    <svg className={className} width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M9.35 11.05 7.6 12.8a3 3 0 0 1-4.24-4.25l1.75-1.75M6.65 4.95 8.4 3.2a3 3 0 0 1 4.24 4.25l-1.75 1.75M5.9 10.1l4.2-4.2"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

interface EdgeTip {
  edge: ErEdgeSummaryPayload;
  x: number;
  y: number;
}

export function ErDiagramPage() {
  const boot = window.__BOOTSTRAP__;
  const connId = boot?.params.connId ?? '';
  const db = boot?.params.db ?? '';
  const scope = useMemo<ErGraphScopePayload>(() => {
    try {
      return JSON.parse(boot?.params.scope ?? '{"kind":"all"}') as ErGraphScopePayload;
    } catch {
      return { kind: 'all' };
    }
  }, [boot?.params.scope]);

  // P-17：组件直接订阅底层切片（不经 action 间接读）
  const status = useErStore((s) => s.status);
  const error = useErStore((s) => s.error);
  const graph = useErStore((s) => s.graph);
  const displayMode = useErStore((s) => s.displayMode);
  const search = useErStore((s) => s.search);
  const expanded = useErStore((s) => s.expanded);
  const positions = useErStore((s) => s.positions);
  const hoverTable = useErStore((s) => s.hoverTable);
  const hoverEdge = useErStore((s) => s.hoverEdge);
  const transform = useErStore((s) => s.transform);

  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const [edgeTip, setEdgeTip] = useState<EdgeTip | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; table: string } | null>(null);
  const [exportHint, setExportHint] = useState('');
  const fittedRef = useRef(false);

  useEffect(() => {
    void useErStore.getState().load({ connId, db, scope });
  }, [connId, db, scope]);

  // 视口尺寸（ResizeObserver；首帧后适应画布一次）
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) {
      return;
    }
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (r) {
        setViewport({ width: r.width, height: r.height });
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (status === 'ready' && !fittedRef.current && viewport.width > 0) {
      fittedRef.current = true;
      fitToViewport(viewport, useErStore.getState().graph);
    }
  }, [status, viewport]);

  // 滚轮缩放（以指针为中心；被动监听无法 preventDefault，原生注册）
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) {
      return;
    }
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      useErStore.getState().zoomBy(Math.exp(-e.deltaY * 0.0015), e.clientX - rect.left, e.clientY - rect.top);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    const s = useErStore.getState();
    const rect = viewportRef.current?.getBoundingClientRect();
    const cx = (rect?.width ?? 0) / 2;
    const cy = (rect?.height ?? 0) / 2;
    if (e.key === '+' || e.key === '=') {
      s.zoomBy(1.2, cx, cy);
    } else if (e.key === '-') {
      s.zoomBy(1 / 1.2, cx, cy);
    } else if (e.key === '0') {
      s.setTransform({ ...s.transform, scale: 1 });
    } else if (e.key === '1' && graph) {
      fitToViewport({ width: cx * 2, height: cy * 2 }, graph);
    } else if (e.key === 'Escape') {
      s.setSearch('');
      s.setHoverTable(null);
      s.setHoverEdge(null);
      setContextMenu(null);
      setEdgeTip(null);
    }
  }, [graph]);

  // 背景平移（空白拖拽）
  const panState = useRef<{ px: number; py: number; tx: number; ty: number } | null>(null);
  const onBackgroundPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) {
      return;
    }
    setContextMenu(null);
    setEdgeTip(null);
    const t = useErStore.getState().transform;
    panState.current = { px: e.clientX, py: e.clientY, tx: t.tx, ty: t.ty };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onBackgroundPointerMove = (e: React.PointerEvent) => {
    const p = panState.current;
    if (!p) {
      return;
    }
    useErStore.getState().setTransform({
      tx: p.tx + (e.clientX - p.px),
      ty: p.ty + (e.clientY - p.py),
      scale: useErStore.getState().transform.scale,
    });
  };
  const onBackgroundPointerUp = () => {
    panState.current = null;
  };

  // 导出（交互稿 §13.9）：SVG 从图数据模型直接生成（画布是 HTML+SVG 混合，无法直接序列化）；
  // PNG 在 webview 光栅化（单张图内存有界，C-13 边界确认）；落盘统一走 sys.saveFile（Host 侧）
  const resolvePalette = (): ErPalette => {
    const cs = getComputedStyle(document.documentElement);
    const v = (name: string): string => cs.getPropertyValue(name).trim() || '#888888';
    return {
      background: v('--color-background'),
      panel: v('--color-panel'),
      border: v('--color-border'),
      mutedBg: v('--color-muted'),
      foreground: v('--color-foreground'),
      mutedForeground: v('--color-muted-foreground'),
      warning: v('--color-warning'),
      link: v('--color-link'),
    };
  };
  const doExport = async (kind: 'svg' | 'png'): Promise<void> => {
    const s = useErStore.getState();
    const g = s.graph;
    if (!g || g.tables.length === 0) {
      return;
    }
    try {
      const svg = buildErSvg({
        graph: g,
        positions: s.positions,
        expanded: s.expanded,
        displayMode: s.displayMode,
        palette: resolvePalette(),
      });
      const base64 =
        kind === 'svg'
          ? utf8ToBase64(svg)
          : await rasterizeSvgToPng(svg, g.layout.width + 80, g.layout.height + 80, 2);
      const { path } = await request<{ path: string | null }>(
        RpcMethods.sysSaveFile,
        { defaultName: `er-${db}.${kind}`, base64, title: kind === 'svg' ? t('er.exportSvg') : t('er.exportPng') },
      );
      setExportHint(path ? t('er.exportedTo', [path]) : t('er.cancelled'));
    } catch (err) {
      setExportHint(t('er.exportFailed', [err instanceof Error ? err.message : String(err)]));
    }
    setTimeout(() => setExportHint(''), 6000);
  };

  if (!boot || !connId || !db) {
    return <div className="status error">{t('er.missingParams')}</div>;
  }

  const consts = graph?.layout;

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      {/* 工具栏（图标语义同表格视图 §4.1.1：常驻 + 禁用置灰） */}
      <div className="flex items-center gap-1.5 border-b border-border px-2 py-1.5">
        <input
          value={search}
          onChange={(e) => useErStore.getState().setSearch(e.target.value)}
          placeholder={t('er.searchPlaceholder')}
          aria-label={t('er.searchTables')}
          className="h-6 w-44 rounded-sm border border-input-border bg-input-bg px-2 text-[12px] text-foreground outline-none placeholder:text-placeholder focus-visible:ring-1 focus-visible:ring-ring"
        />
        <div className="mx-1 flex overflow-hidden rounded-sm border border-border" role="group" aria-label={t('er.nodeModeGroup')}>
          <button
            type="button"
            className={`px-2 py-1 text-[12px] ${displayMode === 'full' ? 'bg-selected text-selected-foreground' : 'text-foreground hover:bg-accent'}`}
            onClick={() => useErStore.getState().setDisplayMode('full')}
          >
            {t('er.full')}
          </button>
          <button
            type="button"
            className={`px-2 py-1 text-[12px] ${displayMode === 'compact' ? 'bg-selected text-selected-foreground' : 'text-foreground hover:bg-accent'}`}
            onClick={() => useErStore.getState().setDisplayMode('compact')}
          >
            {t('er.compact')}
          </button>
        </div>
        <Button
          variant="secondary"
          size="icon"
          title={t('er.zoomOut')}
          aria-label={t('er.zoomOut')}
          onClick={() => {
            const rect = viewportRef.current?.getBoundingClientRect();
            useErStore.getState().zoomBy(1 / 1.2, (rect?.width ?? 0) / 2, (rect?.height ?? 0) / 2);
          }}
        >
          <IconMinus />
        </Button>
        <span className="w-12 text-center text-[12px] text-muted-foreground" aria-live="polite">
          {Math.round(transform.scale * 100)}%
        </span>
        <Button
          variant="secondary"
          size="icon"
          title={t('er.zoomIn')}
          aria-label={t('er.zoomIn')}
          onClick={() => {
            const rect = viewportRef.current?.getBoundingClientRect();
            useErStore.getState().zoomBy(1.2, (rect?.width ?? 0) / 2, (rect?.height ?? 0) / 2);
          }}
        >
          <IconPlus />
        </Button>
        <Button variant="secondary" size="sm" title={t('er.fitTitle')} onClick={() => fitToViewport(viewport, graph)}>
          {t('er.fit')}
        </Button>
        <Button variant="secondary" size="sm" title={t('er.relayoutTitle')} onClick={() => useErStore.getState().resetLayout()}>
          {t('er.relayout')}
        </Button>
        <Button
          variant="secondary"
          size="sm"
          title={t('er.exportSvgTitle')}
          disabled={status !== 'ready' || !graph || graph.tables.length === 0}
          onClick={() => void doExport('svg')}
        >
          {t('er.exportSvg')}
        </Button>
        <Button
          variant="secondary"
          size="sm"
          title={t('er.exportPngTitle')}
          disabled={status !== 'ready' || !graph || graph.tables.length === 0}
          onClick={() => void doExport('png')}
        >
          {t('er.exportPng')}
        </Button>
        <Button
          variant="secondary"
          size="icon"
          title={t('er.refreshTitle')}
          aria-label={t('er.refresh')}
          disabled={status === 'loading'}
          onClick={() => void useErStore.getState().load({ connId, db, scope, refresh: true })}
        >
          <IconRefresh />
        </Button>
        <div className="flex-1" />
        <Popover
          align="end"
          trigger={
            <Button variant="secondary" size="sm" title={t('er.legend')}>
              <IconInfo /> {t('er.legend')}
            </Button>
          }
        >
          <div className="space-y-1.5 p-2 text-[12px]">
            <div className="flex items-center gap-1.5">
              <IconKey className="text-warning" />
              <span>{t('er.primaryKeyColumn')}</span>
            </div>
            <div className="flex items-center gap-1.5">
              <IconLink className="text-link" />
              <span>{t('er.foreignKeyColumn')}</span>
            </div>
            <div className="flex items-center gap-1.5">
              <svg width="26" height="12" aria-hidden="true">
                <path d="M0 6 H26" style={{ stroke: 'var(--color-border)' }} strokeWidth="1.5" />
                <path d="M6 1 L13 6 L6 11" fill="none" style={{ stroke: 'var(--color-border)' }} strokeWidth="1.5" />
              </svg>
              <span>{t('er.manySide')}</span>
            </div>
            <div className="flex items-center gap-1.5">
              <svg width="26" height="12" aria-hidden="true">
                <path d="M0 6 H26" style={{ stroke: 'var(--color-border)' }} strokeWidth="1.5" />
                <path d="M18 1 V11 M22 1 V11" style={{ stroke: 'var(--color-border)' }} strokeWidth="1.5" />
              </svg>
              <span>{t('er.oneSide')}</span>
            </div>
            <div className="text-muted-foreground">{t('er.legendHint')}</div>
          </div>
        </Popover>
      </div>

      {/* 画布 */}
      <div
        ref={viewportRef}
        tabIndex={0}
        onKeyDown={onKeyDown}
        className={`relative flex-1 overflow-hidden bg-background outline-none ${status === 'ready' ? 'cursor-grab' : ''}`}
        onPointerDown={onBackgroundPointerDown}
        onPointerMove={onBackgroundPointerMove}
        onPointerUp={onBackgroundPointerUp}
      >
        {status === 'loading' && (
          <div className="absolute inset-0 z-10 flex items-center justify-center text-[13px] text-muted-foreground">
            {t('er.loadingSchema')}
          </div>
        )}
        {status === 'error' && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2">
            <div className="text-destructive">{error?.message ?? t('er.loadFailed')}</div>
            <Button variant="secondary" size="sm" onClick={() => void useErStore.getState().load({ connId, db, scope })}>
              {t('common.retry')}
            </Button>
          </div>
        )}
        {status === 'ready' && graph && graph.tables.length === 0 && (
          <div className="absolute inset-0 z-10 flex items-center justify-center text-[13px] text-muted-foreground">
            {t('er.emptyDb')}
          </div>
        )}

        {status === 'ready' && graph && consts && graph.tables.length > 0 && (
          <div
            className="absolute left-0 top-0 origin-top-left"
            style={{ transform: `translate(${transform.tx}px, ${transform.ty}px) scale(${transform.scale})` }}
          >
            {/* 边层（SVG，overflow visible 承载自环鼓包） */}
            <svg
              className="pointer-events-none absolute left-0 top-0 overflow-visible"
              width={Math.max(1, graph.layout.width)}
              height={Math.max(1, graph.layout.height)}
              aria-hidden="true"
            >
              {graph.edges.map((edge, i) => {
                const geom = edgeGeomOf(graph, edge, positions, expanded, displayMode, consts);
                if (!geom) {
                  return null;
                }
                const dim = edgeDim(edge, search, hoverTable, hoverEdge !== null, hoverEdge === i);
                const highlighted =
                  hoverEdge === i ||
                  (hoverTable !== null && (edge.sourceTable === hoverTable || edge.targetTable === hoverTable));
                const stroke = highlighted ? 'var(--color-primary)' : 'var(--color-border)';
                // SVG presentation attribute 不支持 var()——stroke 必须走 style（CSS 属性）
                return (
                  <g key={`${edge.sourceTable}->${edge.targetTable}:${edge.name ?? i}`} opacity={dim}>
                    <path d={geom.d} fill="none" style={{ stroke, strokeWidth: highlighted ? 2 : 1.5 }} />
                    {geom.foot && geom.tick && (
                      <>
                        <path d={geom.foot} fill="none" style={{ stroke, strokeWidth: 1.5 }} />
                        <path d={geom.tick} fill="none" style={{ stroke, strokeWidth: 1.5 }} />
                      </>
                    )}
                    {/* 悬停命中区（透明宽描边） */}
                    <path
                      d={geom.d}
                      fill="none"
                      stroke="transparent"
                      strokeWidth={10}
                      className="pointer-events-stroke cursor-pointer"
                      onPointerEnter={() => useErStore.getState().setHoverEdge(i)}
                      onPointerLeave={() => useErStore.getState().setHoverEdge(null)}
                      onPointerMove={(e) => {
                        const rect = viewportRef.current?.getBoundingClientRect();
                        if (rect) {
                          setEdgeTip({ edge, x: e.clientX - rect.left + 12, y: e.clientY - rect.top + 12 });
                        }
                      }}
                    />
                  </g>
                );
              })}
            </svg>

            {/* 节点层（HTML 卡片） */}
            {graph.tables.map((tb) => {
              const base = graph.layout.nodes.find((n) => n.table === tb.name);
              const x = positions[tb.name]?.x ?? base?.x ?? 0;
              const y = positions[tb.name]?.y ?? base?.y ?? 0;
              const rows = nodeVisibleRows(tb, { compact: displayMode === 'compact', expanded: expanded[tb.name] ?? false });
              const h = nodeHeight(rows, consts);
              const matched = tableMatchesSearch(tb, search);
              const isHover = hoverTable === tb.name;
              const neighbor = hoverTable !== null && !isHover && isNeighbor(graph, hoverTable, tb.name);
              const dim = !matched || (hoverTable !== null && !isHover && !neighbor);
              const visibleColumns = displayMode === 'compact' ? [] : (expanded[tb.name] ?? false) ? tb.columns : tb.columns.slice(0, 12);
              const tailCount = tb.columns.length - visibleColumns.length + (tb.columnsTruncated ?? 0);
              return (
                <div
                  key={tb.name}
                  tabIndex={0}
                  role="group"
                  aria-label={tb.name}
                  className="absolute select-none rounded-sm border bg-panel shadow-sm outline-none"
                  style={{
                    left: x,
                    top: y,
                    width: consts.nodeWidth,
                    height: h,
                    borderColor: isHover ? 'var(--color-ring)' : 'var(--color-border)',
                    opacity: dim ? 0.25 : 1,
                    cursor: 'grab',
                  }}
                  onPointerDown={(e) => {
                    if (e.button !== 0) {
                      return;
                    }
                    e.stopPropagation();
                    startNodeDrag(e, tb.name, x, y, transform.scale);
                  }}
                  onDoubleClick={(e) => {
                    // 标题栏双击 = 折叠/展开列；其余区域双击 = 打开表格（§13.4）
                    if ((e.target as HTMLElement).closest('[data-zone="header"]')) {
                      useErStore.getState().toggleExpanded(tb.name);
                    } else {
                      void openTable(connId, db, tb.name);
                    }
                  }}
                  onPointerEnter={() => useErStore.getState().setHoverTable(tb.name)}
                  onPointerLeave={() => useErStore.getState().setHoverTable(null)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    const rect = viewportRef.current?.getBoundingClientRect();
                    setContextMenu({ x: e.clientX - (rect?.left ?? 0), y: e.clientY - (rect?.top ?? 0), table: tb.name });
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      void openTable(connId, db, tb.name);
                    }
                  }}
                >
                  {/* 标题栏 */}
                  <div
                    data-zone="header"
                    className="flex h-[30px] cursor-pointer items-center justify-between rounded-t-sm border-b border-border bg-muted px-2"
                    title={
                      displayMode === 'compact'
                        ? `${tb.comment ? `${tb.comment}\n` : ''}${tb.columns.map((c) => c.name).join(', ')}`
                        : (tb.comment ?? tb.name)
                    }
                  >
                    <span className="truncate text-[12px] font-medium text-foreground" title={tb.name}>
                      {tb.name}
                    </span>
                    <span className="ml-1 shrink-0 rounded-sm bg-secondary px-1 text-[10px] text-muted-foreground">
                      {displayMode === 'compact'
                        ? t('er.columnCount', [tb.columns.length + (tb.columnsTruncated ?? 0)])
                        : t('er.columnCount', [tb.columns.length])}
                    </span>
                  </div>
                  {/* 列行（完整档） */}
                  <div className="overflow-hidden">
                    {visibleColumns.map((c) => (
                      <div key={c.name} className="flex h-[22px] items-center justify-between gap-2 px-2 text-[11px] leading-[22px]">
                        <span className="flex min-w-0 items-center gap-1">
                          {c.isPrimaryKey && <IconKey className="shrink-0 text-warning" />}
                          {!c.isPrimaryKey && isFkColumn(graph, tb.name, c.name) && <IconLink className="shrink-0 text-link" />}
                          <span className={`truncate text-foreground ${c.isPrimaryKey ? 'font-medium' : ''}`} title={c.name}>
                            {c.name}
                          </span>
                        </span>
                        <span className="shrink-0 font-mono text-[10px] text-muted-foreground">{c.dataType}</span>
                      </div>
                    ))}
                    {displayMode !== 'compact' && tailCount > 0 && (
                      <button
                        type="button"
                        className="h-[22px] w-full px-2 text-left text-[11px] leading-[22px] text-link hover:bg-accent"
                        onClick={() => useErStore.getState().toggleExpanded(tb.name)}
                      >
                        {t('er.moreColumns', [tailCount])}
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* 边 tooltip（约束名 / 列映射 / 基数） */}
        {edgeTip && (
          <div
            className="pointer-events-none absolute z-20 max-w-[280px] rounded-sm border border-border bg-panel px-2 py-1.5 text-[11px] text-foreground shadow-md"
            style={{ left: edgeTip.x, top: edgeTip.y }}
          >
            <div className="font-medium">{edgeTip.edge.name ?? t('er.foreignKey')}</div>
            <div className="font-mono text-[10px] text-muted-foreground">
              {edgeTip.edge.sourceTable}({edgeTip.edge.sourceColumns.join(', ')}) → {edgeTip.edge.targetTable}
              ({edgeTip.edge.targetColumns.join(', ')})
            </div>
            <div className="text-muted-foreground">{t('er.cardinality')}</div>
          </div>
        )}

        {/* 节点右键菜单（自绘轻量菜单） */}
        {contextMenu && (
          <div
            className="absolute z-30 min-w-[140px] rounded-sm border border-border bg-panel py-1 shadow-md"
            style={{ left: contextMenu.x, top: contextMenu.y }}
            role="menu"
          >
            <button
              type="button"
              className="flex w-full items-center gap-1.5 px-2 py-1 text-left text-[12px] text-foreground hover:bg-accent"
              role="menuitem"
              onClick={() => {
                void openTable(connId, db, contextMenu.table);
                setContextMenu(null);
              }}
            >
              {t('er.openTableView')}
            </button>
            <button
              type="button"
              className="flex w-full items-center gap-1.5 px-2 py-1 text-left text-[12px] text-foreground hover:bg-accent"
              role="menuitem"
              onClick={() => {
                void request(RpcMethods.copyText, { text: contextMenu.table });
                setContextMenu(null);
              }}
            >
              <IconCopy /> {t('er.copyTableName')}
            </button>
          </div>
        )}
      </div>

      {/* 状态行 */}
      <div className="flex items-center gap-2 border-t border-border px-2 py-1 text-[11px] text-muted-foreground">
        {graph ? (
          <>
            <span>{t('er.tableCount', [graph.tableCount])}</span>
            <span>·</span>
            <span>{t('er.edgeCount', [graph.edges.length])}</span>
            {graph.hiddenEdges > 0 && (
              <>
                <span>·</span>
                <span className="text-warning">{t('er.hiddenEdges', [graph.hiddenEdges])}</span>
              </>
            )}
          </>
        ) : (
          <span>—</span>
        )}
        <div className="flex-1" />
        {exportHint && <span className="text-link">{exportHint}</span>}
        <span>{t('er.statusHint')}</span>
      </div>
    </div>
  );
}

/** 节点拖拽（阈值 3px 内视为点击不启动；内容坐标 = 屏幕位移 / scale） */
function startNodeDrag(e: React.PointerEvent, table: string, startX: number, startY: number, scale: number): void {
  const origin = { px: e.clientX, py: e.clientY, x: startX, y: startY };
  let moved = false;
  const el = e.currentTarget as HTMLElement;
  el.setPointerCapture(e.pointerId);
  const onMove = (ev: PointerEvent): void => {
    const dx = (ev.clientX - origin.px) / scale;
    const dy = (ev.clientY - origin.py) / scale;
    if (!moved && Math.hypot(ev.clientX - origin.px, ev.clientY - origin.py) < 3) {
      return;
    }
    moved = true;
    useErStore.getState().moveNode(table, origin.x + dx, origin.y + dy);
  };
  const onUp = (): void => {
    el.removeEventListener('pointermove', onMove);
    el.removeEventListener('pointerup', onUp);
    if (moved) {
      // 拖拽后层内重排：消除与下方节点的重叠（原位优先、重叠才下推）
      useErStore.getState().repackAfterHeightChange();
    }
  };
  el.addEventListener('pointermove', onMove);
  el.addEventListener('pointerup', onUp);
}

async function openTable(connId: string, db: string, table: string): Promise<void> {
  await request(RpcMethods.erOpenTable, { connId, db, table });
}

function isNeighbor(graph: NonNullable<ReturnType<typeof useErStore.getState>['graph']>, a: string, b: string): boolean {
  return graph.edges.some(
    (e) => (e.sourceTable === a && e.targetTable === b) || (e.sourceTable === b && e.targetTable === a),
  );
}

function isFkColumn(
  graph: NonNullable<ReturnType<typeof useErStore.getState>['graph']>,
  table: string,
  column: string,
): boolean {
  return graph.edges.some((e) => e.sourceTable === table && e.sourceColumns.includes(column));
}

/** 边几何（含拖拽后位置与展开后高度；自引用走自环弧，无基数标记） */
function edgeGeomOf(
  graph: NonNullable<ReturnType<typeof useErStore.getState>['graph']>,
  edge: ErEdgeSummaryPayload,
  positions: Record<string, { x: number; y: number }>,
  expanded: Record<string, boolean>,
  displayMode: 'full' | 'compact',
  consts: NonNullable<ReturnType<typeof useErStore.getState>['graph']>['layout'],
): { d: string; foot: string | null; tick: string | null } | null {
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
  const src = rectOf(edge.sourceTable);
  if (!src) {
    return null;
  }
  if (edge.sourceTable === edge.targetTable) {
    return { d: selfLoopGeometry(src), foot: null, tick: null };
  }
  const dst = rectOf(edge.targetTable);
  if (!dst) {
    return null;
  }
  const g = edgeGeometry(src, dst);
  return { d: g.d, foot: crowFootPath(g), tick: oneTickPath(g) };
}

/** 边透明度：搜索过滤 + 悬停高亮（相邻边保持、其余淡化） */
function edgeDim(
  edge: ErEdgeSummaryPayload,
  search: string,
  hoverTable: string | null,
  anyEdgeHover: boolean,
  isHovered: boolean,
): number {
  if (isHovered || (hoverTable !== null && (edge.sourceTable === hoverTable || edge.targetTable === hoverTable))) {
    return 1;
  }
  if (anyEdgeHover || hoverTable !== null) {
    return 0.25;
  }
  const matched =
    tableMatchesSearchByName(edge.sourceTable, search) && tableMatchesSearchByName(edge.targetTable, search);
  return matched ? 1 : 0.15;
}

function tableMatchesSearchByName(name: string, search: string): boolean {
  const q = search.trim().toLowerCase();
  return !q || name.toLowerCase().includes(q);
}
