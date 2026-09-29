import type { ReactElement } from 'react';
import { ConnectionFormPage } from './pages/ConnectionFormPage';
import { TablePage } from './pages/TablePage';

/**
 * Webview 页面路由：单入口多页面（bootstrap.page 决定）。
 * M3 起表格页接入 TanStack Table + shadcn/ui。
 */
export default function App() {
  const boot = window.__BOOTSTRAP__;
  if (!boot) {
    return <div className="status error">缺少引导数据（bootstrap）</div>;
  }
  let page: ReactElement;
  if (boot.page === 'connectionForm') {
    page = <ConnectionFormPage connId={boot.params.connId || null} />;
  } else if (boot.params.db && boot.params.obj && boot.params.connId) {
    page = (
      <TablePage connId={boot.params.connId} db={boot.params.db} obj={boot.params.obj} />
    );
  } else {
    page = <div className="status error">缺少表格视图参数</div>;
  }
  return page;
}
