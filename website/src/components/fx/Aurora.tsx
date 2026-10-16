import { useEffect, useRef } from 'react';

/**
 * Aurora 极光背景（效果对齐 React Bits「Aurora」，reactbits.dev）：
 * 品牌蓝系渐变光斑 + 慢速漂移，纯 CSS 零依赖。
 *
 * 性能约束（实测教训）：不要给光斑层加 feTurbulence/feDisplacementMap 滤镜——
 * 子元素 transform 动画会让父层滤镜逐帧重新光栅化，大面积湍流 ×60fps 直接拖垮整页。
 * 纯径向渐变 + 合成器 transform 动画即可达到近似观感；离屏时暂停动画。
 */
export function Aurora() {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => {
      el.classList.toggle('is-paused', !entries.some((e) => e.isIntersecting));
    });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <div ref={ref} className="fx-aurora" aria-hidden="true">
      <div className="fx-aurora__layer">
        <i className="fx-aurora__blob fx-aurora__blob--a" />
        <i className="fx-aurora__blob fx-aurora__blob--b" />
        <i className="fx-aurora__blob fx-aurora__blob--c" />
      </div>
      <div className="fx-aurora__fade" />
    </div>
  );
}
