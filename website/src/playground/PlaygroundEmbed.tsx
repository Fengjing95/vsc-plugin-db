import { useCallback, useEffect, useRef, useState } from 'react';
import { getSiteContent, site, withBase, type SiteContent } from '../content/site';
import { useSiteLang } from '../i18n/lang';
import { installPlaygroundHost } from './host';
import './playground.css';

/** 必须在模块加载即安装：任何 webview iframe 的 glue postMessage 都依赖 window.parent.__DBX_HOST__ */
const host = installPlaygroundHost();

const CONN_ID = 'mock';
const CONSOLE_ID = 'main';

/** Console Tab 顶部的示例 SQL（真产品里 SQL 在原生编辑器输入，外壳在此提供代答输入区；
 *  不带注释行——mock 解释器不剥前导注释，注释会进语句文本） */
const CONSOLE_DEMO_SQL = 'SELECT id, name, email FROM users ORDER BY id DESC LIMIT 5;';

type ObjectInfo = { name: string; kind: string; comment?: string; rowEstimate?: number };
type DbInfo = { name: string; comment?: string };
type Tab =
  | { key: string; kind: 'table'; db: string; obj: string; objKind: string; rowEstimate?: number }
  | { key: string; kind: 'console' }
  | { key: string; kind: 'er'; db: string }
  | { key: string; kind: 'design'; db: string; obj: string };

const tableKey = (db: string, obj: string) => `t:${db}/${obj}`;

/** 欢迎页快捷入口的跳转目标（展示文案取词典 playground.quickOpen，按下标配对） */
const QUICK_OPEN: { db: string; obj: string }[] = [
  { db: 'demo', obj: 'users' },
  { db: 'demo', obj: 'wide' },
  { db: 'big', obj: 't001' },
];

function tabTitle(t: Tab, pg: SiteContent['playground']): string {
  switch (t.kind) {
    case 'table':
      return t.obj;
    case 'console':
      return pg.cardConsoleTitle;
    case 'er':
      return `${pg.erTabPrefix} ${t.db}`;
    case 'design':
      return `${pg.designTabPrefix} ${t.obj}`;
  }
}

export function PlaygroundEmbed() {
  const lang = useSiteLang();
  const pg = getSiteContent(lang).playground;
  const [dbs, setDbs] = useState<DbInfo[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(['demo']));
  const [objects, setObjects] = useState<Record<string, ObjectInfo[]>>({});
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [sqlDraft, setSqlDraft] = useState(CONSOLE_DEMO_SQL);
  const consoleFrameRef = useRef<HTMLIFrameElement | null>(null);

  useEffect(() => {
    let alive = true;
    host
      .listDatabases()
      .then((rows) => {
        if (alive) setDbs(rows);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  const loadObjects = useCallback(
    (db: string) => {
      host
        .listObjects(db)
        .then((rows) => setObjects((prev) => ({ ...prev, [db]: rows })))
        .catch(() => undefined);
    },
    [],
  );

  // 初始展开的库（demo）不会经 toggleDb 触发拉取，挂载时补一次
  useEffect(() => {
    loadObjects('demo');
  }, [loadObjects]);

  // Host → 外壳回调：ER 双击开表 / DDL 执行后刷新树 / Console ✕ 关 Tab
  useEffect(() => {
    host.onOpenTable = (db, obj) => openTableTab(db, { name: obj, kind: 'table' });
    host.onSchemaChanged = (db) => loadObjects(db);
    host.onCloseConsole = () => closeTab('console');
    return () => {
      host.onOpenTable = undefined;
      host.onSchemaChanged = undefined;
      host.onCloseConsole = undefined;
    };
  });

  const toggleDb = (db: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(db)) {
        next.delete(db);
      } else {
        next.add(db);
        if (!objects[db]) loadObjects(db);
      }
      return next;
    });
  };

  const openTab = (t: Tab) => {
    setTabs((prev) => (prev.some((x) => x.key === t.key) ? prev : [...prev, t]));
    setActiveKey(t.key);
  };

  const openTableTab = (db: string, o: ObjectInfo) =>
    openTab({ key: tableKey(db, o.name), kind: 'table', db, obj: o.name, objKind: o.kind, rowEstimate: o.rowEstimate });

  const closeTab = (key: string) => {
    setTabs((prev) => {
      const idx = prev.findIndex((t) => t.key === key);
      const next = prev.filter((t) => t.key !== key);
      setActiveKey((cur) => (cur === key ? (next[Math.min(idx, next.length - 1)]?.key ?? null) : cur));
      return next;
    });
  };

  // 重置 = 整页 reload：模块态全新，mock 数据（resetMockStore 只还原行数据）
  // 与 DDL 结构变更（tableDefs 就地变更，无还原 API）一并彻底还原
  const resetDemo = () => {
    window.location.reload();
  };

  const activeTab = tabs.find((t) => t.key === activeKey) ?? null;

  /** 外壳代答输入：把 console.execute 的事件路由进 Console iframe（结果全靠 evt 推送） */
  const runConsoleSql = (sql: string) => {
    const w = consoleFrameRef.current?.contentWindow;
    if (!w || !sql.trim()) return;
    const emit = (event: string, payload: unknown) =>
      w.dispatchEvent(new MessageEvent('message', { data: { kind: 'evt', event, payload } }));
    void host
      .handle(
        'console.execute',
        { consoleId: CONSOLE_ID, sql },
        { viewId: `console:${CONSOLE_ID}`, params: { consoleId: CONSOLE_ID }, emit },
      )
      .catch(() => undefined);
  };

  const iframeSrc = (t: Tab) => {
    let params: Record<string, string>;
    switch (t.kind) {
      case 'table':
        params = {
          page: 'table',
          viewId: `${CONN_ID}/${t.db}/${t.obj}`,
          connId: CONN_ID,
          db: t.db,
          obj: t.obj,
          env: 'dev',
          rowEstimate: String(t.rowEstimate ?? ''),
        };
        break;
      case 'console':
        params = { page: 'console', viewId: `console:${CONSOLE_ID}`, consoleId: CONSOLE_ID };
        break;
      case 'er':
        params = {
          page: 'erDiagram',
          viewId: `er:${t.db}`,
          connId: CONN_ID,
          db: t.db,
          scope: JSON.stringify({ kind: 'all' }),
        };
        break;
      case 'design':
        params = {
          page: 'tableDesign',
          viewId: `tableDesign:${CONN_ID}/${t.db}/${t.obj}`,
          connId: CONN_ID,
          db: t.db,
          obj: t.obj,
        };
        break;
    }
    // 站点语言随 URL 透传进 iframe（glue 注入 __BOOTSTRAP__.lang/messages）；
    // 切换语言时 src 变化 → iframe 重载，webview 以新语言重新握手
    return `${withBase('playground/webview/index.html')}?${new URLSearchParams({ ...params, lang }).toString()}`;
  };

  return (
    <div className="pg-embed-wrap">
      <div className="pg" role="application" aria-label={pg.frameAria}>
        {/* 标题栏 */}
        <div className="pg-titlebar">
          <span className="pg-lights" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          <span className="pg-title">{pg.titleBar}</span>
          <span className="pg-back" aria-hidden="true" />
        </div>

        <div className="pg-body">
          {/* 活动栏 */}
          <div className="pg-activity" aria-hidden="true">
            <span className="pg-activity__icon is-active" title={pg.activityExplorer}>
              <DbIcon />
            </span>
            <span className="pg-activity__icon" title={pg.activitySearch}>
              <SearchIcon />
            </span>
            <span className="pg-activity__bottom" title={pg.activityAccount}>
              <GearIcon />
            </span>
          </div>

          {/* 侧栏：资源树 */}
          <aside className="pg-sidebar">
            <div className="pg-sidebar__head">
              <span>{pg.sidebarHeader}</span>
              <span className="pg-sidebar__btns">
                <button className="pg-icon-btn" type="button" title={pg.openConsoleTitle} onClick={() => openTab({ key: 'console', kind: 'console' })}>
                  <TerminalIcon />
                </button>
                <button className="pg-icon-btn" type="button" title={pg.resetTitle} onClick={resetDemo}>
                  <ResetIcon />
                </button>
              </span>
            </div>
            <div className="pg-tree" role="tree" aria-label={pg.treeAria}>
              <div className="pg-tree__row pg-tree__row--conn is-expanded" role="treeitem" aria-expanded="true">
                <ChevronIcon />
                <PlugIcon />
                <span>{pg.treeRoot}</span>
              </div>
              {dbs.map((db) => {
                const isOpen = expanded.has(db.name);
                return (
                  <div key={db.name} role="treeitem" aria-expanded={isOpen}>
                    <div
                      className={`pg-tree__row pg-tree__row--db${isOpen ? ' is-expanded' : ''}`}
                      onClick={() => toggleDb(db.name)}
                      onKeyDown={(e) => e.key === 'Enter' && toggleDb(db.name)}
                      tabIndex={0}
                      title={db.comment}
                    >
                      <ChevronIcon />
                      <DbGlyphIcon />
                      <span>{db.name}</span>
                      <span className="pg-tree__actions">
                        <button
                          className="pg-tree__act"
                          type="button"
                          title={pg.erActionTitle.replace('{0}', db.name)}
                          onClick={(e) => {
                            e.stopPropagation();
                            openTab({ key: `er:${db.name}`, kind: 'er', db: db.name });
                          }}
                        >
                          <ErIcon />
                        </button>
                      </span>
                    </div>
                    {isOpen &&
                      (objects[db.name] ?? []).map((o) => (
                        <div
                          key={o.name}
                          className={`pg-tree__row pg-tree__row--obj${o.kind === 'view' ? ' is-view' : ''}${
                            activeKey === tableKey(db.name, o.name) ? ' is-active' : ''
                          }`}
                          onClick={() => openTableTab(db.name, o)}
                          onKeyDown={(e) => e.key === 'Enter' && openTableTab(db.name, o)}
                          tabIndex={0}
                          role="treeitem"
                          title={o.comment}
                        >
                          <span className="pg-tree__indent" aria-hidden="true" />
                          {o.kind === 'view' ? <ViewIcon /> : <TableIcon />}
                          <span className="pg-tree__name">{o.name}</span>
                          {typeof o.rowEstimate === 'number' && (
                            <span className="pg-tree__estimate">{fmtCount(o.rowEstimate)}</span>
                          )}
                          {o.kind === 'table' && (
                            <span className="pg-tree__actions">
                              <button
                                className="pg-tree__act"
                                type="button"
                                title={pg.designActionTitle.replace('{0}', o.name)}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  openTab({ key: `design:${db.name}/${o.name}`, kind: 'design', db: db.name, obj: o.name });
                                }}
                              >
                                <DesignIcon />
                              </button>
                            </span>
                          )}
                        </div>
                      ))}
                  </div>
                );
              })}
            </div>
            <div className="pg-sidebar__foot">{pg.sidebarFoot}</div>
          </aside>

          {/* 编辑器区 */}
          <div className="pg-editor">
            <div className="pg-tabs" role="tablist">
              {tabs.map((t) => (
                <div
                  key={t.key}
                  className={`pg-tab${t.key === activeKey ? ' is-active' : ''}`}
                  role="tab"
                  aria-selected={t.key === activeKey}
                  onClick={() => setActiveKey(t.key)}
                >
                  <TabIcon tab={t} />
                  <span>{tabTitle(t, pg)}</span>
                  <button
                    className="pg-tab__close"
                    type="button"
                    aria-label={pg.closeTabAria.replace('{0}', tabTitle(t, pg))}
                    onClick={(e) => {
                      e.stopPropagation();
                      closeTab(t.key);
                    }}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
            <div className="pg-editor__area">
              {tabs.length === 0 ? (
                <Welcome
                  onOpen={(db, o) => openTableTab(db, o)}
                  onConsole={() => openTab({ key: 'console', kind: 'console' })}
                  onEr={() => openTab({ key: 'er:shop', kind: 'er', db: 'shop' })}
                />
              ) : (
                <>
                  {activeTab?.kind === 'console' && (
                    <div className="pg-sqlbox">
                      <textarea
                        value={sqlDraft}
                        onChange={(e) => setSqlDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                            e.preventDefault();
                            runConsoleSql(sqlDraft);
                          }
                        }}
                        spellCheck={false}
                        aria-label={pg.sqlInputAria}
                        placeholder={pg.sqlPlaceholder}
                      />
                      <div className="pg-sqlbox__bar">
                        <span>{pg.hintBar}</span>
                        <button className="pg-sqlbox__run" type="button" onClick={() => runConsoleSql(sqlDraft)}>
                          {pg.runBtn}
                        </button>
                      </div>
                    </div>
                  )}
                  <div className="pg-frames">
                    {tabs.map((t) => (
                      <iframe
                        key={t.key}
                        ref={t.kind === 'console' ? consoleFrameRef : undefined}
                        title={tabTitle(t, pg)}
                        className={`pg-frame${t.key === activeKey ? '' : ' is-hidden'}`}
                        src={iframeSrc(t)}
                      />
                    ))}
                  </div>
                </>
              )}
            </div>
          </div>
        </div>

        {/* 状态栏 */}
        <div className="pg-statusbar">
          <span className="pg-status__item is-accent">
            <PlugIcon />
            {pg.statusConnected}
          </span>
          <span className="pg-status__item">{pg.statusLimit}</span>
          <span className="pg-status__spacer" />
          <span className="pg-status__item is-dim">{pg.statusDemo}</span>
          <a className="pg-status__item" href={site.urls.repo} target="_blank" rel="noreferrer">
            GitHub
          </a>
          <span className="pg-status__item">{site.version}</span>
        </div>
      </div>
    </div>
  );
}

function Welcome({
  onOpen,
  onConsole,
  onEr,
}: {
  onOpen: (db: string, o: ObjectInfo) => void;
  onConsole: () => void;
  onEr: () => void;
}) {
  const pg = getSiteContent(useSiteLang()).playground;
  return (
    <div className="pg-welcome">
      <img src={withBase('assets/favicon.svg')} alt="" width={56} height={56} />
      <h2>{pg.welcomeTitle}</h2>
      <p>
        {pg.welcomeBody}
        <br />
        {pg.welcomeBody2}
      </p>
      <div className="pg-welcome__quick">
        {QUICK_OPEN.map((q, i) => {
          // 展示文案按 下标 与词典 quickOpen 配对（跳转目标在本数组）
          const item = pg.quickOpen[i];
          return (
            <button
              key={`${q.db}/${q.obj}`}
              type="button"
              onClick={() => onOpen(q.db, { name: q.obj, kind: 'table' })}
            >
              <strong>{item.name}</strong>
              <span>{item.desc}</span>
            </button>
          );
        })}
        <button type="button" onClick={onConsole}>
          <strong>{pg.cardConsoleTitle}</strong>
          <span>{pg.cardConsoleDesc}</span>
        </button>
        <button type="button" onClick={onEr}>
          <strong>{pg.cardErDesc}</strong>
          <span>{pg.cardErHint}</span>
        </button>
      </div>
      <p className="pg-welcome__hint">{pg.hint}</p>
    </div>
  );
}

function TabIcon({ tab }: { tab: Tab }) {
  if (tab.kind === 'console') return <TerminalIcon />;
  if (tab.kind === 'er') return <ErIcon />;
  if (tab.kind === 'design') return <DesignIcon />;
  return tab.objKind === 'view' ? <ViewIcon /> : <TableIcon />;
}

function fmtCount(n: number): string {
  return n >= 10000 ? `${Math.round(n / 1000)}k` : String(n);
}

/* ── 内联 SVG 图标（VSCode codicon 风格简化版）── */

function ChevronIcon() {
  return (
    <svg className="pg-chevron" width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M6 4l4 4-4 4" stroke="currentColor" strokeWidth="1.4" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function DbIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <ellipse cx="12" cy="5.5" rx="7" ry="2.8" />
      <path d="M5 5.5v13c0 1.55 3.13 2.8 7 2.8s7-1.25 7-2.8v-13" />
      <path d="M5 12c0 1.55 3.13 2.8 7 2.8s7-1.25 7-2.8" />
    </svg>
  );
}

function DbGlyphIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <ellipse cx="12" cy="6" rx="7" ry="2.6" />
      <path d="M5 6v12c0 1.45 3.13 2.6 7 2.6s7-1.15 7-2.6V6" />
      <path d="M5 12c0 1.45 3.13 2.6 7 2.6s7-1.15 7-2.6" />
    </svg>
  );
}

function TableIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <rect x="3.5" y="4.5" width="17" height="15" rx="1.5" />
      <path d="M3.5 9.5h17M9.5 9.5v10" />
    </svg>
  );
}

function ViewIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path d="M2.5 12S6 5.8 12 5.8 21.5 12 21.5 12 18 18.2 12 18.2 2.5 12 2.5 12Z" />
      <circle cx="12" cy="12" r="2.8" />
    </svg>
  );
}

function PlugIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M9 3v5M15 3v5M7 8h10v3a5 5 0 0 1-5 5 5 5 0 0 1-5-5V8ZM12 16v5" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <circle cx="10.5" cy="10.5" r="6" />
      <path d="M15.5 15.5 21 21" />
    </svg>
  );
}

function GearIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
      <circle cx="12" cy="12" r="3.2" />
      <path d="M12 2.8v3M12 18.2v3M4.05 7.4l2.6 1.5M17.35 15.1l2.6 1.5M4.05 16.6l2.6-1.5M17.35 8.9l2.6-1.5" />
    </svg>
  );
}

function ResetIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M3.5 12a8.5 8.5 0 1 0 2.5-6L3.5 8.5" />
      <path d="M3.5 3.5v5h5" />
    </svg>
  );
}

function TerminalIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <rect x="3" y="4.5" width="18" height="15" rx="2" />
      <path d="m7 9 3.5 3L7 15M12.5 15H17" />
    </svg>
  );
}

function ErIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <rect x="3" y="3.5" width="7" height="6" rx="1" />
      <rect x="14" y="14.5" width="7" height="6" rx="1" />
      <path d="M6.5 9.5v5a3 3 0 0 0 3 3H14" />
    </svg>
  );
}

function DesignIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path d="m14.5 5.5 4 4L8 20l-4.6 1L4.5 16.4 15 5.9Z" />
      <path d="m12.5 7.5 4 4" />
    </svg>
  );
}
