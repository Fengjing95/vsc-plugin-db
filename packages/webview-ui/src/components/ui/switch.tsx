import { Switch as BaseSwitch } from '@base-ui-components/react/switch';
import { cn } from '../../lib/utils';

interface SwitchProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  /** 无可见标签时必填（读屏名称） */
  'aria-label'?: string;
  'aria-describedby'?: string;
  className?: string;
}

/** Base UI Switch 包装（M8 表单：control='switch' 的布尔字段用）：
 *  轨道/滑块全部语义 token（C-12），data-checked 驱动滑块位移 */
export function Switch({ checked, onCheckedChange, className, ...aria }: SwitchProps) {
  return (
    <BaseSwitch.Root
      checked={checked}
      onCheckedChange={(c: unknown) => onCheckedChange(c === true)}
      className={cn(
        'group relative inline-flex h-[18px] w-8 shrink-0 items-center rounded-full border border-input-border bg-input-bg transition-colors outline-none',
        'focus-visible:ring-1 focus-visible:ring-ring data-[checked]:border-primary data-[checked]:bg-primary',
        className,
      )}
      {...aria}
    >
      <BaseSwitch.Thumb
        className={cn(
          'block h-3 w-3 rounded-full bg-primary-foreground transition-transform',
          '-translate-x-1/2 absolute left-1/2 top-1/2 -translate-y-1/2',
          'group-data-[checked]:translate-x-[calc(-50%+7px)]',
        )}
      />
    </BaseSwitch.Root>
  );
}
