import { useTableStore } from '../../store/tableStore';

/** 轻提示 Toast（交互稿 §9.1：右下角，3s 自动消失；带动作时常驻） */
export function Toast() {
  const toast = useTableStore((s) => s.toast);
  const dismiss = useTableStore((s) => s.dismissToast);
  if (!toast) {
    return null;
  }
  return (
    <div
      role="status"
      className={`fixed bottom-3 right-3 z-[60] flex max-w-md items-center gap-2 rounded-sm border px-3 py-2 text-[12px] shadow-lg ${
        toast.kind === 'error'
          ? 'border-destructive/40 bg-panel text-destructive'
          : 'border-border bg-panel text-panel-foreground'
      }`}
    >
      <span className="min-w-0 break-words">{toast.text}</span>
      {toast.actions?.map((a) => (
        <button
          key={a.label}
          type="button"
          className="shrink-0 rounded-sm border border-border px-2 py-0.5 text-[12px] hover:bg-accent"
          onClick={() => {
            dismiss();
            a.onSelect();
          }}
        >
          {a.label}
        </button>
      ))}
      <button
        type="button"
        aria-label="关闭提示"
        className="shrink-0 text-muted-foreground hover:text-foreground"
        onClick={dismiss}
      >
        ✕
      </button>
    </div>
  );
}
