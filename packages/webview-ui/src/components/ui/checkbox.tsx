import { Checkbox as BaseCheckbox } from '@base-ui-components/react/checkbox';
import { cn } from '../../lib/utils';

interface CheckboxProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  label: React.ReactNode;
  className?: string;
}

/** Base UI Checkbox 包装（列设置等用）；勾选态用 ✓，不依赖图标库 */
export function Checkbox({ checked, onCheckedChange, label, className }: CheckboxProps) {
  return (
    <label className={cn('flex cursor-default items-center gap-2 px-2 py-1 text-[13px]', className)}>
      <BaseCheckbox.Root
        checked={checked}
        onCheckedChange={(c: unknown) => onCheckedChange(c === true)}
        className={cn(
          'flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-[2px] border border-input-border bg-input-bg outline-none',
          'focus-visible:ring-1 focus-visible:ring-ring data-[checked]:border-primary data-[checked]:bg-primary data-[checked]:text-primary-foreground',
        )}
      >
        <BaseCheckbox.Indicator>✓</BaseCheckbox.Indicator>
      </BaseCheckbox.Root>
      {label}
    </label>
  );
}
