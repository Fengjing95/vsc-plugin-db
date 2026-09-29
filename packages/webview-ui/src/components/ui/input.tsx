import { forwardRef, type InputHTMLAttributes } from 'react';
import { cn } from '../../lib/utils';

/** forwardRef 保持与 Base UI render prop 生态兼容 */
export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...props }, ref) {
    return (
      <input
        ref={ref}
        className={cn(
          'h-7 w-full rounded-sm border border-input-border bg-input-bg px-2 text-[13px] text-input-fg outline-none',
          'placeholder:text-placeholder focus-visible:border-ring',
          className,
        )}
        {...props}
      />
    );
  },
);
