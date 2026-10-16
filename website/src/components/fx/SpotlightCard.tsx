import type { MouseEvent, ReactNode } from 'react';

/**
 * Spotlight Card 聚光卡片（效果对齐 React Bits「SpotlightCard」，reactbits.dev）：
 * 鼠标位置写入 CSS 变量，内层光晕 + 边框描光双伪元素跟随；无 JS 动画循环。
 */
export function SpotlightCard({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  const onMouseMove = (e: MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    e.currentTarget.style.setProperty('--sx', `${e.clientX - rect.left}px`);
    e.currentTarget.style.setProperty('--sy', `${e.clientY - rect.top}px`);
  };
  return (
    <div className={`fx-spot ${className ?? ''}`} onMouseMove={onMouseMove}>
      {children}
    </div>
  );
}
