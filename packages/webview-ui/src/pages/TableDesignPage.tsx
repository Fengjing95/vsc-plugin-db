import { useEffect, useRef } from 'react';
import { Button } from '../components/ui/button';
import { highlightSql } from '../lib/sqlHighlight';
import { destructiveCount } from '../lib/tableDesign';
import { columnErrorOf, useTableDesignStore } from '../store/tableDesignStore';

/**
 * 表结构编辑器（M8-B2，交互稿 §12）：新建表与修改表结构共用。
 * 列网格行内编辑 + 表选项 + SQL 预览 Modal（destructive 红条）+ 危险确认（Host）。
 */
export function TableDesignPage() {
  const phase = useTableDesignStore((s) => s.phase);
  const errorMsg = useTableDesignStore((s) => s.errorMsg);
  const kind = useTableDesignStore((s) => s.kind);
  const db = useTableDesignStore((s) => s.db);
  const obj = useTableDesignStore((s) => s.obj);
  const readOnly = useTableDesignStore((s) => s.readOnly);
  const tableName = useTableDesignStore((s) => s.tableName);
  const tableComment = useTableDesignStore((s) => s.tableComment);
  const rows = useTableDesignStore((s) => s.rows);
  const executing = useTableDesignStore((s) => s.executing);
  const preview = useTableDesignStore((s) => s.preview);
  const executeError = useTableDesignStore((s) => s.executeError);
  const toast = useTableDesignStore((s) => s.toast);
  const dirty = useTableDesignStore((s) => s.dirty);

  const setTableName = useTableDesignStore((s) => s.setTableName);
  const setTableComment = useTableDesignStore((s) => s.setTableComment);
  const editColumn = useTableDesignStore((s) => s.editColumn);
  const addColumn = useTableDesignStore((s) => s.addColumn);
  const removeColumn = useTableDesignStore((s) => s.removeColumn);
  const restoreColumn = useTableDesignStore((s) => s.restoreColumn);
  const showPreview = useTableDesignStore((s) => s.showPreview);
  const hidePreview = useTableDesignStore((s) => s.hidePreview);
  const execute = useTableDesignStore((s) => s.execute);
  const closePanel = useTableDesignStore((s) => s.closePanel);
  const dismissToast = useTableDesignStore((s) => s.dismissToast);
  const diffText = useTableDesignStore((s) => s.diffText);
  const canExecute = useTableDesignStore((s) => s.canExecute);
  const validationError = useTableDesignStore((s) => s.validationError);
  const focusRowId = useTableDesignStore((s) => s.focusRowId);
  const clearFocus = useTableDesignStore((s) => s.clearFocus);
  const nameInputRefs = useRef(new Map<string, HTMLInputElement>());

  useEffect(() => {
    void useTableDesignStore.getState().bootstrap();
  }, []);

  // §12 修订：编辑列/新增列入口打开时聚焦到指定列的列名输入框（滚动可见），聚焦后清除状态
  useEffect(() => {
    if (!focusRowId) {
      return;
    }
    const input = nameInputRefs.current.get(focusRowId);
    if (input) {
      input.scrollIntoView({ block: 'center' });
      input.focus();
      input.select();
      clearFocus();
    }
  }, [focusRowId, rows, clearFocus]);

  if (phase === 'loading') {
    return <div className="flex h-screen items-center justify-center text-muted-foreground">加载中…</div>;
  }
  if (phase === 'error') {
    return <div className="flex h-screen items-center justify-center text-destructive">{errorMsg}</div>;
  }

  const formWrap = 'mx-auto flex h-full max-w-5xl flex-col gap-3 px-6 py-4';

  return (
    <div className="h-screen overflow-hidden bg-background text-panel-foreground">
      <div className={formWrap}>
        {/* 标题行 */}
        <div className="flex shrink-0 items-center gap-2 text-[15px] font-medium">
          {kind === 'create' ? '新建表' : '修改表结构'}
          <span className="text-[12px] text-muted-foreground">@ {db}{obj ? ` · ${obj}` : ''}</span>
          {readOnly && <span className="rounded-sm bg-muted px-1.5 text-[11px] text-muted-foreground">只读连接，执行被拒绝</span>}
          {dirty && <span className="text-[11px] text-warning">未保存</span>}
        </div>

        {/* 表选项（§12.1） */}
        <div className="flex shrink-0 items-center gap-4">
          <label className="flex items-center gap-2 text-[12px]">
            <span className="text-muted-foreground">表名<span className="text-destructive">*</span></span>
            <input
              aria-label="表名"
              className="h-7 w-52 rounded-sm border border-border bg-input px-2 text-[13px]"
              value={tableName}
              disabled={executing}
              onChange={(e) => setTableName(e.target.value)}
            />
          </label>
          <label className="flex min-w-0 flex-1 items-center gap-2 text-[12px]">
            <span className="shrink-0 text-muted-foreground">注释</span>
            <input
              aria-label="表注释"
              className="h-7 w-full rounded-sm border border-border bg-input px-2 text-[13px]"
              value={tableComment}
              disabled={executing}
              onChange={(e) => setTableComment(e.target.value)}
            />
          </label>
        </div>

        {/* 列网格（§12.1） */}
        <div className="min-h-0 flex-1 overflow-auto rounded-sm border border-border">
          <table className="w-full text-[13px]">
            <thead className="sticky top-0 bg-panel text-left text-[12px] text-muted-foreground">
              <tr>
                <th className="w-8 px-2 py-1.5 font-normal">#</th>
                <th className="px-2 py-1.5 font-normal">列名</th>
                <th className="px-2 py-1.5 font-normal">类型</th>
                <th className="w-24 px-2 py-1.5 font-normal">NULL</th>
                <th className="w-16 px-2 py-1.5 font-normal">主键</th>
                <th className="w-16 px-2 py-1.5 font-normal">自增</th>
                <th className="px-2 py-1.5 font-normal">默认值</th>
                <th className="px-2 py-1.5 font-normal">注释</th>
                <th className="w-10 px-2 py-1.5 font-normal"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const err = columnErrorOf(r, rows);
                return (
                  <tr
                    key={r.rowId}
                    data-row={r.rowId}
                    className={`border-t border-border ${r.deleted ? 'bg-destructive/10 opacity-60' : ''}`}
                  >
                    <td className="px-2 py-1 text-muted-foreground">{i + 1}</td>
                    <td className="px-2 py-1">
                      <input
                        ref={(el) => {
                          if (el) {
                            nameInputRefs.current.set(r.rowId, el);
                          } else {
                            nameInputRefs.current.delete(r.rowId);
                          }
                        }}
                        aria-label={`列名 ${i + 1}`}
                        className={`h-6 w-full rounded-sm border bg-input px-1.5 ${err ? 'border-destructive' : 'border-transparent'}`}
                        value={r.col.name}
                        disabled={executing || r.deleted}
                        onChange={(e) => editColumn(r.rowId, { name: e.target.value })}
                      />
                      {err && <div className="text-[11px] text-destructive">{err}</div>}
                    </td>
                    <td className="px-2 py-1">
                      <input
                        aria-label={`类型 ${i + 1}`}
                        placeholder="varchar(64)"
                        className="h-6 w-full rounded-sm border border-transparent bg-input px-1.5"
                        value={r.col.dataType}
                        disabled={executing || r.deleted}
                        onChange={(e) => editColumn(r.rowId, { dataType: e.target.value })}
                      />
                    </td>
                    <td className="px-2 py-1">
                      <select
                        aria-label={`NULL ${i + 1}`}
                        className="h-6 w-full rounded-sm border border-transparent bg-input px-1"
                        value={r.col.nullable ? 'null' : 'notnull'}
                        disabled={executing || r.deleted}
                        onChange={(e) => editColumn(r.rowId, { nullable: e.target.value === 'null' })}
                      >
                        <option value="null">NULL</option>
                        <option value="notnull">NOT NULL</option>
                      </select>
                    </td>
                    <td className="px-2 py-1 text-center">
                      <input
                        type="checkbox"
                        aria-label={`主键 ${i + 1}`}
                        checked={r.col.isPrimaryKey}
                        disabled={executing || r.deleted}
                        onChange={(e) => editColumn(r.rowId, { isPrimaryKey: e.target.checked })}
                      />
                    </td>
                    <td className="px-2 py-1 text-center">
                      <input
                        type="checkbox"
                        aria-label={`自增 ${i + 1}`}
                        checked={Boolean(r.col.autoIncrement)}
                        disabled={executing || r.deleted}
                        onChange={(e) => editColumn(r.rowId, { autoIncrement: e.target.checked })}
                      />
                    </td>
                    <td className="px-2 py-1">
                      <input
                        aria-label={`默认值 ${i + 1}`}
                        placeholder="无"
                        className="h-6 w-full rounded-sm border border-transparent bg-input px-1.5"
                        value={r.col.defaultValue ?? ''}
                        disabled={executing || r.deleted}
                        onChange={(e) => editColumn(r.rowId, { defaultValue: e.target.value })}
                      />
                    </td>
                    <td className="px-2 py-1">
                      <input
                        aria-label={`注释 ${i + 1}`}
                        className="h-6 w-full rounded-sm border border-transparent bg-input px-1.5"
                        value={r.col.comment ?? ''}
                        disabled={executing || r.deleted}
                        onChange={(e) => editColumn(r.rowId, { comment: e.target.value })}
                      />
                    </td>
                    <td className="px-2 py-1 text-center">
                      {r.deleted ? (
                        <button
                          type="button"
                          aria-label={`撤销删除列 ${i + 1}`}
                          title="撤销删除"
                          className="rounded-sm px-1 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                          onClick={() => restoreColumn(r.rowId)}
                        >
                          ↺
                        </button>
                      ) : (
                        <button
                          type="button"
                          aria-label={`删除列 ${i + 1}`}
                          title="删除该列"
                          disabled={executing}
                          className="rounded-sm px-1 text-muted-foreground hover:bg-accent hover:text-destructive disabled:opacity-50"
                          onClick={() => removeColumn(r.rowId)}
                        >
                          ✕
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* 变更统计 + 底部操作（§12.1/§12.2） */}
        <div className="flex shrink-0 items-center gap-3">
          <Button variant="secondary" size="sm" disabled={executing} onClick={() => addColumn()}>
            ＋添加列
          </Button>
          <span className="text-[12px] text-muted-foreground">{diffText()}</span>
          {validationError() && <span className="text-[12px] text-destructive">{validationError()}</span>}
          <div className="ml-auto flex items-center gap-2">
            <span className="text-[12px] text-muted-foreground">
              {executeError
                ? `第 ${executeError.index} 条语句失败（${executeError.code}），已执行部分不回滚`
                : 'ⓘ 语句由驱动按方言生成，执行前可预览'}
            </span>
            <Button variant="secondary" size="sm" disabled={executing || !canExecute()} onClick={() => void showPreview()}>
              SQL 预览
            </Button>
            <Button size="sm" disabled={executing || !canExecute()} onClick={() => void execute()}>
              {executing ? '执行中…' : '执行'}
            </Button>
            <Button variant="secondary" size="sm" onClick={() => void closePanel()}>
              取消
            </Button>
          </div>
        </div>
      </div>

      {/* SQL 预览 Modal（§5 样式：逐条折叠 + destructive 红条汇总） */}
      {preview && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6" role="dialog" aria-label="SQL 预览">
          <div className="flex max-h-[80vh] w-full max-w-2xl flex-col gap-3 rounded-md border border-border bg-panel p-4 shadow-lg">
            <div className="flex items-center gap-2 text-[14px] font-medium">
              SQL 预览（{preview.statements.length} 条语句）
            </div>
            {destructiveCount(preview.statements) > 0 && (
              <div className="rounded-sm border border-destructive/40 bg-destructive/10 px-3 py-2 text-[12px] text-destructive">
                ⚠ {destructiveCount(preview.statements)} 条语句可能造成数据丢失，请逐条确认
              </div>
            )}
            <div className="min-h-0 flex-1 overflow-auto font-mono text-[12px] leading-5">
              {preview.statements.map((s, i) => (
                <div key={i} className="mb-3">
                  <div
                    className={`whitespace-pre-wrap break-all rounded-sm px-2 py-1.5 ${s.destructive ? 'bg-destructive/10 text-destructive' : 'bg-input/40'}`}
                    dangerouslySetInnerHTML={{ __html: highlightSql(s.sql) }}
                  />
                </div>
              ))}
            </div>
            <div className="flex shrink-0 justify-end gap-2">
              <Button variant="secondary" size="sm" onClick={hidePreview}>
                返回修改
              </Button>
              <Button size="sm" disabled={executing} onClick={() => void execute()}>
                {executing ? '执行中…' : '确认执行'}
              </Button>
            </div>
          </div>
        </div>
      )}

      {toast && (
        <div
          role="status"
          className={`fixed right-3 bottom-3 z-60 max-w-md rounded-sm border px-3 py-2 text-[12px] shadow-lg ${
            toast.kind === 'error' ? 'border-destructive/40 text-destructive' : 'border-border bg-panel text-panel-foreground'
          }`}
        >
          <span className="min-w-0 break-words">{toast.text}</span>
          <button
            type="button"
            aria-label="关闭提示"
            className="ml-2 text-muted-foreground hover:text-foreground"
            onClick={dismissToast}
          >
            ✕
          </button>
        </div>
      )}
    </div>
  );
}
