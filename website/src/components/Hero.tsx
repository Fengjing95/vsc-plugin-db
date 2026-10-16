import { Suspense, lazy } from 'react';
import { CopyCommand } from './CopyCommand';
import { engines, heroShot, site } from '../content/site';
import { Reveal } from './Reveal';
import { Aurora } from './fx/Aurora';
import { SplitText } from './fx/SplitText';
import { ShinyText } from './fx/ShinyText';
import { CountUp } from './fx/CountUp';

// Playground 保持独立 chunk：驱动/协议代码不进首包，挂载后即刻加载
const PlaygroundEmbed = lazy(() =>
  import('../playground/PlaygroundEmbed').then((m) => ({ default: m.PlaygroundEmbed })),
);

// 数字口径 = README（六类数据源 / 单次传输上限 5000 行 / 开源仓库）
const HERO_STATS = [
  { value: engines.length, label: '类数据源统一入口' },
  { value: 5000, label: '行 · 单次传输上限' },
  { value: 100, label: '% 开源（GitHub）' },
];

export function Hero() {
  return (
    <section className="hero" id="top">
      <Aurora />
      <div className="container hero__inner">
        <Reveal>
          <p className="hero__badge">
            <span className="hero__badge-dot" aria-hidden="true" />
            开源 · 已上架 VSCode Marketplace · {site.version}
          </p>
        </Reveal>
        <h1 className="hero__title">
          <SplitText
            startDelay={120}
            segments={[
              { text: '在 VSCode 里，' },
              { text: '搞定数据库的一切', className: 'grad-text', unit: true },
            ]}
          />
        </h1>
        <Reveal delay={160}>
          <p className="hero__sub">{site.subTagline}</p>
        </Reveal>
        <Reveal delay={220}>
          <dl className="hero__stats" aria-label="关键数字">
            {HERO_STATS.map((s) => (
              <div key={s.label}>
                <dd>
                  <CountUp to={s.value} />
                </dd>
                <dt>{s.label}</dt>
              </div>
            ))}
          </dl>
        </Reveal>
        <Reveal delay={280}>
          <ul className="hero__engines" aria-label="支持的数据源">
            {engines.map((e) => (
              <li key={e.key}>
                <img src={e.logo} alt="" width={16} height={16} />
                {e.name}
              </li>
            ))}
          </ul>
        </Reveal>
        <Reveal delay={340}>
          <div className="hero__cta">
            <a className="btn btn--primary" href={site.urls.marketplace} target="_blank" rel="noreferrer">
              安装 DB Kit
            </a>
            <a className="btn btn--ghost" href={site.urls.releases} target="_blank" rel="noreferrer">
              下载 VSIX
            </a>
          </div>
          <div className="hero__playground-wrap">
            <a className="hero__playground" href="#playground">
              <ShinyText>✨ 新：在线 Playground — 浏览器里直接玩</ShinyText>
              <span className="arrow" aria-hidden="true">
                →
              </span>
            </a>
          </div>
          <div className="hero__cmd">
            <CopyCommand command={site.installCommand} />
          </div>
        </Reveal>
        <Reveal delay={400} className="hero__shot-wrap">
          {/* 首页主视觉 = 浏览器内真实运行的插件（Mock 数据），替代静态截图 */}
          <figure className="hero__live" id="playground">
            <Suspense fallback={<div className="pg-embed-wrap hero__live-fallback">Playground 加载中…</div>}>
              <PlaygroundEmbed />
            </Suspense>
            <figcaption className="hero__live-caption">
              {heroShot.desc}
              <span className="hero__live-hint">
                上面是活的：单击左侧表名打开表格 · 双击单元格直改 · 工具栏提交前可预览 SQL —— 全部在浏览器内完成，无需安装
              </span>
            </figcaption>
          </figure>
        </Reveal>
      </div>
    </section>
  );
}
