import type { ReactElement } from 'react';
import { ConnectionFormPage } from './pages/ConnectionFormPage';
import { AiSettingsPage } from './pages/AiSettingsPage';
import { DatabaseDesignPage } from './pages/DatabaseDesignPage';
import { ConsolePage } from './pages/ConsolePage';
import { ErDiagramPage } from './pages/ErDiagramPage';
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
    return <div className="status error">缺少引导数据（bootstrap）</div>;
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
  } else if (boot.page === 'aiSettings') {
    // AI 设置（M9-AI / D-24）：BYOK 配置单例面板
    page = <AiSettingsPage />;
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
    page = <div className="status error">缺少表格视图参数</div>;
  }
  return page;
}
