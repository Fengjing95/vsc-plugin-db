import { cva, type VariantProps } from 'class-variance-authority';
import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { cn } from '../../lib/utils';

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-sm text-[13px] leading-none font-normal transition-colors outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-60 [&_svg]:pointer-events-none',
  {
    variants: {
      variant: {
        primary: 'bg-primary text-primary-foreground hover:bg-primary-hover',
        secondary: 'bg-secondary text-secondary-foreground hover:bg-secondary-hover border border-border',
        ghost: 'text-foreground hover:bg-accent hover:text-accent-foreground',
        link: 'text-link underline-offset-2 hover:underline',
      },
      size: {
        sm: 'h-6 px-2',
        md: 'h-7 px-3',
        icon: 'h-6 w-6 p-0',
      },
    },
    defaultVariants: {
      variant: 'secondary',
      size: 'md',
    },
  },
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

/**
 * 必须转发 ref：Base UI Trigger 经 render prop 挂载本组件，
 * 依赖 ref 测量锚点位置（React 18 函数组件默认丢弃 ref → 弹层飘到 (0,0)）。
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant, size, type = 'button', ...props },
  ref,
) {
  return (
    <button ref={ref} type={type} className={cn(buttonVariants({ variant, size }), className)} {...props} />
  );
});

export { buttonVariants };
