/**
 * Shiny Text 流光文字（效果对齐 React Bits「ShinyText」，reactbits.dev）：
 * 渐变背景裁切到文字 + background-position 循环，纯 CSS。
 */
export function ShinyText({ children, className }: { children: React.ReactNode; className?: string }) {
  return <span className={`fx-shiny ${className ?? ''}`}>{children}</span>;
}
