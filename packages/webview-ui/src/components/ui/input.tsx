import type { InputHTMLAttributes } from 'react';
import { cn } from '../../lib/utils';

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        'h-7 w-full rounded-sm border border-input-border bg-input-bg px-2 text-[13px] text-input-fg outline-none',
        'placeholder:text-placeholder focus-visible:border-ring',
        className,
      )}
      {...props}
    />
  );
}
