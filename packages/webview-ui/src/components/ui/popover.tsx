import { Popover as BasePopover } from '@base-ui-components/react/popover';
import type { ReactElement, ReactNode } from 'react';
import { cn } from '../../lib/utils';

interface PopoverProps {
  /** 必须是单个元素（Base UI Trigger 经 render prop 挂载交互） */
  trigger: ReactElement;
  children: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  contentClassName?: string;
  align?: 'start' | 'center' | 'end';
}

/** Base UI Popover 包装（列设置、筛选构造器等弹层） */
export function Popover({ trigger, children, open, onOpenChange, contentClassName, align = 'start' }: PopoverProps) {
  return (
    <BasePopover.Root open={open} onOpenChange={onOpenChange}>
      <BasePopover.Trigger render={trigger} />
      <BasePopover.Portal>
        <BasePopover.Positioner align={align} sideOffset={4} className="outline-none">
          <BasePopover.Popup
            className={cn(
              'z-50 rounded-sm border border-border bg-panel text-panel-foreground shadow-lg outline-none',
              contentClassName,
            )}
          >
            {children}
          </BasePopover.Popup>
        </BasePopover.Positioner>
      </BasePopover.Portal>
    </BasePopover.Root>
  );
}
