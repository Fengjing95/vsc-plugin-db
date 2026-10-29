import type { ReactElement } from 'react';
import { t } from './lib/i18n';
import { ConnectionFormPage } from './pages/ConnectionFormPage';
import { SettingsPage } from './pages/SettingsPage';
import { DatabaseDesignPage } from './pages/DatabaseDesignPage';
import { ConsolePage } from './pages/ConsolePage';
import { ErDiagramPage } from './pages/ErDiagramPage';
import { SchemaComparePage } from './pages/SchemaComparePage';
import { TableDesignPage } from './pages/TableDesignPage';
import { TablePage } from './pages/TablePage';

/**
 * Webview 页面路由：单入口多页面（bootstrap.page 决定）。
 * 表格页为 TanStack Table + shadcn/ui 只读视图（M3）；
 * Console 结果面板为多结果 Tab 只读视图（M5，D-02）；
 * 表结构编辑器为独立页面（M8-B2，概要 §5.9）。
 */
export default function App() {
  const boot = window.__BOOTSTRAP__;
  if (!boot) {
    return <div className="status error">{t('console.bootstrapMissing')}</div>;
  }
  let page: ReactElement;
  if (boot.page === 'connectionForm') {
    page = <ConnectionFormPage connId={boot.params.connId || null} />;
  } else if (boot.page === 'console') {
    // 底部面板单例视图：consoleId 引导为空串，由 Host 解析「最近执行的 Console」并回填
    page = <ConsolePage consoleId={boot.params.consoleId ?? ''} />;
  } else if (boot.page === 'tableDesign') {
    page = <TableDesignPage />;
  } else if (boot.page === 'databaseDesign') {
    // 库级 DDL 弹窗（M8-DBDDL / D-19）：新建/编辑库共用，kind 决定预填与提交形态
    page = <DatabaseDesignPage />;
  } else if (boot.page === 'erDiagram') {
    // ER 图（M8-ER / D-22）：scope 由打开引导决定（all / selection JSON）
    page = <ErDiagramPage />;
  } else if (boot.page === 'schemaCompare') {
    // 表结构对比（ADR D-29 / 交互稿 §17）：dbA/dbB 由树命令 QuickPick 选定
    page = <SchemaComparePage />;
  } else if (boot.page === 'settings') {
    // 设置中心（交互稿 §16）：分类侧栏 + 内容区（AI 辅助 / 查询与导出 / 关于）
    page = <SettingsPage />;
  } else if (boot.params.db && boot.params.obj && boot.params.connId) {
    const rowEstimate = boot.params.rowEstimate !== '' ? Number(boot.params.rowEstimate) : undefined;
    page = (
      <TablePage
        connId={boot.params.connId}
        db={boot.params.db}
        obj={boot.params.obj}
        rowEstimate={Number.isFinite(rowEstimate) ? rowEstimate : undefined}
        readOnly={boot.params.readOnly === 'true'}
      />
    );
  } else {
    page = <div className="status error">{t('console.tableParamsMissing')}</div>;
  }
  return page;
}
