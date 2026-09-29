import { Dialog as BaseDialog } from '@base-ui-components/react/dialog';
import type { ReactElement, ReactNode } from 'react';
import { cn } from '../../lib/utils';

interface DialogProps {
  /** 必须是单个元素（Base UI Trigger 经 render prop 挂载交互；P-1） */
  trigger?: ReactElement;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  title: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  contentClassName?: string;
}

/** Base UI Dialog 包装（变更预览等模态弹层，交互稿 §5/§6） */
export function Dialog({ trigger, open, onOpenChange, title, children, footer, contentClassName }: DialogProps) {
  return (
    <BaseDialog.Root open={open} onOpenChange={onOpenChange}>
      {trigger && <BaseDialog.Trigger render={trigger} />}
      <BaseDialog.Portal>
        <BaseDialog.Backdrop className="fixed inset-0 z-40 bg-black/40" />
        <BaseDialog.Popup
          className={cn(
            'fixed left-1/2 top-1/2 z-50 flex max-h-[85vh] w-[min(760px,92vw)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-md border border-border bg-panel text-panel-foreground shadow-2xl outline-none',
            contentClassName,
          )}
        >
          <div className="shrink-0 border-b border-border px-4 py-2.5 text-[13px] font-semibold">{title}</div>
          <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
          {footer && <div className="flex shrink-0 items-center justify-end gap-2 border-t border-border px-4 py-2.5">{footer}</div>}
        </BaseDialog.Popup>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  );
}
