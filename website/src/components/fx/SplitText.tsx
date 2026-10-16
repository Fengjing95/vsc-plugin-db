import type { CSSProperties } from 'react';

export type SplitSegment = {
  text: string;
  className?: string;
  /**
   * unit = 整段作为一个动画单元（不拆字符）。
   * background-clip:text 的渐变文字（如 .grad-text）拆字符后，字符位移会移出
   * 父元素的渐变绘制区，动画期间可能整段不可见——渐变段必须按单元动画。
   */
  unit?: boolean;
};

/**
 * Split Text 标题入场（效果对齐 React Bits「SplitText」，reactbits.dev）：
 * 字符级错峰上浮；纯 CSS animation + 递增 delay，无动画库依赖。
 * 可访问性：外层 aria-label 承载完整文本，动画字符 aria-hidden。
 */
export function SplitText({
  segments,
  className,
  stagger = 26,
  startDelay = 0,
}: {
  segments: SplitSegment[];
  className?: string;
  /** 相邻字符动画的间隔 ms */
  stagger?: number;
  /** 首字符延迟 ms */
  startDelay?: number;
}) {
  let index = 0;
  const nextDelay = () => startDelay + index++ * stagger;
  return (
    <span className={className} aria-label={segments.map((s) => s.text).join('')}>
      {segments.map((seg, si) =>
        seg.unit ? (
          <span
            key={si}
            aria-hidden="true"
            className={`fx-split__unit ${seg.className ?? ''}`}
            style={{ animationDelay: `${nextDelay()}ms` }}
          >
            {seg.text}
          </span>
        ) : (
          <span key={si} aria-hidden="true" className={seg.className}>
            {Array.from(seg.text).map((ch, ci) => (
              <span key={ci} className="fx-split__char" style={{ animationDelay: `${nextDelay()}ms` } as CSSProperties}>
                {ch}
              </span>
            ))}
          </span>
        ),
      )}
    </span>
  );
}
