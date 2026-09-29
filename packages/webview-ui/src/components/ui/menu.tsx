import { Menu as BaseMenu } from '@base-ui-components/react/menu';
import type { ReactElement, ReactNode } from 'react';
import { cn } from '../../lib/utils';

interface MenuItemDef {
  key: string;
  label: ReactNode;
  disabled?: boolean;
  onSelect: () => void;
}

interface MenuProps {
  trigger: ReactElement;
  items: ReadonlyArray<MenuItemDef>;
  contentClassName?: string;
  align?: 'start' | 'center' | 'end';
}

/** Base UI Menu 包装（导出菜单等动作下拉） */
export function Menu({ trigger, items, contentClassName, align = 'end' }: MenuProps) {
  return (
    <BaseMenu.Root>
      <BaseMenu.Trigger render={trigger} />
      <BaseMenu.Portal>
        <BaseMenu.Positioner align={align} sideOffset={4} className="outline-none">
          <BaseMenu.Popup
            className={cn(
              'z-50 min-w-36 rounded-sm border border-border bg-panel py-1 text-[13px] text-panel-foreground shadow-lg outline-none',
              contentClassName,
            )}
          >
            {items.map((item) => (
              <BaseMenu.Item
                key={item.key}
                disabled={item.disabled}
                onClick={item.onSelect}
                className={cn(
                  'flex cursor-default items-center px-3 py-1 outline-none',
                  'data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground',
                  'data-[disabled]:opacity-50',
                )}
              >
                {item.label}
              </BaseMenu.Item>
            ))}
          </BaseMenu.Popup>
        </BaseMenu.Positioner>
      </BaseMenu.Portal>
    </BaseMenu.Root>
  );
}
