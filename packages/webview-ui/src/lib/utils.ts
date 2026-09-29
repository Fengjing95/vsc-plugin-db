import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** shadcn 约定：条件类名合并（clsx + tailwind-merge 去冲突） */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
