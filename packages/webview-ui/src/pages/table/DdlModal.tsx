import { Button } from '../../components/ui/button';
import { Dialog } from '../../components/ui/dialog';
import { useTableStore } from '../../store/tableStore';

/**
 * 表 DDL 查看 Modal（工具栏 DDL 入口，概要设计 §5.3 对齐树视图 viewDdl）：
 * 只读等宽展示 + 复制；驱动未实现 getDdl 时经 toast 报 E_UNSUPPORTED，不弹窗。
 */
export function DdlModal() {
  const ddl = useTableStore((s) => s.ddl);
  const ddlLoading = useTableStore((s) => s.ddlLoading);
  const closeDdl = useTableStore((s) => s.closeDdl);
  const db = useTableStore((s) => s.db);
  const obj = useTableStore((s) => s.obj);

  return (
    <Dialog
      open={ddl !== null || ddlLoading}
      onOpenChange={(open) => {
        if (!open) {
          closeDdl();
        }
      }}
      title={
        <span>
          DDL<span className="font-normal text-muted-foreground"> · {db}.{obj}</span>
        </span>
      }
      contentClassName="w-[min(860px,92vw)]"
      footer={
        <>
          <Button
            variant="secondary"
            size="md"
            disabled={ddl === null}
            onClick={() => void navigator.clipboard.writeText(ddl ?? '')}
          >
            复制
          </Button>
          <Button variant="secondary" size="md" onClick={closeDdl}>
            关闭
          </Button>
        </>
      }
    >
      {ddlLoading || ddl === null ? (
        <div className="flex h-32 items-center justify-center text-[12px] text-muted-foreground">加载中…</div>
      ) : (
        <pre className="h-full max-h-[60vh] overflow-auto border-t border-border bg-background px-4 py-3 font-mono text-[12px] leading-relaxed whitespace-pre-wrap break-all">
          {ddl}
        </pre>
      )}
    </Dialog>
  );
}
