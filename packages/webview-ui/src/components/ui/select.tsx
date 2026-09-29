import { Select as BaseSelect } from '@base-ui-components/react/select';
import type { ReactNode } from 'react';
import { cn } from '../../lib/utils';

export interface SelectOption<V extends string = string> {
  value: V;
  label: ReactNode;
}

interface SelectProps<V extends string = string> {
  value: V;
  onValueChange: (value: V) => void;
  options: ReadonlyArray<SelectOption<V>>;
  className?: string;
  disabled?: boolean;
  'aria-label'?: string;
}

/**
 * Base UI Select 包装（技术选型 T-07：shadcn/ui · Base UI 基座）。
 * 颜色全部走 tokens.css 语义 token（--vscode-* 映射）。
 * alignItemWithTrigger=false：弹层固定从触发器下方展开，不覆盖触发器。
 */
export function Select<V extends string = string>({
  value,
  onValueChange,
  options,
  className,
  disabled,
  'aria-label': ariaLabel,
}: SelectProps<V>) {
  const items = options.map((o) => ({ value: o.value, label: o.label }));
  return (
    <BaseSelect.Root
      items={items}
      value={value}
      onValueChange={(v: unknown) => {
        if (typeof v === 'string') {
          onValueChange(v as V);
        }
      }}
      disabled={disabled}
    >
      <BaseSelect.Trigger
        aria-label={ariaLabel}
        className={cn(
          'flex h-7 min-w-0 items-center justify-between gap-1 rounded-sm border border-input-border bg-input-bg px-2 text-[13px] text-input-fg outline-none',
          'focus-visible:border-ring data-[popup-open]:border-ring disabled:opacity-60',
          className,
        )}
      >
        <BaseSelect.Value />
        <BaseSelect.Icon className="shrink-0 text-muted-foreground">▾</BaseSelect.Icon>
      </BaseSelect.Trigger>
      <BaseSelect.Portal>
        {/* Positioner 是真正定位的元素，z-index 必须加在这里（低于它层级无效，
            会被表格 sticky 表头 z-30 遮盖） */}
        <BaseSelect.Positioner
          sideOffset={4}
          alignItemWithTrigger={false}
          align="start"
          className="z-50 outline-none"
        >
          <BaseSelect.Popup
            className={cn(
              'z-50 max-h-72 min-w-(--trigger-width) overflow-y-auto rounded-sm border border-border bg-panel py-1 text-[13px] text-panel-foreground shadow-lg',
            )}
          >
            {options.map((o) => (
              <BaseSelect.Item
                key={o.value}
                value={o.value}
                className={cn(
                  'flex cursor-default items-center justify-between gap-2 px-2 py-1 outline-none',
                  // 悬停高亮（选中项除外，避免与选中底色叠加冲突）
                  'data-[highlighted]:not-data-[selected]:bg-accent data-[highlighted]:not-data-[selected]:text-accent-foreground',
                  // 选中项：列表活动选择色对（--vscode-list-activeSelection*），对比度有保证
                  'data-[selected]:bg-selected data-[selected]:font-medium data-[selected]:text-selected-foreground',
                )}
              >
                <BaseSelect.ItemText>{o.label}</BaseSelect.ItemText>
                <BaseSelect.ItemIndicator>✓</BaseSelect.ItemIndicator>
              </BaseSelect.Item>
            ))}
          </BaseSelect.Popup>
        </BaseSelect.Positioner>
      </BaseSelect.Portal>
    </BaseSelect.Root>
  );
}
