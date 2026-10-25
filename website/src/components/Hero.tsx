import { Suspense, lazy } from 'react';
import { CopyCommand } from './CopyCommand';
import { engines, getSiteContent, site } from '../content/site';
import { useSiteLang } from '../i18n/lang';
import { Reveal } from './Reveal';
import { Aurora } from './fx/Aurora';
import { SplitText } from './fx/SplitText';
import { ShinyText } from './fx/ShinyText';
import { CountUp } from './fx/CountUp';

// Playground 保持独立 chunk：驱动/协议代码不进首包，挂载后即刻加载
const PlaygroundEmbed = lazy(() =>
  import('../playground/PlaygroundEmbed').then((m) => ({ default: m.PlaygroundEmbed })),
);

// 数字口径 = README（六类数据源 / 单次传输上限 5000 行 / 开源仓库）；后缀文案在词典 c.ui.hero.stats
const HERO_STAT_VALUES = [engines.length, 5000, 100];

export function Hero() {
  const lang = useSiteLang();
  const c = getSiteContent(lang);

  return (
    <section className="hero" id="top">
      <Aurora />
      <div className="container hero__inner">
        <Reveal>
          <p className="hero__badge">
            <span className="hero__badge-dot" aria-hidden="true" />
            {c.ui.hero.badge} {site.version}
          </p>
        </Reveal>
        <h1 className="hero__title">
          <SplitText
            startDelay={120}
            segments={[
              { text: c.ui.hero.titleBefore },
              { text: c.ui.hero.titleAfter, className: 'grad-text', unit: true },
            ]}
          />
        </h1>
        <Reveal delay={160}>
          <p className="hero__sub">{c.subTagline}</p>
        </Reveal>
        <Reveal delay={220}>
          <dl className="hero__stats" aria-label={c.ui.hero.statsAria}>
            {HERO_STAT_VALUES.map((value, i) => (
              <div key={i}>
                <dd>
                  <CountUp to={value} />
                </dd>
                <dt>{c.ui.hero.stats[i]?.label}</dt>
              </div>
            ))}
          </dl>
        </Reveal>
        <Reveal delay={280}>
          <ul className="hero__engines" aria-label={c.ui.hero.enginesAria}>
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
              {c.ui.hero.installBtn}
            </a>
            <a className="btn btn--ghost" href={site.urls.releases} target="_blank" rel="noreferrer">
              {c.ui.hero.vsixBtn}
            </a>
          </div>
          <div className="hero__playground-wrap">
            <a className="hero__playground" href="#playground">
              <ShinyText>{c.ui.hero.newBadge}</ShinyText>
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
            <Suspense fallback={<div className="pg-embed-wrap hero__live-fallback">{c.ui.hero.playgroundLoading}</div>}>
              <PlaygroundEmbed />
            </Suspense>
            <figcaption className="hero__live-caption">
              {c.heroShot.desc}
              <span className="hero__live-hint">
                {c.ui.hero.figcaption}
                {c.ui.hero.figHint}
              </span>
            </figcaption>
          </figure>
        </Reveal>
      </div>
    </section>
  );
}
